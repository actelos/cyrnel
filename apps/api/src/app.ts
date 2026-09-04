import path from "node:path";
import cors from "cors";
import express from "express";
import pinoHttp from "pino-http";
import { TransformersEmbedder } from "@/infra/embedding/embedder";
import { logger } from "@/infra/logging";
import { SearchEngine } from "@/infra/search/search-engine";
import { AutoUpdater } from "@/infra/updater/auto-updater";
import { apiKeyMiddleware } from "@/middleware/auth.middleware";
import { errorMiddleware } from "@/middleware/error.middleware";
import { ipAccessMiddleware } from "@/middleware/ip-access.middleware";
import { globalRateLimiter } from "@/middleware/rate-limit.middleware";
import { approvalRouter } from "@/routes/approval.route";
import { environmentRouter } from "@/routes/environment.route";
import { logRouter } from "@/routes/log.route";
import { moduleRouter } from "@/routes/module.route";
import { processRouter } from "@/routes/process.route";
import { registryRouter } from "@/routes/registry.route";
import { serviceRouter } from "@/routes/service.route";
import { toolRouter } from "@/routes/tool.route";
import { ModuleService } from "@/services/modules.service";
import { ProcessService } from "@/services/process.service";
import { setProcessService } from "@/services/process-holder";
import { RegistriesService } from "@/services/registries.service";
import { ServicesService } from "@/services/services.service";

const DEFAULT_RECONCILE_INTERVAL_MS = 1_800_000;
const MAX_RECONCILE_INTERVAL_MS = 2_147_483_647;
const DEFAULT_AUTO_UPDATE_INTERVAL_MS = 0;
const MAX_AUTO_UPDATE_INTERVAL_MS = 2_147_483_647;
const DEFAULT_APPROVAL_TIMEOUT_MS = 300_000;
const DEFAULT_APPROVAL_RETENTION_MS = 2_592_000_000;
const RETENTION_SWEEP_INTERVAL_MS = 60 * 60 * 1000;

export class App {
  readonly express: express.Express;

  readonly moduleService: ModuleService;
  readonly processService: ProcessService;
  readonly registriesService: RegistriesService;
  readonly servicesService: ServicesService;

  private autoUpdater: AutoUpdater | null = null;
  private approvalExpiryTimer: ReturnType<typeof setInterval> | null = null;
  private approvalRetentionTimer: ReturnType<typeof setInterval> | null = null;

  constructor() {
    this.moduleService = new ModuleService(
      {
        invokeTool: (input) => this.moduleService.invoke(input),
        setState: (eid, data) => this.processService.recordState(eid, data),
        emitStdout: (eid, data) => this.processService.recordStdout(eid, data),
        emitStderr: (eid, data) => this.processService.recordStderr(eid, data),
        emitOutput: (eid, data) => this.processService.recordOutput(eid, data),
        setError: (eid, data) => this.processService.recordError(eid, data),
      },
      {
        hydrateAdapter: (adapterId) =>
          this.servicesService.hydrateAdapter(adapterId),
      },
    );

    this.servicesService = new ServicesService(
      {
        generateDefinition: (input) =>
          this.moduleService.generateDefinition(input),
        hydrateService: (adapterId, state) =>
          this.moduleService.hydrateService(adapterId, state),
        dehydrateService: (adapterId, serviceId) =>
          this.moduleService.dehydrateService(adapterId, serviceId),
        generateToolDocs: (input) => this.moduleService.generateToolDocs(input),
        rankAdapters: (kind) => this.moduleService.rankAdapters(kind),
        resolveDefaultAdapter: (kind) =>
          this.moduleService.resolveDefaultAdapter(kind),
      },
      new SearchEngine(new TransformersEmbedder()),
    );

    this.processService = new ProcessService({
      execute: (input) => this.moduleService.execute(input),
      kill: (eid) => this.moduleService.kill(eid),
    });
    setProcessService(this.processService);

    this.registriesService = new RegistriesService();

    this.express = this.createExpressApp();
  }

