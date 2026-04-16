import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  EnvironmentModule,
  type EnvironmentOutputPatch,
} from "@/modules/environment.module";

function collect<T>(mod: EnvironmentModule, event: string): T[] {
  const items: T[] = [];
  mod.on(event, (v: T) => items.push(v));
  return items;
}

function collectStderr(mod: EnvironmentModule): string[] {
  const items: string[] = [];
  mod.on("stderr", (buf: Buffer) => items.push(buf.toString()));
  return items;
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("EnvironmentModule", () => {
  let mod: EnvironmentModule;

  beforeEach(() => {
    mod = new EnvironmentModule();
  });

  afterEach(async () => {
    await mod.kill();
  });

  describe("execute()", () => {
    it("resolves 'success' for valid code that returns a value", async () => {
      const status = await mod.execute(`return 42;`);
      expect(status).toBe("success");
    });

    it("resolves 'success' for code with no explicit return", async () => {
      const status = await mod.execute(`const x = 1 + 1;`);
      expect(status).toBe("success");
    });

    it("resolves 'failed' when code throws an error", async () => {
      const status = await mod.execute(`throw new Error("boom");`);
      expect(status).toBe("failed");
    });

    it("resolves 'failed' for a rejected promise", async () => {
      const status = await mod.execute(
        `await Promise.reject(new Error("async boom"));`,
      );
      expect(status).toBe("failed");
    });

    it("throws when called while execution is already in progress", async () => {
      const first = mod.execute(`await new Promise(r => setTimeout(r, 5000));`);
      await expect(mod.execute(`return 1;`)).rejects.toThrow(
        "Execution already in progress",
      );
      await mod.kill();
      await first.catch(() => {});
    });

    it("allows sequential executions after the first completes", async () => {
      await mod.execute(`return 1;`);
      const status = await mod.execute(`return 2;`);
      expect(status).toBe("success");
    });
  });

  describe("TypeScript support", () => {
    it("transpiles and runs TypeScript code", async () => {
      const outputs = collect<EnvironmentOutputPatch>(mod, "output");
      const status = await mod.execute(`
        const greet = (name: string): string => \`Hello, \${name}!\`;
        emitOutput("greeting", greet("world"));
      `);
      expect(status).toBe("success");
      expect(outputs).toContainEqual({
        key: "greeting",
        value: "Hello, world!",
      });
    });

    it("throws synchronously for invalid TypeScript syntax", async () => {
      await expect(mod.execute(`const x: = 5;`)).rejects.toThrow(/transpile/i);
    });
  });

  describe("emitOutput()", () => {
    it("emits each call as a separate 'output' event", async () => {
      const outputs = collect<EnvironmentOutputPatch>(mod, "output");
      await mod.execute(`
        emitOutput("a", 1);
        emitOutput("b", 2);
        emitOutput("c", 3);
      `);
      expect(outputs.slice(0, 3)).toEqual([
        { key: "a", value: 1 },
        { key: "b", value: 2 },
        { key: "c", value: 3 },
      ]);
    });

    it("emits the return value as the final 'output' event", async () => {
      const outputs = collect<EnvironmentOutputPatch>(mod, "output");
      await mod.execute(`return { done: true };`);
      expect(outputs[outputs.length - 1]).toEqual({
        key: "result",
        value: { done: true },
      });
    });

    it("does not overwrite previous emitOutput values", async () => {
      const outputs = collect<EnvironmentOutputPatch>(mod, "output");
      await mod.execute(`
        emitOutput("first", 1);
        emitOutput("second", 2);
        emitOutput("third", 3);
      `);
      expect(outputs).toContainEqual({ key: "first", value: 1 });
      expect(outputs).toContainEqual({ key: "second", value: 2 });
      expect(outputs).toContainEqual({ key: "third", value: 3 });
    });

    it("handles objects, arrays, and numbers", async () => {
      const outputs = collect<EnvironmentOutputPatch>(mod, "output");
      await mod.execute(`
        emitOutput("object", { key: "value" });
        emitOutput("array", [1, 2, 3]);
        emitOutput("number", 99);
      `);
      expect(outputs).toContainEqual({
        key: "object",
        value: { key: "value" },
      });
      expect(outputs).toContainEqual({ key: "array", value: [1, 2, 3] });
      expect(outputs).toContainEqual({ key: "number", value: 99 });
    });

    it("does not emit an implicit undefined return value", async () => {
      const outputs = collect<EnvironmentOutputPatch>(mod, "output");
      await mod.execute(`
        emitOutput("greeting", "hello");
      `);

      expect(outputs).toEqual([{ key: "greeting", value: "hello" }]);
    });

    it("injects discover.tools and discover.services builtins", async () => {
      const outputs = collect<EnvironmentOutputPatch>(mod, "output");

      const status = await mod.execute(
        `
        const foundTools = await tools.discover({ query: "github issues", limit: 5, enabled: null });
        const foundServices = await services.discover({ query: "github", limit: 1, enabled: false });
        emitOutput("tools", foundTools);
        return foundServices;
      `,
        {
          builtins: {
            tools: {
              discover: async ({ query, limit, enabled }) => [
                { query, limit, enabled, kind: "tool" },
              ],
            },
            services: {
              discover: async ({ query, limit, enabled }) => [
                { query, limit, enabled, kind: "service" },
              ],
            },
          },
        },
      );

      expect(status).toBe("success");
      expect(outputs).toContainEqual({
        key: "tools",
        value: [
          { query: "github issues", limit: 5, enabled: null, kind: "tool" },
        ],
      });
      expect(outputs).toContainEqual({
        key: "result",
        value: [{ query: "github", limit: 1, enabled: false, kind: "service" }],
      });
    });
  });

  describe("stdout stream", () => {
    it("emits console.log output as 'stdout' Buffer chunks", async () => {
      const chunks: Buffer[] = [];
      mod.on("stdout", (c: Buffer) => chunks.push(c));
      await mod.execute(`console.log("hello from stdout");`);
      const text = Buffer.concat(chunks).toString();
      expect(text).toContain("hello from stdout");
    });
  });

  describe("stderr stream", () => {
    it("emits console.error output as 'stderr' Buffer chunks", async () => {
      const stderrMessages = collectStderr(mod);
      await mod.execute(`console.error("oops");`);
      expect(stderrMessages.join("")).toContain("oops");
    });

    it("emits the thrown error message on 'stderr'", async () => {
      const stderrMessages = collectStderr(mod);
      await mod.execute(`throw new Error("something went wrong");`);
      expect(stderrMessages.join("")).toContain("something went wrong");
    });
  });

  describe("timeout", () => {
    it("resolves 'failed' when execution exceeds timeoutMs", async () => {
      const status = await mod.execute(
        `await new Promise(r => setTimeout(r, 10_000));`,
        { timeoutMs: 50 },
      );
      expect(status).toBe("failed");
    });

    it("emits a timeout message on stderr", async () => {
      const stderrMessages = collectStderr(mod);
      await mod.execute(`await new Promise(r => setTimeout(r, 10_000));`, {
        timeoutMs: 50,
      });
      expect(stderrMessages.join("")).toContain("timed out");
    });

    it("allows a new execution after a timeout", async () => {
      await mod.execute(`await new Promise(r => setTimeout(r, 10_000));`, {
        timeoutMs: 50,
      });
      const status = await mod.execute(`return "recovered";`);
      expect(status).toBe("success");
    });

    it("does not treat null timeout as immediate timeout", async () => {
      const status = await mod.execute(
        `await new Promise(r => setTimeout(r, 10)); return "ok";`,
        { timeoutMs: null },
      );
      expect(status).toBe("success");
    });
  });

  describe("kill()", () => {
    it("resolves 'failed' when the worker is killed mid-execution", async () => {
      const promise = mod.execute(
        `await new Promise(r => setTimeout(r, 10_000));`,
      );
      await tick();
      await mod.kill();
      const status = await promise;
      expect(status).toBe("failed");
    });

    it("does not reject the execute promise when killed intentionally", async () => {
      const promise = mod.execute(
        `await new Promise(r => setTimeout(r, 10_000));`,
      );
      await tick();
      await mod.kill();
      await expect(promise).resolves.toBe("failed");
    });

    it("is a no-op when no worker is running", async () => {
      await expect(mod.kill()).resolves.toBeUndefined();
    });

    it("allows a new execution after kill", async () => {
      const promise = mod.execute(
        `await new Promise(r => setTimeout(r, 10_000));`,
      );
      await tick();
      await mod.kill();
      await promise;
      const status = await mod.execute(`return "back";`);
      expect(status).toBe("success");
    });
  });

  describe("output size cap", () => {
    it("emits a truncation warning on stderr when output exceeds 5 MB", async () => {
      const stderrMessages = collectStderr(mod);

      await mod.execute(`
        const chunk = "x".repeat(1024 * 1024);
        for (let i = 0; i < 6; i++) {
          process.stdout.write(chunk);
        }
      `);

      expect(stderrMessages.join("")).toContain("exceeded");
    });
  });
});
