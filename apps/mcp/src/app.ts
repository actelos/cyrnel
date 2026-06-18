import { FastMCP } from "fastmcp";

import { environmentTools } from "@/tools/environment.js";
import { moduleTools } from "@/tools/module.js";
import { processTools } from "@/tools/process.js";
import { serviceTools } from "@/tools/service.js";
import { toolTools } from "@/tools/tool.js";

export type Transport =
  | { type: "stdio" }
  | { type: "http"; host: string; port: number };

export class App {
  readonly server: FastMCP;

  constructor() {
    this.server = new FastMCP({ name: "cyrnel", version: "1.0.0" });

    this.server.addTools([
      ...environmentTools,
      ...processTools,
      ...serviceTools,
      ...toolTools,
      ...moduleTools,
    ]);
  }

  async start(transport: Transport): Promise<void> {
    if (transport.type === "stdio") {
      await this.server.start({ transportType: "stdio" });
      return;
    }

    await this.server.start({
      transportType: "httpStream",
      httpStream: { host: transport.host, port: transport.port },
    });
  }

  async shutdown(): Promise<void> {
    await this.server.stop();
  }
}