  async setup(): Promise<void> {
    const dataDir = process.env.CYRNEL_DATA_DIR || ".";
    await this.servicesService.initSearch();
    await this.moduleService.initialize(path.join(dataDir, "modules"));
    await this.registriesService.seedDefault();

    const interval = parseReconcileInterval(
      process.env.CYRNEL_RECONCILE_INTERVAL_MS,
    );
    this.servicesService.startSearchReconciliation(interval);
    void this.servicesService.reconcileSearchGuarded();

    const autoUpdateInterval = parseAutoUpdateInterval(
      process.env.CYRNEL_AUTO_UPDATE_INTERVAL_MS,
    );
    this.autoUpdater = new AutoUpdater({
      listTargets: async () => [
        ...(await this.moduleService.listAutoUpdateModules()),
        ...(await this.servicesService.listAutoUpdateServices()),
      ],
      updateModule: (id, constraint) =>
        this.moduleService
          .updateModule(id, constraint)
          .then((result) => result.updated),
      updateService: (id, constraint) =>
        this.servicesService.updateService(id, constraint),
    });
    this.autoUpdater.start(autoUpdateInterval);

    const approvalTimeoutMs = parseApprovalTimeout(
      process.env.CYRNEL_APPROVAL_TIMEOUT_MS,
    );
    const retentionMs = parseApprovalRetention(
      process.env.CYRNEL_APPROVAL_RETENTION_MS,
    );
    void this.processService.recoverSuspendedProcesses();
    void this.startApprovalSweeps(approvalTimeoutMs, retentionMs);
  }

  async shutdown(): Promise<void> {
    this.autoUpdater?.stop();
    this.autoUpdater = null;
    if (this.approvalExpiryTimer) {
      clearInterval(this.approvalExpiryTimer);
      this.approvalExpiryTimer = null;
    }
    if (this.approvalRetentionTimer) {
      clearInterval(this.approvalRetentionTimer);
      this.approvalRetentionTimer = null;
    }
    this.servicesService.closeSearch();
    await this.processService.shutdown();
    try {
      await this.moduleService.shutdown();
    } catch (err) {
      logger.warn(
        { event: "module-shutdown-failed", err },
        "Module service shutdown failed",
      );
    }
  }

  private async startApprovalSweeps(
    _timeoutMs: number,
    retentionMs: number,
  ): Promise<void> {
    const { sweepExpiredApprovals, sweepRetention } = await import(
      "@/services/approval.service"
    );
    void sweepExpiredApprovals().catch((err) =>
      logger.warn(
        { event: "approval-expiry-sweep-failed", err },
        "Expiry sweep failed",
      ),
    );
    if (retentionMs !== 0) {
      void sweepRetention(retentionMs).catch((err) =>
        logger.warn(
          { event: "approval-retention-sweep-failed", err },
          "Retention sweep failed",
        ),
      );
    }
    this.approvalExpiryTimer = setInterval(() => {
      void sweepExpiredApprovals().catch((err) =>
        logger.warn(
          { event: "approval-expiry-sweep-failed", err },
          "Expiry sweep failed",
        ),
      );
    }, 60_000);
    this.approvalExpiryTimer.unref?.();
    if (retentionMs !== 0) {
      this.approvalRetentionTimer = setInterval(() => {
        void sweepRetention(retentionMs).catch((err) =>
          logger.warn(
            { event: "approval-retention-sweep-failed", err },
            "Retention sweep failed",
          ),
        );
      }, RETENTION_SWEEP_INTERVAL_MS);
      this.approvalRetentionTimer.unref?.();
    }
  }

  private createExpressApp(): express.Express {
    const app = express();

    app.locals.moduleService = this.moduleService;
    app.locals.processService = this.processService;
    app.locals.registriesService = this.registriesService;
    app.locals.servicesService = this.servicesService;

    app.set("etag", false);
    app.use(
      pinoHttp({
        logger,
        genReqId: () => crypto.randomUUID(),
        customLogLevel: (_req, res, err) => {
          if (err || res.statusCode >= 500) return "error";
          if (res.statusCode >= 400) return "warn";
          return "info";
        },
        autoLogging: {
          ignore: (req) => req.url?.startsWith("/health") ?? false,
        },
      }),
    );
    app.use(cors());

    const globalLimiter = globalRateLimiter();
    if (globalLimiter) app.use(globalLimiter);

    app.use(ipAccessMiddleware);
    app.use(express.json({ limit: 1 * 1024 * 1024 }));
    app.get("/health", (_req, res) => {
      res.json({ status: "ok" });
    });
    app.use(apiKeyMiddleware);
    app.use("/modules", moduleRouter);
    app.use("/services", serviceRouter);
    app.use("/tools", toolRouter);
    app.use("/processes", processRouter);
    app.use("/approvals", approvalRouter);
    app.use("/environment", environmentRouter);
    app.use("/logs", logRouter);
    app.use("/registries", registryRouter);
    app.use(errorMiddleware);

    return app;
  }
}

