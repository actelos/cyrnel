import { Schema } from "effect";

const echoInputSchema = Schema.Struct({
  value: Schema.Unknown,
});

const echoOutputSchema = Schema.Struct({
  value: Schema.Unknown,
});

const echo = (value) => value;

export default {
  type: "adapter",
  async parse() {
    return {
      id: "echo",
      tools: [
        {
          id: "echo",
          inputSchema: echoInputSchema,
          outputSchema: echoOutputSchema,
          async execute() {
            return async (input) => input;
          },
        },
      ],
    };
  },
  echo,
};
