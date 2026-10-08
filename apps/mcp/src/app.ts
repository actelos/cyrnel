import { FastMCP } from "fastmcp";

import { createApprovalPresenter } from "@/approval-presenter.js";
import { config } from "@/config.js";
import buildTools from "@/tools.js";

export type Transport =
  | { type: "stdio" }
  | { type: "http"; host: string; port: number };

export class App {
  readonly server: FastMCP;

  constructor() {
    this.server = new FastMCP({ name: "cyrnel", version: "1.0.0" });
    this.server.addTools(
      buildTools(createApprovalPresenter(config.approvalMethod)),
    );
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
