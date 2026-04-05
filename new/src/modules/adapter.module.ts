export class AdapterModule {
  async invoke(
    toolName: string,
    parameters: Record<string, unknown>,
  ): Promise<string> {
    if (toolName === "echo") {
      const input = parameters.input;

      if (typeof input !== "string") {
        throw new Error("Echo tool requires a string 'input' parameter.");
      }

      return input;
    }

    return "hello world";
  }
}
