import path from "node:path";
import cors from "cors";
import express from "express";
import pinoHttp from "pino-http";

import { logger } from "@/logger";
import { apiKeyMiddleware } from "@/middleware/auth.middleware";
import { errorMiddleware } from "@/middleware/error.middleware";
import { environmentRouter } from "@/routes/environment.route";
import { moduleRouter } from "@/routes/module.route";
import { processRouter } from "@/routes/process.route";
import { serviceRouter } from "@/routes/service.route";
import { toolRouter } from "@/routes/tool.route";
import { ModuleService } from "@/services/modules.service";
import { ProcessService } from "@/services/process.service";
import { ServicesService } from "@/services/services.service";

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

    this.servicesService = new ServicesService({
      generateDefinition: (input) =>
        this.moduleService.generateDefinition(input),
      hydrateService: (adapterId, state) =>
        this.moduleService.hydrateService(adapterId, state),
      dehydrateService: (adapterId, serviceId) =>
        this.moduleService.dehydrateService(adapterId, serviceId),
      generateToolDocs: (input) => this.moduleService.generateToolDocs(input),
    });

    this.processService = new ProcessService({
      execute: (input) => this.moduleService.execute(input),
      kill: (eid) => this.moduleService.kill(eid),
    });

    this.express = this.createExpressApp();
  }

  async setup(): Promise<void> {
    const dataDir = process.env.CYRNEL_DATA_DIR || ".";
    await this.moduleService.initialize(path.join(dataDir, "modules"));
  }

  async shutdown(): Promise<void> {
    await this.processService.shutdown();
    try {
      await this.moduleService.shutdown();
    } catch (err) {
      logger.warn({ err }, "Module service shutdown failed");
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
        redact: {
          paths: [
            "req.headers.authorization",
            "req.headers.cookie",
            'req.headers["set-cookie"]',
          ],
          censor: "***REDACTED***",
        },
      }),
    );
    app.use(cors());
    app.use(express.json({ limit: 100 * 1024 }));
    app.get("/health", (_req, res) => {
      res.json({ status: "ok" });
    });
    app.use(apiKeyMiddleware);
    app.use("/modules", moduleRouter);
    app.use("/services", serviceRouter);
    app.use("/tools", toolRouter);
    app.use("/processes", processRouter);
    app.use("/environment", environmentRouter);
    app.use(errorMiddleware);

    return app;
  }
}
