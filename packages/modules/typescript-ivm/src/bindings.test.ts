import type {
  DiscoverInput,
  DiscoverServiceItem,
  DiscoverToolItem,
  EnvironmentBindings,
  ExecutionParams,
  GetServiceInput,
  GetToolInput,
  InvokeInput,
  ServiceDetails,
  ToolDetails,
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
    const invokeTool = vi.fn<EnvironmentBindings["invokeTool"]>();
    const discoverTools = vi.fn<EnvironmentBindings["discoverTools"]>();
    const discoverServices = vi.fn<EnvironmentBindings["discoverServices"]>();

    return {
      bindings: {
        setState: vi.fn(),
        emitStdout,
        emitStderr,
        emitOutput,
        getService,
        getTool,
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
        options: {},
      } satisfies ExecutionParams);

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
        options: {},
      } satisfies ExecutionParams);

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
        options: {},
      } satisfies ExecutionParams);

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
        options: {},
      } satisfies ExecutionParams);

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
        options: {},
      } satisfies ExecutionParams);

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
        options: {},
      } satisfies ExecutionParams);

      expect(emitOutput).toHaveBeenCalledWith(99, { data: "test" });
    });
  });

  describe("mci.services", () => {
    it("calls getService with correct input", async () => {
      const { bindings, getService } = createBindings();
      const environment = instantiate();

      const mockServiceDetails: ServiceDetails = {
        name: "testService",
        type: "test",
        source: "builtin",
        description: "Test service",
        hash: "abc123",
        enabled: true,
        configSchema: {},
        secretsSchema: {},
      };

      getService.mockResolvedValue(mockServiceDetails);

      await environment.setup({ bindings });

      await environment.execute({
        eid: 1,
        code: "const def = await mci.services.testService.getDefinition(); console.log(JSON.stringify(def));",
        options: {},
      } satisfies ExecutionParams);

      expect(getService).toHaveBeenCalledWith({
        serviceName: "testService",
      } satisfies GetServiceInput);
    });

    it("calls getTool with correct input", async () => {
      const { bindings, getTool } = createBindings();
      const environment = instantiate();

      const mockToolDetails: ToolDetails = {
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
        options: {},
      } satisfies ExecutionParams);

      expect(getTool).toHaveBeenCalledWith({
        serviceName: "myService",
        toolName: "testTool",
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
        options: {},
      } satisfies ExecutionParams);

      expect(invokeTool).toHaveBeenCalledWith({
        serviceName: "calc",
        toolName: "add",
        parameters: { a: 1, b: 2 },
      } satisfies InvokeInput);
    });

    it("throws TypeError when service name is a symbol", async () => {
      const { bindings } = createBindings();
      const environment = instantiate();

      await environment.setup({ bindings });

      const result = await environment.execute({
        eid: 1,
        code: 'try { mci.services[Symbol("test")]; } catch(e) { console.error(e.message); }',
        options: {},
      } satisfies ExecutionParams);

      expect(result).toBe("success");
    });

    it("throws TypeError when tool name is a symbol", async () => {
      const { bindings } = createBindings();
      const environment = instantiate();

      await environment.setup({ bindings });

      const result = await environment.execute({
        eid: 1,
        code: 'try { mci.services.test.tools[Symbol("tool")]; } catch(e) { console.error(e.message); }',
        options: {},
      } satisfies ExecutionParams);

      expect(result).toBe("success");
    });
  });

  describe("mci.discoverTools", () => {
    it("calls discoverTools with correct input", async () => {
      const { bindings, discoverTools } = createBindings();
      const environment = instantiate();

      const mockTools: DiscoverToolItem[] = [
        {
          serviceName: "calc",
          name: "add",
          description: "Add two numbers",
          enabled: true,
        },
        {
          serviceName: "calc",
          name: "subtract",
          description: "Subtract two numbers",
          enabled: true,
        },
      ];

      discoverTools.mockResolvedValue(mockTools);

      await environment.setup({ bindings });

      await environment.execute({
        eid: 1,
        code: 'const tools = await mci.discoverTools({ query: "math", limit: 10 }); console.log(JSON.stringify(tools));',
        options: {},
      } satisfies ExecutionParams);

      expect(discoverTools).toHaveBeenCalledWith({
        query: "math",
        limit: 10,
      } satisfies DiscoverInput);
    });

    it("supports optional parameters in discoverTools", async () => {
      const { bindings, discoverTools } = createBindings();
      const environment = instantiate();

      discoverTools.mockResolvedValue([]);

      await environment.setup({ bindings });

      await environment.execute({
        eid: 1,
        code: 'await mci.discoverTools({ query: "test" });',
        options: {},
      } satisfies ExecutionParams);

      expect(discoverTools).toHaveBeenCalledWith({
        query: "test",
      } satisfies DiscoverInput);
    });

    it("supports enabled filter in discoverTools", async () => {
      const { bindings, discoverTools } = createBindings();
      const environment = instantiate();

      discoverTools.mockResolvedValue([]);

      await environment.setup({ bindings });

      await environment.execute({
        eid: 1,
        code: 'await mci.discoverTools({ query: "test", enabled: true });',
        options: {},
      } satisfies ExecutionParams);

      expect(discoverTools).toHaveBeenCalledWith({
        query: "test",
        enabled: true,
      } satisfies DiscoverInput);
    });
  });

  describe("mci.discoverServices", () => {
    it("calls discoverServices with correct input", async () => {
      const { bindings, discoverServices } = createBindings();
      const environment = instantiate();

      const mockServices: DiscoverServiceItem[] = [
        {
          name: "calc",
          description: "Calculator service",
          enabled: true,
        },
        {
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
        options: {},
      } satisfies ExecutionParams);

      expect(discoverServices).toHaveBeenCalledWith({
        query: "api",
        limit: 5,
      } satisfies DiscoverInput);
    });

    it("supports null enabled filter in discoverServices", async () => {
      const { bindings, discoverServices } = createBindings();
      const environment = instantiate();

      discoverServices.mockResolvedValue([]);

      await environment.setup({ bindings });

      await environment.execute({
        eid: 1,
        code: 'await mci.discoverServices({ query: "test", enabled: null });',
        options: {},
      } satisfies ExecutionParams);

      expect(discoverServices).toHaveBeenCalledWith({
        query: "test",
        enabled: null,
      } satisfies DiscoverInput);
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
        options: {},
      } satisfies ExecutionParams);

      await environment.execute({
        eid: 20,
        code: 'console.log("second");',
        options: {},
      } satisfies ExecutionParams);

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
        options: {},
      } satisfies ExecutionParams);

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
        options: {},
      } satisfies ExecutionParams);

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
        options: {},
      } satisfies ExecutionParams);

      expect(result).toBe("success");
    });

    it("makes mci enumerable", async () => {
      const { bindings, emitStdout } = createBindings();
      const environment = instantiate();

      await environment.setup({ bindings });

      await environment.execute({
        eid: 1,
        code: 'console.log("mci" in globalThis);',
        options: {},
      } satisfies ExecutionParams);

      expect(emitStdout).toHaveBeenCalledWith(1, Buffer.from("true\n", "utf8"));
    });
  });
});