function parseReconcileInterval(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_RECONCILE_INTERVAL_MS;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) {
    logger.warn(
      { event: "invalid-reconcile-interval", raw },
      "Invalid CYRNEL_RECONCILE_INTERVAL_MS; using default",
    );
    return DEFAULT_RECONCILE_INTERVAL_MS;
  }
  if (parsed === 0) {
    logger.info(
      { event: "reconcile-disabled" },
      "CYRNEL_RECONCILE_INTERVAL_MS is 0; recurring reconciliation disabled (startup sweep still runs)",
    );
    return 0;
  }
  if (parsed > MAX_RECONCILE_INTERVAL_MS) {
    logger.warn(
      {
        event: "invalid-reconcile-interval",
        raw,
        max: MAX_RECONCILE_INTERVAL_MS,
      },
      "Invalid CYRNEL_RECONCILE_INTERVAL_MS; using default",
    );
    return DEFAULT_RECONCILE_INTERVAL_MS;
  }
  return parsed;
}

function parseAutoUpdateInterval(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_AUTO_UPDATE_INTERVAL_MS;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) {
    logger.warn(
      { event: "invalid-auto-update-interval", raw },
      "Invalid CYRNEL_AUTO_UPDATE_INTERVAL_MS; using default (disabled)",
    );
    return DEFAULT_AUTO_UPDATE_INTERVAL_MS;
  }
  if (parsed === 0) {
    logger.info(
      { event: "auto-update-disabled" },
      "CYRNEL_AUTO_UPDATE_INTERVAL_MS is 0; auto-update sweep disabled",
    );
    return 0;
  }
  if (parsed > MAX_AUTO_UPDATE_INTERVAL_MS) {
    logger.warn(
      {
        event: "invalid-auto-update-interval",
        raw,
        max: MAX_AUTO_UPDATE_INTERVAL_MS,
      },
      "Invalid CYRNEL_AUTO_UPDATE_INTERVAL_MS; using default (disabled)",
    );
    return DEFAULT_AUTO_UPDATE_INTERVAL_MS;
  }
  return parsed;
}

function parseApprovalTimeout(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_APPROVAL_TIMEOUT_MS;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) {
    logger.warn(
      { event: "invalid-approval-timeout", raw },
      "0 would allow approvals created after startup to wait indefinitely; use a positive value",
    );
    return DEFAULT_APPROVAL_TIMEOUT_MS;
  }
  if (parsed > MAX_RECONCILE_INTERVAL_MS) {
    logger.warn(
      {
        event: "invalid-approval-timeout",
        raw,
        max: MAX_RECONCILE_INTERVAL_MS,
      },
      "Invalid CYRNEL_APPROVAL_TIMEOUT_MS; using default",
    );
    return DEFAULT_APPROVAL_TIMEOUT_MS;
  }
  return parsed;
}

function parseApprovalRetention(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_APPROVAL_RETENTION_MS;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) {
    logger.warn(
      { event: "invalid-approval-retention", raw },
      "Invalid CYRNEL_APPROVAL_RETENTION_MS; using default",
    );
    return DEFAULT_APPROVAL_RETENTION_MS;
  }
  if (parsed > MAX_AUTO_UPDATE_INTERVAL_MS) {
    logger.warn(
      {
        event: "invalid-approval-retention",
        raw,
        max: MAX_AUTO_UPDATE_INTERVAL_MS,
      },
      "Invalid CYRNEL_APPROVAL_RETENTION_MS; using default",
    );
    return DEFAULT_APPROVAL_RETENTION_MS;
  }
  if (parsed === 0) {
    logger.info(
      { event: "approval-retention-disabled" },
      "CYRNEL_APPROVAL_RETENTION_MS is 0; retention sweep disabled (keep forever)",
    );
    return 0;
  }
  return parsed;
}
