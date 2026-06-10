import type { FastMCPSessionAuth, ResourceTemplate } from "fastmcp";

import { api } from "@/utils/fetch.js";

export const toolDocsResourceTemplate: ResourceTemplate<FastMCPSessionAuth> = {
  uriTemplate: "cyrnel://services/{service_id}/tools/{tool_id}/docs",
  name: "tool_docs",
  description: `
  Markdown docs for a single tool, rendered by the active execution
  environment. Includes the tool's description, parameter list
  (with types and required flags), return shape, and a worked example in the
  environment's calling syntax. Read this before constructing a call to the
  tool so the parameters match the schema.
  `,
  mimeType: "text/markdown",
  arguments: [
    {
      name: "service_id",
      description: "Service id that owns the tool.",
      required: true,
    },
    {
      name: "tool_id",
      description: "Tool id within the service.",
      required: true,
    },
  ],
  load: async ({ service_id, tool_id }) => {
    const text = await api
      .get(
        `tools/${encodeURIComponent(service_id)}/${encodeURIComponent(tool_id)}/docs`,
      )
      .text();
    return { text, mimeType: "text/markdown" };
  },
};
