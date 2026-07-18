import type {
  EnvironmentBindings,
  ExecutionInput,
  InvokeInput,
} from "@cyrnel/sdk";
import { describe, expect, it, vi } from "vitest";

import tsivm from "@/index";

describe("bindings", () => {
  const createBindings = () => {
    const emitStdout = vi.fn<EnvironmentBindings["emitStdout"]>();
    const emitStderr = vi.fn<EnvironmentBindings["emitStderr"]>();
    const emitOutput = vi.fn<EnvironmentBindings["emitOutput"]>();
    const invokeTool = vi.fn<EnvironmentBindings["invokeTool"]>();

    return {
      bindings: {
        setState: vi.fn(),
        emitStdout,
        emitStderr,
        emitOutput,
        setError: vi.fn(),
        invokeTool,
      } satisfies EnvironmentBindings,
      emitStdout,
      emitStderr,
      emitOutput,
      invokeTool,
    };
  };

  describe("console overrides", () => {
    it("emits stdout when console.log is called", async () => {
      const { bindings, emitStdout } = createBindings();
      const environment = tsivm.instantiate();

      await environment.setup({ bindings, config: {}, secrets: {} });

      await environment.execute({
        eid: 1,
        code: 'console.log("Hello, world!");',
        envConfig: { timeoutMs: 30_000 },
      } satisfies ExecutionInput);

      expect(emitStdout).toHaveBeenCalledWith(
        1,
        Buffer.from("Hello, world!\n", "utf8"),
      );
    });

    it("emits stderr when console.error is called", async () => {
      const { bindings, emitStderr } = createBindings();
      const environment = tsivm.instantiate();

      await environment.setup({ bindings, config: {}, secrets: {} });

      await environment.execute({
        eid: 1,
        code: 'console.error("Error occurred");',
        envConfig: { timeoutMs: 30_000 },
      } satisfies ExecutionInput);

      expect(emitStderr).toHaveBeenCalledWith(
        1,
        Buffer.from("Error occurred\n", "utf8"),
      );
    });

    it("formats multiple console.log arguments", async () => {
      const { bindings, emitStdout } = createBindings();
      const environment = tsivm.instantiate();

      await environment.setup({ bindings, config: {}, secrets: {} });

      await environment.execute({
        eid: 1,
        code: 'console.log("Count:", 42, { foo: "bar" });',
        envConfig: { timeoutMs: 30_000 },
      } satisfies ExecutionInput);

      expect(emitStdout).toHaveBeenCalledOnce();
      const buffer = emitStdout.mock.calls[0][1];
      const message = buffer.toString("utf8");
      expect(message).toContain("Count:");
      expect(message).toContain("42");
      expect(message).toContain("foo");
      expect(message).toContain("bar");
    });

    it("handles null and undefined in console.log", async () => {
      const { bindings, emitStdout } = createBindings();
      const environment = tsivm.instantiate();

      await environment.setup({ bindings, config: {}, secrets: {} });

      await environment.execute({
        eid: 1,
        code: "console.log(null, undefined);",
        envConfig: { timeoutMs: 30_000 },
      } satisfies ExecutionInput);

      expect(emitStdout).toHaveBeenCalledWith(
        1,
        Buffer.from("null undefined\n", "utf8"),
      );
    });
  });

  describe("cyrnel.output", () => {
    it("emits output when cyrnel.output is called", async () => {
      const { bindings, emitOutput } = createBindings();
      const environment = tsivm.instantiate();

      await environment.setup({ bindings, config: {}, secrets: {} });

      await environment.execute({
        eid: 1,
        code: 'cyrnel.output({ result: "success", count: 42 });',
        envConfig: { timeoutMs: 30_000 },
      } satisfies ExecutionInput);

      expect(emitOutput).toHaveBeenCalledWith(1, {
        result: "success",
        count: 42,
      });
    });

    it("passes through the eid to emitOutput", async () => {
      const { bindings, emitOutput } = createBindings();
      const environment = tsivm.instantiate();

      await environment.setup({ bindings, config: {}, secrets: {} });

      await environment.execute({
        eid: 99,
        code: 'cyrnel.output({ data: "test" });',
        envConfig: { timeoutMs: 30_000 },
      } satisfies ExecutionInput);

      expect(emitOutput).toHaveBeenCalledWith(99, { data: "test" });
    });
  });

  describe("cyrnel.services", () => {
    it("calls invokeTool with correct input", async () => {
      const { bindings, invokeTool } = createBindings();
      const environment = tsivm.instantiate();

      invokeTool.mockResolvedValue({ result: "success" });

      await environment.setup({ bindings, config: {}, secrets: {} });

      await environment.execute({
        eid: 1,
        code: "const result = await cyrnel.services.calc.tools.add.invoke({ a: 1, b: 2 }); console.log(JSON.stringify(result));",
      } satisfies ExecutionInput);

      expect(invokeTool).toHaveBeenCalledWith({
        serviceId: "calc",
        toolId: "add",
        parameters: { a: 1, b: 2 },
      } satisfies InvokeInput);
    });

    it("throws TypeError when service id is a symbol", async () => {
      const { bindings } = createBindings();
      const environment = tsivm.instantiate();

      await environment.setup({ bindings, config: {}, secrets: {} });

      const result = await environment.execute({
        eid: 1,
        code: 'try { cyrnel.services[Symbol("test")]; } catch(e) { console.error(e.message); }',
      } satisfies ExecutionInput);

      expect(result).toBe("success");
    });

    it("re-throws __ivmError as a catchable Error in the sandbox", async () => {
      const { bindings, invokeTool, emitStderr } = createBindings();
      const environment = tsivm.instantiate();

      invokeTool.mockRejectedValue(new Error("Tool invocation failed"));

      await environment.setup({ bindings, config: {}, secrets: {} });

      const result = await environment.execute({
        eid: 1,
        code: `
          try {
            await cyrnel.services.calc.tools.add.invoke({ x: 1 });
            console.log("Should not reach here");
          } catch (error) {
            console.error("Caught:", error.message);
          }
        `,
      } satisfies ExecutionInput);

      expect(result).toBe("success");
      expect(emitStderr).toHaveBeenCalled();
      const message = emitStderr.mock.calls[0][1].toString("utf8");
      expect(message).toContain("Caught:");
      expect(message).toContain("Tool invocation failed");
    });

    it("re-throws with stack trace preserved", async () => {
      const { bindings, invokeTool } = createBindings();
      const environment = tsivm.instantiate();

      const testError = new Error("Something broke");
      testError.stack = "Error: Something broke\n    at test.js:1:1";
      invokeTool.mockRejectedValue(testError);

      await environment.setup({ bindings, config: {}, secrets: {} });

      const result = await environment.execute({
        eid: 1,
        code: `
          try {
            await cyrnel.services.calc.tools.add.invoke({ x: 1 });
            console.log("Should not reach here");
          } catch (error) {
            console.error("Stack:", error.stack);
          }
        `,
      } satisfies ExecutionInput);

      expect(result).toBe("success");
      expect(bindings.emitStderr).toHaveBeenCalled();
      const message = bindings.emitStderr.mock.calls[0][1].toString("utf8");
      expect(message).toContain("Stack:");
      expect(message).toContain("Something broke");
    });

    it("throws TypeError when tool id is a symbol", async () => {
      const { bindings } = createBindings();
      const environment = tsivm.instantiate();

      await environment.setup({ bindings, config: {}, secrets: {} });

      const result = await environment.execute({
        eid: 1,
        code: 'try { cyrnel.services.test.tools[Symbol("tool")]; } catch(e) { console.error(e.message); }',
      } satisfies ExecutionInput);

      expect(result).toBe("success");
    });
  });

  describe("eid isolation", () => {
    it("passes correct eid for different executions", async () => {
      const { bindings, emitStdout } = createBindings();
      const environment = tsivm.instantiate();

      await environment.setup({ bindings, config: {}, secrets: {} });

      await environment.execute({
        eid: 10,
        code: 'console.log("first");',
        envConfig: { timeoutMs: 30_000 },
      } satisfies ExecutionInput);

      await environment.execute({
        eid: 20,
        code: 'console.log("second");',
        envConfig: { timeoutMs: 30_000 },
      } satisfies ExecutionInput);

      expect(emitStdout).toHaveBeenNthCalledWith(
        1,
        10,
        Buffer.from("first\n", "utf8"),
      );
      expect(emitStdout).toHaveBeenNthCalledWith(
        2,
        20,
        Buffer.from("second\n", "utf8"),
      );
    });

    it("isolates eid for multiple binding calls in same execution", async () => {
      const { bindings, emitStdout, emitOutput } = createBindings();
      const environment = tsivm.instantiate();

      await environment.setup({ bindings, config: {}, secrets: {} });

      await environment.execute({
        eid: 42,
        code: `
          console.log("test");
          cyrnel.output({ data: "result" });
          console.log("done");
        `,
        envConfig: { timeoutMs: 30_000 },
      } satisfies ExecutionInput);

      expect(emitStdout).toHaveBeenCalledWith(
        42,
        Buffer.from("test\n", "utf8"),
      );
      expect(emitOutput).toHaveBeenCalledWith(42, { data: "result" });
      expect(emitStdout).toHaveBeenCalledWith(
        42,
        Buffer.from("done\n", "utf8"),
      );
    });
  });

  describe("cyrnel global immutability", () => {
    it("prevents modification of cyrnel object", async () => {
      const { bindings } = createBindings();
      const environment = tsivm.instantiate();

      await environment.setup({ bindings, config: {}, secrets: {} });

      const result = await environment.execute({
        eid: 1,
        code: `
          try {
            cyrnel.newProperty = "test";
            console.log("FAIL: Should not allow modification");
          } catch(e) {
            console.log("PASS: Modification prevented");
          }
        `,
        envConfig: { timeoutMs: 30_000 },
      } satisfies ExecutionInput);

      expect(result).toBe("success");
    });

    it("prevents reassignment of cyrnel", async () => {
      const { bindings } = createBindings();
      const environment = tsivm.instantiate();

      await environment.setup({ bindings, config: {}, secrets: {} });

      const result = await environment.execute({
        eid: 1,
        code: `
          try {
            cyrnel = {};
            console.log("FAIL: Should not allow reassignment");
          } catch(e) {
            console.log("PASS: Reassignment prevented");
          }
        `,
        envConfig: { timeoutMs: 30_000 },
      } satisfies ExecutionInput);

      expect(result).toBe("success");
    });

    it("makes cyrnel enumerable", async () => {
      const { bindings, emitStdout } = createBindings();
      const environment = tsivm.instantiate();

      await environment.setup({ bindings, config: {}, secrets: {} });

      await environment.execute({
        eid: 1,
        code: 'console.log("cyrnel" in globalThis);',
        envConfig: { timeoutMs: 30_000 },
      } satisfies ExecutionInput);

      expect(emitStdout).toHaveBeenCalledWith(1, Buffer.from("true\n", "utf8"));
    });
  });
});
