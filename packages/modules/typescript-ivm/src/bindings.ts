(() => {
  interface IvmReference {
    applyIgnored(receiver: undefined, args: unknown[]): void;
    applySyncPromise(receiver: undefined, args: unknown[]): Promise<unknown>;
  }

  interface CyrnelGlobals {
    __cyrnel_emitStdout: IvmReference;
    __cyrnel_emitStderr: IvmReference;
    __cyrnel_emitOutput: IvmReference;
    __cyrnel_getService: IvmReference;
    __cyrnel_getTool: IvmReference;
    __cyrnel_getToolDocs: IvmReference;
    __cyrnel_invokeTool: IvmReference;
    __cyrnel_discoverTools: IvmReference;
    __cyrnel_discoverServices: IvmReference;
  }

  const cyrnelGlobals = globalThis as typeof globalThis & CyrnelGlobals;

  const __cyrnel_emitStdout = cyrnelGlobals.__cyrnel_emitStdout;
  const __cyrnel_emitStderr = cyrnelGlobals.__cyrnel_emitStderr;
  const __cyrnel_emitOutput = cyrnelGlobals.__cyrnel_emitOutput;
  const __cyrnel_getService = cyrnelGlobals.__cyrnel_getService;
  const __cyrnel_getTool = cyrnelGlobals.__cyrnel_getTool;
  const __cyrnel_getToolDocs = cyrnelGlobals.__cyrnel_getToolDocs;
  const __cyrnel_invokeTool = cyrnelGlobals.__cyrnel_invokeTool;
  const __cyrnel_discoverTools = cyrnelGlobals.__cyrnel_discoverTools;
  const __cyrnel_discoverServices = cyrnelGlobals.__cyrnel_discoverServices;

  type ListServiceInput = {
    query?: string;
    limit?: number;
    enabled?: boolean;
  };

  type ListToolInput = {
    serviceId?: string;
    query?: string;
    limit?: number;
    enabled?: boolean;
  };

  type ListServiceResult = {
    id: string;
    name: string;
    description: string;
    enabled: boolean;
  };

  type ListToolResult = {
    serviceId: string;
    id: string;
    name: string;
    description: string;
    enabled: boolean;
  };

  type ServiceDetails = {
    name: string;
    description: string;
    enabled: boolean;
    configSchema: Record<string, unknown>;
    secretsSchema: Record<string, unknown>;
  };

  type GetToolInput = {
    serviceId: string;
    toolId: string;
  };

  type ToolDetails = {
    name: string;
    description: string;
    enabled: boolean;
    inputSchema: Record<string, unknown>;
    outputSchema: Record<string, unknown>;
  };

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
    return JSON.parse(jsonResult as string) as T;
  };

  const callAsyncText = async (
    ref: IvmReference,
    input: unknown,
  ): Promise<string> => {
    const jsonInput = JSON.stringify(input);
    const result = await ref.applySyncPromise(undefined, [jsonInput]);
    return result as string;
  };

  const cyrnel = {
    output(data: Record<string, unknown>): void {
      __cyrnel_emitOutput.applyIgnored(undefined, [JSON.stringify(data)]);
    },

    services: new Proxy(
      {} as Record<
        string,
        {
          getDefinition: () => Promise<ServiceDetails>;
          tools: Record<
            string,
            {
              getDefinition: () => Promise<ToolDetails>;
              getDocs: () => Promise<string>;
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
            async getDefinition(): Promise<ServiceDetails> {
              return callAsync<ServiceDetails>(__cyrnel_getService, serviceId);
            },

            tools: new Proxy(
              {} as Record<
                string,
                {
                  getDefinition: () => Promise<ToolDetails>;
                  getDocs: () => Promise<string>;
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
                    async getDefinition(): Promise<ToolDetails> {
                      const input = {
                        serviceId,
                        toolId,
                      } satisfies GetToolInput;
                      return callAsync<ToolDetails>(__cyrnel_getTool, input);
                    },
                    async getDocs(): Promise<string> {
                      const input = {
                        serviceId,
                        toolId,
                      } satisfies GetToolInput;
                      return callAsyncText(__cyrnel_getToolDocs, input);
                    },
                    async invoke(
                      parameters: Record<string, unknown>,
                    ): Promise<unknown> {
                      const input = {
                        serviceId,
                        toolId,
                        parameters,
                      } satisfies InvokeInput;
                      return callAsync<unknown>(__cyrnel_invokeTool, input);
                    },
                  };
                },
              },
            ),
          };
        },
      },
    ),

    async discoverTools(input: ListToolInput): Promise<ListToolResult[]> {
      return callAsync<ListToolResult[]>(__cyrnel_discoverTools, input);
    },

    async discoverServices(
      input: ListServiceInput,
    ): Promise<ListServiceResult[]> {
      return callAsync<ListServiceResult[]>(__cyrnel_discoverServices, input);
    },
  };

  Object.defineProperty(globalThis, "cyrnel", {
    value: Object.freeze(cyrnel),
    enumerable: true,
    configurable: false,
    writable: false,
  });
})();
