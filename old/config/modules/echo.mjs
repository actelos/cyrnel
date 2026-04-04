import { Schema } from "effect";

const echoInputSchema = Schema.Struct({
  value: Schema.Unknown,
});

const echoOutputSchema = Schema.Struct({
  value: Schema.Unknown,
});

const echo = async ({ value }) => ({ value });

const echoTool = {
  id: "echo",
  inputSchema: echoInputSchema,
  outputSchema: echoOutputSchema,
  async execute() {
    return echo;
  },
};

export default {
  type: "adapter",
  async parse() {
    return {
      id: "echo",
      tools: [echoTool],
    };
  },
};
