import { FastMCP } from "fastmcp";

import { environmentDocsResource } from "@/resources/environment";
import { toolDocsResourceTemplate } from "@/resources/tool";
import { moduleTools } from "@/tools/module";
import { processTools } from "@/tools/process";
import { serviceTools } from "@/tools/service";
import { toolTools } from "@/tools/tool";

export type Transport =
  | { type: "stdio" }
  | { type: "http"; host: string; port: number };

export class App {
  readonly server: FastMCP;

  constructor() {
    this.server = new FastMCP({ name: "cyrnel", version: "1.0.0" });

    this.server.addTools([
      ...processTools,
      ...serviceTools,
      ...toolTools,
      ...moduleTools,
    ]);
    this.server.addResources([environmentDocsResource]);
    this.server.addResourceTemplates([toolDocsResourceTemplate]);
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
