import type { Request, Response } from "express";

import type { ModuleService } from "@/services/modules.service";

function getModuleService(req: Request): ModuleService {
  const service = req.app.locals.moduleService as ModuleService | undefined;
  if (!service) throw new Error("ModuleService not configured in app.locals");
  return service;
}

export async function getEnvironmentDocs(
  req: Request,
  res: Response,
): Promise<void> {
  const docs = await getModuleService(req).generateEnvironmentDocs();
  res.status(200).type("text/markdown; charset=utf-8").send(docs);
}
