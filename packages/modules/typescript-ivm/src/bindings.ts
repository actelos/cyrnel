(() => {
  interface IvmReference {
    applyIgnored(receiver: undefined, args: unknown[]): void;
    applySyncPromise(receiver: undefined, args: unknown[]): Promise<unknown>;
  }

  interface MciGlobals {
    __mci_emitStdout: IvmReference;
    __mci_emitStderr: IvmReference;
    __mci_emitOutput: IvmReference;
    __mci_getService: IvmReference;
    __mci_getTool: IvmReference;
    __mci_getToolDocs: IvmReference;
    __mci_invokeTool: IvmReference;
    __mci_discoverTools: IvmReference;
    __mci_discoverServices: IvmReference;
  }

  const mciGlobals = globalThis as typeof globalThis & MciGlobals;

  const __mci_emitStdout = mciGlobals.__mci_emitStdout;
  const __mci_emitStderr = mciGlobals.__mci_emitStderr;
  const __mci_emitOutput = mciGlobals.__mci_emitOutput;
  const __mci_getService = mciGlobals.__mci_getService;
  const __mci_getTool = mciGlobals.__mci_getTool;
  const __mci_getToolDocs = mciGlobals.__mci_getToolDocs;
  const __mci_invokeTool = mciGlobals.__mci_invokeTool;
  const __mci_discoverTools = mciGlobals.__mci_discoverTools;
  const __mci_discoverServices = mciGlobals.__mci_discoverServices;

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
    __mci_emitStdout.applyIgnored(undefined, [message]);
  };

  console.error = (...args: unknown[]) => {
    const message = `${formatConsoleArgs(...args)}\n`;
    __mci_emitStderr.applyIgnored(undefined, [message]);
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

  const mci = {
    output(data: Record<string, unknown>): void {
      __mci_emitOutput.applyIgnored(undefined, [JSON.stringify(data)]);
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
              return callAsync<ServiceDetails>(__mci_getService, serviceId);
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
                      return callAsync<ToolDetails>(__mci_getTool, input);
                    },
                    async getDocs(): Promise<string> {
                      const input = {
                        serviceId,
                        toolId,
                      } satisfies GetToolInput;
                      return callAsyncText(__mci_getToolDocs, input);
                    },
                    async invoke(
                      parameters: Record<string, unknown>,
                    ): Promise<unknown> {
                      const input = {
                        serviceId,
                        toolId,
                        parameters,
                      } satisfies InvokeInput;
                      return callAsync<unknown>(__mci_invokeTool, input);
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
      return callAsync<ListToolResult[]>(__mci_discoverTools, input);
    },

    async discoverServices(
      input: ListServiceInput,
    ): Promise<ListServiceResult[]> {
      return callAsync<ListServiceResult[]>(__mci_discoverServices, input);
    },
  };

  Object.defineProperty(globalThis, "mci", {
    value: Object.freeze(mci),
    enumerable: true,
    configurable: false,
    writable: false,
  });
})();
