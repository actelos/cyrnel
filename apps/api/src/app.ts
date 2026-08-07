import path from "node:path";
import cors from "cors";
import express from "express";
import pinoHttp from "pino-http";
import { TransformersEmbedder } from "@/infra/embedding/embedder";
import { logger } from "@/infra/logging";
import { SearchEngine } from "@/infra/search/search-engine";
import { apiKeyMiddleware } from "@/middleware/auth.middleware";
import { errorMiddleware } from "@/middleware/error.middleware";
import { ipAccessMiddleware } from "@/middleware/ip-access.middleware";
import { globalRateLimiter } from "@/middleware/rate-limit.middleware";
import { environmentRouter } from "@/routes/environment.route";
import { logRouter } from "@/routes/log.route";
import { moduleRouter } from "@/routes/module.route";
import { processRouter } from "@/routes/process.route";
import { serviceRouter } from "@/routes/service.route";
import { toolRouter } from "@/routes/tool.route";
import { ModuleService } from "@/services/modules.service";
import { ProcessService } from "@/services/process.service";
import { ServicesService } from "@/services/services.service";

const DEFAULT_RECONCILE_INTERVAL_MS = 1_800_000;
const MAX_RECONCILE_INTERVAL_MS = 2_147_483_647;

export class App {
  readonly express: express.Express;

  readonly moduleService: ModuleService;
  readonly processService: ProcessService;
  readonly servicesService: ServicesService;

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
      },
      new SearchEngine(new TransformersEmbedder()),
    );

    this.processService = new ProcessService({
      execute: (input) => this.moduleService.execute(input),
      kill: (eid) => this.moduleService.kill(eid),
    });

    this.express = this.createExpressApp();
  }

  async setup(): Promise<void> {
    const dataDir = process.env.CYRNEL_DATA_DIR || ".";
    await this.servicesService.initSearch();
    await this.moduleService.initialize(path.join(dataDir, "modules"));

    const interval = parseReconcileInterval(
      process.env.CYRNEL_RECONCILE_INTERVAL_MS,
    );
    this.servicesService.startSearchReconciliation(interval);
    void this.servicesService.reconcileSearchGuarded();
  }

  async shutdown(): Promise<void> {
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

  private createExpressApp(): express.Express {
    const app = express();

    app.locals.moduleService = this.moduleService;
    app.locals.processService = this.processService;
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
    app.use("/environment", environmentRouter);
    app.use("/logs", logRouter);
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
