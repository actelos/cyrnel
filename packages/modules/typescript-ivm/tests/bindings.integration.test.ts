import type { EnvironmentBindings, ExecutionInput } from "@cyrnel/sdk";
import { describe, expect, it, vi } from "vitest";

import { instantiate } from "@/index";

describe("bindings integration", () => {
  const createBindings = () => {
    return {
      setState: vi.fn(),
      emitStdout: vi.fn<EnvironmentBindings["emitStdout"]>(),
      emitStderr: vi.fn<EnvironmentBindings["emitStderr"]>(),
      emitOutput: vi.fn<EnvironmentBindings["emitOutput"]>(),
      setError: vi.fn<EnvironmentBindings["setError"]>(),
      invokeTool: vi.fn<EnvironmentBindings["invokeTool"]>(),
    } satisfies EnvironmentBindings;
  };

  describe("end-to-end service invocation", () => {
    it("handles errors in tool invocation", async () => {
      const bindings = createBindings();
      const environment = instantiate();

      bindings.invokeTool.mockRejectedValue(
        new Error("Tool invocation failed"),
      );

      await environment.setup({ bindings, config: {}, secrets: {} });

      const result = await environment.execute({
        eid: 1,
        code: `
          try {
            await cyrnel.services.broken.tools.fail.invoke({});
            console.log("Should not reach here");
          } catch (error) {
            console.error("Caught error:", error.message);
          }
        `,
      } satisfies ExecutionInput);

      expect(result).toBe("success");
      expect(bindings.emitStderr).toHaveBeenCalled();
      const stderrBuffer = bindings.emitStderr.mock.calls[0][1];
      const stderrMessage = stderrBuffer.toString("utf8");
      expect(stderrMessage).toContain("Caught error:");
    });
  });

  describe("complex console usage", () => {
    it("handles mixed console.log and console.error", async () => {
      const bindings = createBindings();
      const environment = instantiate();

      await environment.setup({ bindings, config: {}, secrets: {} });

      await environment.execute({
        eid: 1,
        code: `
          console.log("Starting process");
          console.error("Warning: This is a test");
          console.log("Process complete");
        `,
      } satisfies ExecutionInput);

      expect(bindings.emitStdout).toHaveBeenCalledTimes(2);
      expect(bindings.emitStderr).toHaveBeenCalledTimes(1);

      const stdout1 = bindings.emitStdout.mock.calls[0][1].toString("utf8");
      const stderr1 = bindings.emitStderr.mock.calls[0][1].toString("utf8");
      const stdout2 = bindings.emitStdout.mock.calls[1][1].toString("utf8");

      expect(stdout1).toBe("Starting process\n");
      expect(stderr1).toBe("Warning: This is a test\n");
      expect(stdout2).toBe("Process complete\n");
    });

    it("formats complex objects in console", async () => {
      const bindings = createBindings();
      const environment = instantiate();

      await environment.setup({ bindings, config: {}, secrets: {} });

      await environment.execute({
        eid: 1,
        code: `
          const data = {
            name: "Test",
            values: [1, 2, 3],
            nested: { key: "value" }
          };
          console.log("Data:", data);
        `,
      } satisfies ExecutionInput);

      const buffer = bindings.emitStdout.mock.calls[0][1];
      const message = buffer.toString("utf8");

      expect(message).toContain("Data:");
      expect(message).toContain("name");
      expect(message).toContain("Test");
      expect(message).toContain("values");
      expect(message).toContain("nested");
    });

    it("handles circular references in console", async () => {
      const bindings = createBindings();
      const environment = instantiate();

      await environment.setup({ bindings, config: {}, secrets: {} });

      const result = await environment.execute({
        eid: 1,
        code: `
          const obj = { name: "test" };
          obj.self = obj;
          console.log("Circular:", obj);
        `,
      } satisfies ExecutionInput);

      expect(result).toBe("success");
      expect(bindings.emitStdout).toHaveBeenCalled();
    });
  });

  describe("multiple executions with different eids", () => {
    it("keeps bindings isolated per execution", async () => {
      const bindings = createBindings();
      const environment = instantiate();

      await environment.setup({ bindings, config: {}, secrets: {} });

      await environment.execute({
        eid: 100,
        code: `
          console.log("Execution 100");
          cyrnel.output({ eid: 100 });
        `,
      } satisfies ExecutionInput);

      await environment.execute({
        eid: 200,
        code: `
          console.log("Execution 200");
          cyrnel.output({ eid: 200 });
        `,
      } satisfies ExecutionInput);

      expect(bindings.emitStdout).toHaveBeenNthCalledWith(
        1,
        100,
        Buffer.from("Execution 100\n", "utf8"),
      );
      expect(bindings.emitOutput).toHaveBeenNthCalledWith(1, 100, { eid: 100 });

      expect(bindings.emitStdout).toHaveBeenNthCalledWith(
        2,
        200,
        Buffer.from("Execution 200\n", "utf8"),
      );
      expect(bindings.emitOutput).toHaveBeenNthCalledWith(2, 200, { eid: 200 });
    });
  });

  describe("async operations", () => {
    it("handles async tool invocation", async () => {
      const bindings = createBindings();
      const environment = instantiate();

      bindings.invokeTool.mockImplementation(
        async () =>
          new Promise((resolve) =>
            setTimeout(() => resolve({ done: true }), 10),
          ),
      );

      await environment.setup({ bindings, config: {}, secrets: {} });

      const result = await environment.execute({
        eid: 1,
        code: `
          const result = await cyrnel.services.async.tools.wait.invoke({});
          cyrnel.output(result);
        `,
      } satisfies ExecutionInput);

      expect(result).toBe("success");
      expect(bindings.emitOutput).toHaveBeenCalledWith(1, { done: true });
    });

    it("handles parallel async operations", async () => {
      const bindings = createBindings();
      const environment = instantiate();

      bindings.invokeTool.mockResolvedValue({ value: 1 });

      await environment.setup({ bindings, config: {}, secrets: {} });

      const result = await environment.execute({
        eid: 1,
        code: `
          const results = await Promise.all([
            cyrnel.services.test.tools.a.invoke({}),
            cyrnel.services.test.tools.b.invoke({}),
            cyrnel.services.test.tools.c.invoke({})
          ]);
          cyrnel.output({ count: results.length });
        `,
      } satisfies ExecutionInput);

      expect(result).toBe("success");
      expect(bindings.invokeTool).toHaveBeenCalledTimes(3);
      expect(bindings.emitOutput).toHaveBeenCalledWith(1, { count: 3 });
    });
  });

  describe("TypeScript support", () => {
    it("executes TypeScript code with type annotations", async () => {
      const bindings = createBindings();
      const environment = instantiate();

      await environment.setup({ bindings, config: {}, secrets: {} });

      const result = await environment.execute({
        eid: 1,
        code: `
          interface Result {
            value: number;
          }

          const data: Result = { value: 42 };
          cyrnel.output(data);
        `,
      } satisfies ExecutionInput);

      expect(result).toBe("success");
      expect(bindings.emitOutput).toHaveBeenCalledWith(1, { value: 42 });
    });
  });
});
