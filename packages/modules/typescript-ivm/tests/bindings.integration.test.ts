import type {
  EnvironmentBindings,
  ExecutionInput,
  GetServiceResult,
  GetToolResult,
  ListServiceInput,
  ListServiceResult,
  ListToolInput,
  ListToolResult,
} from "@mci/sdk";
import { describe, expect, it, vi } from "vitest";

import { instantiate } from "../src/index";

describe("bindings integration", () => {
  const createBindings = () => {
    return {
      setState: vi.fn(),
      emitStdout: vi.fn<EnvironmentBindings["emitStdout"]>(),
      emitStderr: vi.fn<EnvironmentBindings["emitStderr"]>(),
      emitOutput: vi.fn<EnvironmentBindings["emitOutput"]>(),
      setError: vi.fn<EnvironmentBindings["setError"]>(),
      getService: vi.fn<EnvironmentBindings["getService"]>(),
      getTool: vi.fn<EnvironmentBindings["getTool"]>(),
      getToolDocs: vi.fn<EnvironmentBindings["getToolDocs"]>(),
      invokeTool: vi.fn<EnvironmentBindings["invokeTool"]>(),
      discoverTools: vi.fn<EnvironmentBindings["discoverTools"]>(),
      discoverServices: vi.fn<EnvironmentBindings["discoverServices"]>(),
    } satisfies EnvironmentBindings;
  };

  describe("end-to-end service invocation", () => {
    it("executes a complete tool invocation workflow", async () => {
      const bindings = createBindings();
      const environment = instantiate();

      const serviceDetails: GetServiceResult = {
        name: "calculator",
        description: "Calculator service",
        enabled: true,
        configSchema: {},
        secretsSchema: {},
      };

      const toolDetails: GetToolResult = {
        name: "add",
        description: "Add two numbers",
        enabled: true,
        inputSchema: {
          type: "object",
          properties: {
            a: { type: "number" },
            b: { type: "number" },
          },
        },
        outputSchema: {
          type: "object",
          properties: {
            result: { type: "number" },
          },
        },
      };

      bindings.getService.mockResolvedValue(serviceDetails);
      bindings.getTool.mockResolvedValue(toolDetails);
      bindings.invokeTool.mockResolvedValue({ result: 42 });

      await environment.setup({ bindings, config: {}, secrets: {} });

      const result = await environment.execute({
        eid: 1,
        code: `
          const service = await mci.services.calculator.getDefinition();
          console.log("Service:", service.name);

          const tool = await mci.services.calculator.tools.add.getDefinition();
          console.log("Tool:", tool.name);

          const output = await mci.services.calculator.tools.add.invoke({
            a: 40,
            b: 2
          });

          mci.output({ computation: output });
        `,
      } satisfies ExecutionInput);

      expect(result).toBe("success");
      expect(bindings.getService).toHaveBeenCalledWith("calculator");
      expect(bindings.getTool).toHaveBeenCalledWith({
        serviceId: "calculator",
        toolId: "add",
      });
      expect(bindings.invokeTool).toHaveBeenCalledWith({
        serviceId: "calculator",
        toolId: "add",
        parameters: { a: 40, b: 2 },
      });
      expect(bindings.emitOutput).toHaveBeenCalledWith(1, {
        computation: { result: 42 },
      });
    });

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
            await mci.services.broken.tools.fail.invoke({});
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

  describe("discovery workflows", () => {
    it("discovers services and tools", async () => {
      const bindings = createBindings();
      const environment = instantiate();

      const services: ListServiceResult[] = [
        { id: "calc", name: "calc", description: "Calculator", enabled: true },
        {
          id: "weather",
          name: "weather",
          description: "Weather API",
          enabled: true,
        },
      ];

      const tools: ListToolResult[] = [
        {
          serviceId: "calc",
          id: "add",
          name: "add",
          description: "Add numbers",
          enabled: true,
          effectivelyEnabled: true,
        },
        {
          serviceId: "calc",
          id: "multiply",
          name: "multiply",
          description: "Multiply numbers",
          enabled: true,
          effectivelyEnabled: true,
        },
      ];

      bindings.discoverServices.mockResolvedValue(services);
      bindings.discoverTools.mockResolvedValue(tools);

      await environment.setup({ bindings, config: {}, secrets: {} });

      const result = await environment.execute({
        eid: 1,
        code: `
          const services = await mci.discoverServices({ query: "", limit: 10 });
          console.log("Services count:", services.length);

          const tools = await mci.discoverTools({ query: "calc", limit: 10 });
          console.log("Tools count:", tools.length);

          mci.output({ services, tools });
        `,
      } satisfies ExecutionInput);

      expect(result).toBe("success");
      expect(bindings.discoverServices).toHaveBeenCalledWith({
        query: "",
        limit: 10,
      } satisfies ListServiceInput);
      expect(bindings.discoverTools).toHaveBeenCalledWith({
        query: "calc",
        limit: 10,
      } satisfies ListToolInput);
      expect(bindings.emitOutput).toHaveBeenCalledWith(1, { services, tools });
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
          mci.output({ eid: 100 });
        `,
      } satisfies ExecutionInput);

      await environment.execute({
        eid: 200,
        code: `
          console.log("Execution 200");
          mci.output({ eid: 200 });
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
          const result = await mci.services.async.tools.wait.invoke({});
          mci.output(result);
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
            mci.services.test.tools.a.invoke({}),
            mci.services.test.tools.b.invoke({}),
            mci.services.test.tools.c.invoke({})
          ]);
          mci.output({ count: results.length });
        `,
      } satisfies ExecutionInput);

      expect(result).toBe("success");
      expect(bindings.invokeTool).toHaveBeenCalledTimes(3);
      expect(bindings.emitOutput).toHaveBeenCalledWith(1, { count: 3 });
    });
  });

  describe("error handling", () => {
    it("propagates errors from host bindings", async () => {
      const bindings = createBindings();
      const environment = instantiate();

      bindings.getService.mockRejectedValue(
        new Error("Service not found: unknown"),
      );

      await environment.setup({ bindings, config: {}, secrets: {} });

      const result = await environment.execute({
        eid: 1,
        code: `
          try {
            await mci.services.unknown.getDefinition();
          } catch (error) {
            console.error("Error:", error.message);
          }
        `,
      } satisfies ExecutionInput);

      expect(result).toBe("success");
      expect(bindings.emitStderr).toHaveBeenCalled();
      const message = bindings.emitStderr.mock.calls[0][1].toString("utf8");
      expect(message).toContain("Service not found");
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
          mci.output(data);
        `,
      } satisfies ExecutionInput);

      expect(result).toBe("success");
      expect(bindings.emitOutput).toHaveBeenCalledWith(1, { value: 42 });
    });

    it("supports type inference with bindings", async () => {
      const bindings = createBindings();
      const environment = instantiate();

      const toolDetails: GetToolResult = {
        name: "test",
        description: "Test tool",
        enabled: true,
        inputSchema: {},
        outputSchema: {},
      };

      bindings.getTool.mockResolvedValue(toolDetails);

      await environment.setup({ bindings, config: {}, secrets: {} });

      const result = await environment.execute({
        eid: 1,
        code: `
          const tool = await mci.services.test.tools.test.getDefinition();
          const name: string = tool.name;
          console.log(name);
        `,
      } satisfies ExecutionInput);

      expect(result).toBe("success");
    });
  });
});
