import type {
  EnvironmentBindings,
  ExecutionInput,
  GetServiceResult,
  GetToolInput,
  GetToolResult,
  InvokeInput,
  ListServiceInput,
  ListServiceResult,
  ListToolInput,
  ListToolResult,
} from "@mci/sdk";
import { describe, expect, it, vi } from "vitest";

import { instantiate } from "./index";

describe("bindings", () => {
  const createBindings = () => {
    const emitStdout = vi.fn<EnvironmentBindings["emitStdout"]>();
    const emitStderr = vi.fn<EnvironmentBindings["emitStderr"]>();
    const emitOutput = vi.fn<EnvironmentBindings["emitOutput"]>();
    const getService = vi.fn<EnvironmentBindings["getService"]>();
    const getTool = vi.fn<EnvironmentBindings["getTool"]>();
    const getToolDocs = vi.fn<EnvironmentBindings["getToolDocs"]>();
    const invokeTool = vi.fn<EnvironmentBindings["invokeTool"]>();
    const discoverTools = vi.fn<EnvironmentBindings["discoverTools"]>();
    const discoverServices = vi.fn<EnvironmentBindings["discoverServices"]>();

    return {
      bindings: {
        setState: vi.fn(),
        emitStdout,
        emitStderr,
        emitOutput,
        setError: vi.fn(),
        getService,
        getTool,
        getToolDocs,
        invokeTool,
        discoverTools,
        discoverServices,
      } satisfies EnvironmentBindings,
      emitStdout,
      emitStderr,
      emitOutput,
      getService,
      getTool,
      invokeTool,
      discoverTools,
      discoverServices,
    };
  };

  describe("console overrides", () => {
    it("emits stdout when console.log is called", async () => {
      const { bindings, emitStdout } = createBindings();
      const environment = instantiate();

      await environment.setup({ bindings });

      await environment.execute({
        eid: 1,
        code: 'console.log("Hello, world!");',
        options: { timeoutMs: 30_000 },
      } satisfies ExecutionInput);

      expect(emitStdout).toHaveBeenCalledWith(
        1,
        Buffer.from("Hello, world!\n", "utf8"),
      );
    });

    it("emits stderr when console.error is called", async () => {
      const { bindings, emitStderr } = createBindings();
      const environment = instantiate();

      await environment.setup({ bindings });

      await environment.execute({
        eid: 1,
        code: 'console.error("Error occurred");',
        options: { timeoutMs: 30_000 },
      } satisfies ExecutionInput);

      expect(emitStderr).toHaveBeenCalledWith(
        1,
        Buffer.from("Error occurred\n", "utf8"),
      );
    });

    it("formats multiple console.log arguments", async () => {
      const { bindings, emitStdout } = createBindings();
      const environment = instantiate();

      await environment.setup({ bindings });

      await environment.execute({
        eid: 1,
        code: 'console.log("Count:", 42, { foo: "bar" });',
        options: { timeoutMs: 30_000 },
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
      const environment = instantiate();

      await environment.setup({ bindings });

      await environment.execute({
        eid: 1,
        code: "console.log(null, undefined);",
        options: { timeoutMs: 30_000 },
      } satisfies ExecutionInput);

      expect(emitStdout).toHaveBeenCalledWith(
        1,
        Buffer.from("null undefined\n", "utf8"),
      );
    });
  });

  describe("mci.output", () => {
    it("emits output when mci.output is called", async () => {
      const { bindings, emitOutput } = createBindings();
      const environment = instantiate();

      await environment.setup({ bindings });

      await environment.execute({
        eid: 1,
        code: 'mci.output({ result: "success", count: 42 });',
        options: { timeoutMs: 30_000 },
      } satisfies ExecutionInput);

      expect(emitOutput).toHaveBeenCalledWith(1, {
        result: "success",
        count: 42,
      });
    });

    it("passes through the eid to emitOutput", async () => {
      const { bindings, emitOutput } = createBindings();
      const environment = instantiate();

      await environment.setup({ bindings });

      await environment.execute({
        eid: 99,
        code: 'mci.output({ data: "test" });',
        options: { timeoutMs: 30_000 },
      } satisfies ExecutionInput);

      expect(emitOutput).toHaveBeenCalledWith(99, { data: "test" });
    });
  });

  describe("mci.services", () => {
    it("calls getService with correct input", async () => {
      const { bindings, getService } = createBindings();
      const environment = instantiate();

      const mockServiceDetails: GetServiceResult = {
        name: "testService",
        description: "Test service",
        enabled: true,
        configSchema: {},
        secretsSchema: {},
      };

      getService.mockResolvedValue(mockServiceDetails);

      await environment.setup({ bindings });

      await environment.execute({
        eid: 1,
        code: "const def = await mci.services.testService.getDefinition(); console.log(JSON.stringify(def));",
      } satisfies ExecutionInput);

      expect(getService).toHaveBeenCalledWith("testService");
    });

    it("calls getTool with correct input", async () => {
      const { bindings, getTool } = createBindings();
      const environment = instantiate();

      const mockToolDetails: GetToolResult = {
        name: "testTool",
        description: "Test tool",
        enabled: true,
        inputSchema: {},
        outputSchema: {},
      };

      getTool.mockResolvedValue(mockToolDetails);

      await environment.setup({ bindings });

      await environment.execute({
        eid: 1,
        code: "const def = await mci.services.myService.tools.testTool.getDefinition(); console.log(JSON.stringify(def));",
      } satisfies ExecutionInput);

      expect(getTool).toHaveBeenCalledWith({
        serviceId: "myService",
        toolId: "testTool",
      } satisfies GetToolInput);
    });

    it("calls invokeTool with correct input", async () => {
      const { bindings, invokeTool } = createBindings();
      const environment = instantiate();

      invokeTool.mockResolvedValue({ result: "success" });

      await environment.setup({ bindings });

      await environment.execute({
        eid: 1,
        code: "const result = await mci.services.calc.tools.add.invoke({ a: 1, b: 2 }); console.log(JSON.stringify(result));",
      } satisfies ExecutionInput);

      expect(invokeTool).toHaveBeenCalledWith({
        serviceId: "calc",
        toolId: "add",
        parameters: { a: 1, b: 2 },
      } satisfies InvokeInput);
    });

    it("throws TypeError when service id is a symbol", async () => {
      const { bindings } = createBindings();
      const environment = instantiate();

      await environment.setup({ bindings });

      const result = await environment.execute({
        eid: 1,
        code: 'try { mci.services[Symbol("test")]; } catch(e) { console.error(e.message); }',
      } satisfies ExecutionInput);

      expect(result).toBe("success");
    });

    it("throws TypeError when tool id is a symbol", async () => {
      const { bindings } = createBindings();
      const environment = instantiate();

      await environment.setup({ bindings });

      const result = await environment.execute({
        eid: 1,
        code: 'try { mci.services.test.tools[Symbol("tool")]; } catch(e) { console.error(e.message); }',
      } satisfies ExecutionInput);

      expect(result).toBe("success");
    });
  });

  describe("mci.discoverTools", () => {
    it("calls discoverTools with correct input", async () => {
      const { bindings, discoverTools } = createBindings();
      const environment = instantiate();

      const mockTools: ListToolResult[] = [
        {
          serviceId: "calc",
          id: "add",
          name: "add",
          description: "Add two numbers",
          enabled: true,
          effectivelyEnabled: true,
        },
        {
          serviceId: "calc",
          id: "subtract",
          name: "subtract",
          description: "Subtract two numbers",
          enabled: true,
          effectivelyEnabled: true,
        },
      ];

      discoverTools.mockResolvedValue(mockTools);

      await environment.setup({ bindings });

      await environment.execute({
        eid: 1,
        code: 'const tools = await mci.discoverTools({ query: "math", limit: 10 }); console.log(JSON.stringify(tools));',
      } satisfies ExecutionInput);

      expect(discoverTools).toHaveBeenCalledWith({
        query: "math",
        limit: 10,
      } satisfies ListToolInput);
    });

    it("supports optional parameters in discoverTools", async () => {
      const { bindings, discoverTools } = createBindings();
      const environment = instantiate();

      discoverTools.mockResolvedValue([]);

      await environment.setup({ bindings });

      await environment.execute({
        eid: 1,
        code: 'await mci.discoverTools({ query: "test" });',
      } satisfies ExecutionInput);

      expect(discoverTools).toHaveBeenCalledWith({
        query: "test",
      } satisfies ListToolInput);
    });

    it("supports enabled filter in discoverTools", async () => {
      const { bindings, discoverTools } = createBindings();
      const environment = instantiate();

      discoverTools.mockResolvedValue([]);

      await environment.setup({ bindings });

      await environment.execute({
        eid: 1,
        code: 'await mci.discoverTools({ query: "test", enabled: true });',
      } satisfies ExecutionInput);

      expect(discoverTools).toHaveBeenCalledWith({
        query: "test",
        enabled: true,
      } satisfies ListToolInput);
    });
  });

  describe("mci.discoverServices", () => {
    it("calls discoverServices with correct input", async () => {
      const { bindings, discoverServices } = createBindings();
      const environment = instantiate();

      const mockServices: ListServiceResult[] = [
        {
          id: "calc",
          name: "calc",
          description: "Calculator service",
          enabled: true,
        },
        {
          id: "weather",
          name: "weather",
          description: "Weather service",
          enabled: false,
        },
      ];

      discoverServices.mockResolvedValue(mockServices);

      await environment.setup({ bindings });

      await environment.execute({
        eid: 1,
        code: 'const services = await mci.discoverServices({ query: "api", limit: 5 }); console.log(JSON.stringify(services));',
      } satisfies ExecutionInput);

      expect(discoverServices).toHaveBeenCalledWith({
        query: "api",
        limit: 5,
      } satisfies ListServiceInput);
    });

    it("supports enabled filter in discoverServices", async () => {
      const { bindings, discoverServices } = createBindings();
      const environment = instantiate();

      discoverServices.mockResolvedValue([]);

      await environment.setup({ bindings });

      await environment.execute({
        eid: 1,
        code: 'await mci.discoverServices({ query: "test", enabled: false });',
      } satisfies ExecutionInput);

      expect(discoverServices).toHaveBeenCalledWith({
        query: "test",
        enabled: false,
      } satisfies ListServiceInput);
    });
  });

  describe("eid isolation", () => {
    it("passes correct eid for different executions", async () => {
      const { bindings, emitStdout } = createBindings();
      const environment = instantiate();

      await environment.setup({ bindings });

      await environment.execute({
        eid: 10,
        code: 'console.log("first");',
        options: { timeoutMs: 30_000 },
      } satisfies ExecutionInput);

      await environment.execute({
        eid: 20,
        code: 'console.log("second");',
        options: { timeoutMs: 30_000 },
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
      const environment = instantiate();

      await environment.setup({ bindings });

      await environment.execute({
        eid: 42,
        code: `
          console.log("test");
          mci.output({ data: "result" });
          console.log("done");
        `,
        options: { timeoutMs: 30_000 },
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

  describe("mci global immutability", () => {
    it("prevents modification of mci object", async () => {
      const { bindings } = createBindings();
      const environment = instantiate();

      await environment.setup({ bindings });

      const result = await environment.execute({
        eid: 1,
        code: `
          try {
            mci.newProperty = "test";
            console.log("FAIL: Should not allow modification");
          } catch(e) {
            console.log("PASS: Modification prevented");
          }
        `,
        options: { timeoutMs: 30_000 },
      } satisfies ExecutionInput);

      expect(result).toBe("success");
    });

    it("prevents reassignment of mci", async () => {
      const { bindings } = createBindings();
      const environment = instantiate();

      await environment.setup({ bindings });

      const result = await environment.execute({
        eid: 1,
        code: `
          try {
            mci = {};
            console.log("FAIL: Should not allow reassignment");
          } catch(e) {
            console.log("PASS: Reassignment prevented");
          }
        `,
        options: { timeoutMs: 30_000 },
      } satisfies ExecutionInput);

      expect(result).toBe("success");
    });

    it("makes mci enumerable", async () => {
      const { bindings, emitStdout } = createBindings();
      const environment = instantiate();

      await environment.setup({ bindings });

      await environment.execute({
        eid: 1,
        code: 'console.log("mci" in globalThis);',
        options: { timeoutMs: 30_000 },
      } satisfies ExecutionInput);

      expect(emitStdout).toHaveBeenCalledWith(1, Buffer.from("true\n", "utf8"));
    });
  });
});
