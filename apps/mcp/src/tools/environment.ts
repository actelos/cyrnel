import type { FastMCPSessionAuth, Tool } from "fastmcp";
import { z } from "zod";

import { api } from "@/utils/fetch.js";

export const environmentTools: Tool<FastMCPSessionAuth, z.ZodType<unknown>>[] =
  [
    {
      name: "get_environment_docs",
      description: `
    Returns the markdown reference for the currently active execution
    environment. Describes the runtime language, available globals (e.g. the
    \`cyrnel\` object for discovering and invoking services and tools), I/O
    conventions, and an example program. Read this before authoring code that
    will be sent to \`create_process\` so the program targets the correct
    environment surface.
    `,
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
      parameters: z.object({}),
      execute: async () => api.get("environment/docs").text(),
    },
  ];
