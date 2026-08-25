import type {
  EnvironmentBindings,
  ExecutionInput,
  InvokeInput,
  ModuleLogBindings,
  ModuleLogger,
} from "@cyrnel/sdk";
import { describe, expect, it, vi } from "vitest";

import tsivm from "@/index";

const stubLogger: ModuleLogger<ModuleLogBindings> = {
  context: {},
  child: <Next extends ModuleLogBindings>(
    bindings: Next,
  ): ModuleLogger<ModuleLogBindings & Next> =>
    ({
      ...stubLogger,
      context: { ...stubLogger.context, ...bindings },
    }) as ModuleLogger<ModuleLogBindings & Next>,
  redact: () => stubLogger,
  isLevelEnabled: () => true,
  trace: () => {},
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  fatal: () => {},
};

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

      await environment.setup({
        bindings,
        config: {},
        secrets: {},
        logger: stubLogger,
      });

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

      await environment.setup({
        bindings,
        config: {},
        secrets: {},
        logger: stubLogger,
      });

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

      await environment.setup({
        bindings,
        config: {},
        secrets: {},
        logger: stubLogger,
      });

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

      await environment.setup({
        bindings,
        config: {},
        secrets: {},
        logger: stubLogger,
      });

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

      await environment.setup({
        bindings,
        config: {},
        secrets: {},
        logger: stubLogger,
      });

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

      await environment.setup({
        bindings,
        config: {},
        secrets: {},
        logger: stubLogger,
      });

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

      await environment.setup({
        bindings,
        config: {},
        secrets: {},
        logger: stubLogger,
      });

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

      await environment.setup({
        bindings,
        config: {},
        secrets: {},
        logger: stubLogger,
      });

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

      await environment.setup({
        bindings,
        config: {},
        secrets: {},
        logger: stubLogger,
      });

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

      await environment.setup({
        bindings,
        config: {},
        secrets: {},
        logger: stubLogger,
      });

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

      await environment.setup({
        bindings,
        config: {},
        secrets: {},
        logger: stubLogger,
      });

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

      await environment.setup({
        bindings,
        config: {},
        secrets: {},
        logger: stubLogger,
      });

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

      await environment.setup({
        bindings,
        config: {},
        secrets: {},
        logger: stubLogger,
      });

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

      await environment.setup({
        bindings,
        config: {},
        secrets: {},
        logger: stubLogger,
      });

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

      await environment.setup({
        bindings,
        config: {},
        secrets: {},
        logger: stubLogger,
      });

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

      await environment.setup({
        bindings,
        config: {},
        secrets: {},
        logger: stubLogger,
      });

      await environment.execute({
        eid: 1,
        code: 'console.log("cyrnel" in globalThis);',
        envConfig: { timeoutMs: 30_000 },
      } satisfies ExecutionInput);

      expect(emitStdout).toHaveBeenCalledWith(1, Buffer.from("true\n", "utf8"));
    });
  });

  describe("optional bindings", () => {
    const setupWithBindings = async (
      bindings: Record<string, boolean>,
    ): Promise<{
      bindings: ReturnType<typeof createBindings>["bindings"];
      environment: ReturnType<typeof tsivm.instantiate>;
    }> => {
      const { bindings: bindingMocks } = createBindings();
      const environment = tsivm.instantiate();
      await environment.setup({
        bindings: bindingMocks,
        config: { bindings },
        secrets: {},
        logger: stubLogger,
      });
      return { bindings: bindingMocks, environment };
    };

    describe("base64", () => {
      it("provides btoa/atob when enabled", async () => {
        const { bindings, environment } = await setupWithBindings({
          base64: true,
        });

        const result = await environment.execute({
          eid: 1,
          code: `
            const enc = btoa("Hello, Cyrnel!");
            console.log(enc, atob(enc));
          `,
          envConfig: { timeoutMs: 30_000 },
        } satisfies ExecutionInput);

        expect(result).toBe("success");
        const message = bindings.emitStdout.mock.calls[0][1].toString("utf8");
        expect(message).toBe("SGVsbG8sIEN5cm5lbCE= Hello, Cyrnel!\n");
      });

      it("throws on non-Latin-1 characters in btoa", async () => {
        const { bindings, environment } = await setupWithBindings({
          base64: true,
        });

        const result = await environment.execute({
          eid: 1,
          code: `
            try {
              btoa("e\u20AC");
              console.log("FAIL: no throw");
            } catch (e) {
              console.log("threw:", e.constructor.name);
            }
          `,
          envConfig: { timeoutMs: 30_000 },
        } satisfies ExecutionInput);

        expect(result).toBe("success");
        const message = bindings.emitStdout.mock.calls[0][1].toString("utf8");
        expect(message).toContain("threw: TypeError");
      });

      it("rejects malformed base64 in atob", async () => {
        const { bindings, environment } = await setupWithBindings({
          base64: true,
        });

        const result = await environment.execute({
          eid: 1,
          code: `
            try {
              atob("not-base64!!");
              console.log("FAIL: no throw");
            } catch (e) {
              console.log("threw:", e.constructor.name);
            }
          `,
          envConfig: { timeoutMs: 30_000 },
        } satisfies ExecutionInput);

        expect(result).toBe("success");
        const message = bindings.emitStdout.mock.calls[0][1].toString("utf8");
        expect(message).toContain("threw: TypeError");
      });

      it("is absent when disabled", async () => {
        const { bindings, environment } = await setupWithBindings({});

        const result = await environment.execute({
          eid: 1,
          code: 'console.log("btoa:", typeof btoa, "atob:", typeof atob);',
          envConfig: { timeoutMs: 30_000 },
        } satisfies ExecutionInput);

        expect(result).toBe("success");
        const message = bindings.emitStdout.mock.calls[0][1].toString("utf8");
        expect(message).toBe("btoa: undefined atob: undefined\n");
      });
    });

    describe("textCodecs", () => {
      it("encodes and decodes UTF-8 when enabled", async () => {
        const { bindings, environment } = await setupWithBindings({
          textCodecs: true,
        });

        const result = await environment.execute({
          eid: 1,
          code: `
            const bytes = new TextEncoder().encode("héllo 🎉");
            console.log(JSON.stringify([...bytes]));
            console.log(new TextDecoder().decode(bytes));
          `,
          envConfig: { timeoutMs: 30_000 },
        } satisfies ExecutionInput);

        expect(result).toBe("success");
        const stdout = bindings.emitStdout.mock.calls.map((call) =>
          call[1].toString("utf8"),
        );
        expect(stdout[0]).toBe(
          "[104,195,169,108,108,111,32,240,159,142,137]\n",
        );
        expect(stdout[1]).toBe("héllo 🎉\n");
      });

      it("replaces invalid UTF-8 with U+FFFD", async () => {
        const { bindings, environment } = await setupWithBindings({
          textCodecs: true,
        });

        const result = await environment.execute({
          eid: 1,
          code: `
            const decoder = new TextDecoder();
            console.log(decoder.decode(new Uint8Array([0x41, 0xff, 0x42])));
          `,
          envConfig: { timeoutMs: 30_000 },
        } satisfies ExecutionInput);

        expect(result).toBe("success");
        const message = bindings.emitStdout.mock.calls[0][1].toString("utf8");
        expect(message).toBe("A\uFFFDB\n");
      });

      it("is absent when disabled", async () => {
        const { bindings, environment } = await setupWithBindings({});

        const result = await environment.execute({
          eid: 1,
          code: "console.log(typeof TextEncoder, typeof TextDecoder);",
          envConfig: { timeoutMs: 30_000 },
        } satisfies ExecutionInput);

        expect(result).toBe("success");
        const message = bindings.emitStdout.mock.calls[0][1].toString("utf8");
        expect(message).toBe("undefined undefined\n");
      });
    });

    describe("url", () => {
      it("parses URLs and search params when enabled", async () => {
        const { bindings, environment } = await setupWithBindings({
          url: true,
        });

        const result = await environment.execute({
          eid: 1,
          code: `
            const u = new URL("https://user:pw@example.com:8080/p/a?x=1&y=2#frag");
            console.log(u.protocol, u.hostname, u.port, u.pathname, u.hash);
            const params = new URLSearchParams(u.search);
            console.log(params.get("x"), params.get("y"));
            const built = new URL("https://example.com/");
            built.searchParams.set("q", "hello world");
            console.log(built.toString());
          `,
          envConfig: { timeoutMs: 30_000 },
        } satisfies ExecutionInput);

        expect(result).toBe("success");
        const stdout = bindings.emitStdout.mock.calls.map((call) =>
          call[1].toString("utf8"),
        );
        expect(stdout[0]).toBe("https: example.com 8080 /p/a #frag\n");
        expect(stdout[1]).toBe("1 2\n");
        expect(stdout[2]).toBe("https://example.com/?q=hello+world\n");
      });

      it("supports relative resolution", async () => {
        const { bindings, environment } = await setupWithBindings({
          url: true,
        });

        const result = await environment.execute({
          eid: 1,
          code: `
            const u = new URL("../b?c=d", "https://example.com/a/x");
            console.log(u.href);
          `,
          envConfig: { timeoutMs: 30_000 },
        } satisfies ExecutionInput);

        expect(result).toBe("success");
        const message = bindings.emitStdout.mock.calls[0][1].toString("utf8");
        expect(message).toBe("https://example.com/b?c=d\n");
      });

      it("is absent when disabled", async () => {
        const { bindings, environment } = await setupWithBindings({});

        const result = await environment.execute({
          eid: 1,
          code: "console.log(typeof URL, typeof URLSearchParams);",
          envConfig: { timeoutMs: 30_000 },
        } satisfies ExecutionInput);

        expect(result).toBe("success");
        const message = bindings.emitStdout.mock.calls[0][1].toString("utf8");
        expect(message).toBe("undefined undefined\n");
      });
    });

    describe("timers", () => {
      it("resolves awaited setTimeout when enabled", async () => {
        const { bindings, environment } = await setupWithBindings({
          timers: true,
        });

        const result = await environment.execute({
          eid: 1,
          code: `
            const started = Date.now();
            const value = await new Promise((resolve) => {
              setTimeout(() => resolve("fired"), 30);
            });
            console.log(value, "elapsed", Date.now() - started);
          `,
          envConfig: { timeoutMs: 30_000 },
        } satisfies ExecutionInput);

        expect(result).toBe("success");
        const message = bindings.emitStdout.mock.calls[0][1].toString("utf8");
        expect(message).toMatch(/^fired elapsed \d+\n$/);
      });

      it("passes arguments to setTimeout and setInterval callbacks", async () => {
        const { bindings, environment } = await setupWithBindings({
          timers: true,
        });

        const result = await environment.execute({
          eid: 1,
          code: `
            const value = await new Promise((resolve) => {
              setTimeout((a, b) => resolve(a + " " + b), 20, "hello", "world");
            });
            console.log(value);
          `,
          envConfig: { timeoutMs: 30_000 },
        } satisfies ExecutionInput);

        expect(result).toBe("success");
        const message = bindings.emitStdout.mock.calls[0][1].toString("utf8");
        expect(message).toBe("hello world\n");
      });

      it("fires setInterval repeatedly until cleared", async () => {
        const { bindings, environment } = await setupWithBindings({
          timers: true,
        });

        const result = await environment.execute({
          eid: 1,
          code: `
            let ticks = 0;
            await new Promise((resolve) => {
              const id = setInterval(() => {
                ticks += 1;
                if (ticks >= 3) {
                  clearInterval(id);
                  resolve(null);
                }
              }, 15);
            });
            console.log("ticks:", ticks);
          `,
          envConfig: { timeoutMs: 30_000 },
        } satisfies ExecutionInput);

        expect(result).toBe("success");
        const message = bindings.emitStdout.mock.calls[0][1].toString("utf8");
        expect(message).toBe("ticks: 3\n");
      });

      it("runs queueMicrotask in microtask order", async () => {
        const { bindings, environment } = await setupWithBindings({
          timers: true,
        });

        const result = await environment.execute({
          eid: 1,
          code: `
            const order = [];
            queueMicrotask(() => order.push(2));
            order.push(1);
            await Promise.resolve();
            console.log("order:", order.join(","));
          `,
          envConfig: { timeoutMs: 30_000 },
        } satisfies ExecutionInput);

        expect(result).toBe("success");
        const message = bindings.emitStdout.mock.calls[0][1].toString("utf8");
        expect(message).toBe("order: 1,2\n");
      });

      it("enforces the max delay cap", async () => {
        const { bindings, environment } = await setupWithBindings({
          timers: true,
        });

        const result = await environment.execute({
          eid: 1,
          code: `
            try {
              setTimeout(() => {}, 99999999);
              console.log("FAIL: no throw");
            } catch (e) {
              console.log("threw:", e.constructor.name, e.message);
            }
          `,
          envConfig: { timeoutMs: 30_000 },
        } satisfies ExecutionInput);

        expect(result).toBe("success");
        const message = bindings.emitStdout.mock.calls[0][1].toString("utf8");
        expect(message).toContain("threw: RangeError");
        expect(message).toContain("60000");
      });

      it("clears timers when the execution completes", async () => {
        const { bindings, environment } = await setupWithBindings({
          timers: true,
        });

        const result = await environment.execute({
          eid: 1,
          code: `
            setTimeout(() => console.log("should never print"), 20);
          `,
          envConfig: { timeoutMs: 30_000 },
        } satisfies ExecutionInput);

        expect(result).toBe("success");

        await new Promise((resolve) => setTimeout(resolve, 60));
        expect(bindings.emitStdout).not.toHaveBeenCalled();
      });

      it("is absent when disabled", async () => {
        const { bindings, environment } = await setupWithBindings({});

        const result = await environment.execute({
          eid: 1,
          code: "console.log(typeof setTimeout, typeof queueMicrotask);",
          envConfig: { timeoutMs: 30_000 },
        } satisfies ExecutionInput);

        expect(result).toBe("success");
        const message = bindings.emitStdout.mock.calls[0][1].toString("utf8");
        expect(message).toBe("undefined undefined\n");
      });
    });

    describe("randomValues", () => {
      it("fills typed arrays and generates UUIDs when enabled", async () => {
        const { bindings, environment } = await setupWithBindings({
          randomValues: true,
        });

        const result = await environment.execute({
          eid: 1,
          code: `
            const arr = new Uint8Array(32);
            crypto.getRandomValues(arr);
            console.log(arr.length, arr.some((b) => b !== 0));
            const uuid = crypto.randomUUID();
            console.log(uuid.length, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(uuid));
            console.log(crypto.getRandomValues(new Uint16Array(4)).length);
          `,
          envConfig: { timeoutMs: 30_000 },
        } satisfies ExecutionInput);

        expect(result).toBe("success");
        const stdout = bindings.emitStdout.mock.calls.map((call) =>
          call[1].toString("utf8"),
        );
        expect(stdout[0]).toBe("32 true\n");
        expect(stdout[1]).toBe("36 true\n");
        expect(stdout[2]).toBe("4\n");
      });

      it("throws when the array exceeds 65536 bytes", async () => {
        const { bindings, environment } = await setupWithBindings({
          randomValues: true,
        });

        const result = await environment.execute({
          eid: 1,
          code: `
            try {
              crypto.getRandomValues(new Uint8Array(65537));
              console.log("FAIL: no throw");
            } catch (e) {
              console.log("threw:", e.constructor.name);
            }
          `,
          envConfig: { timeoutMs: 30_000 },
        } satisfies ExecutionInput);

        expect(result).toBe("success");
        const message = bindings.emitStdout.mock.calls[0][1].toString("utf8");
        expect(message).toContain("threw: RangeError");
      });

      it("is absent when disabled", async () => {
        const { bindings, environment } = await setupWithBindings({});

        const result = await environment.execute({
          eid: 1,
          code: "console.log(typeof crypto);",
          envConfig: { timeoutMs: 30_000 },
        } satisfies ExecutionInput);

        expect(result).toBe("success");
        const message = bindings.emitStdout.mock.calls[0][1].toString("utf8");
        expect(message).toBe("undefined\n");
      });
    });

    describe("fullConsole", () => {
      it("routes console.warn and other methods to stdout when enabled", async () => {
        const { bindings, environment } = await setupWithBindings({
          fullConsole: true,
        });

        const result = await environment.execute({
          eid: 1,
          code: `
            console.warn("watch out");
            console.info("just info");
            console.debug("debug line");
          `,
          envConfig: { timeoutMs: 30_000 },
        } satisfies ExecutionInput);

        expect(result).toBe("success");
        const stdout = bindings.emitStdout.mock.calls.map((call) =>
          call[1].toString("utf8"),
        );
        expect(stdout[0]).toBe("warn: watch out\n");
        expect(stdout[1]).toBe("info: just info\n");
        expect(stdout[2]).toBe("debug: debug line\n");
      });

      it("keeps console.log format unchanged", async () => {
        const { bindings, environment } = await setupWithBindings({
          fullConsole: true,
        });

        const result = await environment.execute({
          eid: 1,
          code: 'console.log("plain", 42);',
          envConfig: { timeoutMs: 30_000 },
        } satisfies ExecutionInput);

        expect(result).toBe("success");
        const message = bindings.emitStdout.mock.calls[0][1].toString("utf8");
        expect(message).toBe("plain 42\n");
      });

      it("silently drops methods when disabled", async () => {
        const { bindings, environment } = await setupWithBindings({});

        const result = await environment.execute({
          eid: 1,
          code: 'console.warn("nothing"); console.log("after");',
          envConfig: { timeoutMs: 30_000 },
        } satisfies ExecutionInput);

        expect(result).toBe("success");
        const message = bindings.emitStdout.mock.calls[0][1].toString("utf8");
        expect(message).toBe("after\n");
      });
    });
  });
});
