import type { FastMCPSessionAuth, Resource } from "fastmcp";

import { api } from "@/utils/fetch.js";

export const environmentDocsResource: Resource<FastMCPSessionAuth> = {
  uri: "cyrnel://environment/docs",
  name: "environment_docs",
  description: `
  Markdown reference for the currently active execution environment. Describes
  the runtime language, available globals (e.g. the \`cyrnel\` object for
  discovering and invoking services and tools), I/O conventions, and an example
  program. Read this before authoring code that will be sent to
  \`create_process\` so the program targets the correct environment surface.
  `,
  mimeType: "text/markdown",
  load: async () => {
    const text = await api.get("environment/docs").text();
    return { text, mimeType: "text/markdown" };
  },
};
