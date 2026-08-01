(() => {
  interface IvmReference {
    applyIgnored(receiver: undefined, args: unknown[]): void;
    applySyncPromise(receiver: undefined, args: unknown[]): Promise<unknown>;
  }

  interface CyrnelGlobals {
    __cyrnel_emitStdout: IvmReference;
    __cyrnel_emitStderr: IvmReference;
    __cyrnel_emitOutput: IvmReference;
    __cyrnel_invokeTool: IvmReference;
  }

  const cyrnelGlobals = globalThis as typeof globalThis & CyrnelGlobals;

  const __cyrnel_emitStdout = cyrnelGlobals.__cyrnel_emitStdout;
  const __cyrnel_emitStderr = cyrnelGlobals.__cyrnel_emitStderr;
  const __cyrnel_emitOutput = cyrnelGlobals.__cyrnel_emitOutput;
  const __cyrnel_invokeTool = cyrnelGlobals.__cyrnel_invokeTool;

  type InvokeInput = {
    serviceId: string;
    toolId: string;
    parameters: Record<string, unknown>;
  };

  const formatConsoleArgs = (...args: unknown[]): string => {
    return args
      .map((arg) => {
        if (typeof arg === "string") return arg;
        if (arg === null) return "null";
        if (arg === undefined) return "undefined";
        try {
          return JSON.stringify(arg, null, 2);
        } catch {
          return String(arg);
        }
      })
      .join(" ");
  };

  console.log = (...args: unknown[]) => {
    const message = `${formatConsoleArgs(...args)}\n`;
    __cyrnel_emitStdout.applyIgnored(undefined, [message]);
  };

  console.error = (...args: unknown[]) => {
    const message = `${formatConsoleArgs(...args)}\n`;
    __cyrnel_emitStderr.applyIgnored(undefined, [message]);
  };

  const callAsync = async <T>(
    ref: IvmReference,
    input: unknown,
  ): Promise<T> => {
    const jsonInput = JSON.stringify(input);
    const jsonResult = await ref.applySyncPromise(undefined, [jsonInput]);
    const parsed = JSON.parse(jsonResult as string) as unknown;
    if (
      parsed &&
      typeof parsed === "object" &&
      "__cyrnel_error" in (parsed as Record<string, unknown>)
    ) {
      throw new Error((parsed as Record<string, string>).__cyrnel_error);
    }
    return parsed as T;
  };

  const cyrnel = {
    output(data: Record<string, unknown>): void {
      __cyrnel_emitOutput.applyIgnored(undefined, [JSON.stringify(data)]);
    },

    services: new Proxy(
      {} as Record<
        string,
        {
          tools: Record<
            string,
            {
              invoke: (parameters: Record<string, unknown>) => Promise<unknown>;
            }
          >;
        }
      >,
      {
        get(_target, serviceId: string | symbol) {
          if (typeof serviceId !== "string") {
            throw new TypeError("Service id must be a string");
          }

          return {
            tools: new Proxy(
              {} as Record<
                string,
                {
                  invoke: (
                    parameters: Record<string, unknown>,
                  ) => Promise<unknown>;
                }
              >,
              {
                get(_target, toolId: string | symbol) {
                  if (typeof toolId !== "string") {
                    throw new TypeError("Tool id must be a string");
                  }

                  return {
                    async invoke(
                      parameters: Record<string, unknown>,
                    ): Promise<unknown> {
                      const input = {
                        serviceId,
                        toolId,
                        parameters,
                      } satisfies InvokeInput;
                      const result = await callAsync<unknown>(
                        __cyrnel_invokeTool,
                        input,
                      );
                      if (
                        result !== null &&
                        typeof result === "object" &&
                        "__ivmError" in result
                      ) {
                        const errorResult = result as Record<string, unknown>;
                        const err = new Error(String(errorResult.__ivmError));
                        if (typeof errorResult.__ivmStack === "string") {
                          err.stack = errorResult.__ivmStack;
                        }
                        throw err;
                      }
                      return result;
                    },
                  };
                },
              },
            ),
          };
        },
      },
    ),
  };

  Object.defineProperty(globalThis, "cyrnel", {
    value: Object.freeze(cyrnel),
    enumerable: true,
    configurable: false,
    writable: false,
  });
})();
