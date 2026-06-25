import fs from "node:fs/promises";
import type {
  EnvironmentBindings,
  EnvironmentModule,
  EnvironmentSetupContext,
  ExecutionExitState,
  ExecutionInput,
  ExecutionOptions,
  InvokeInput,
  JSONSchema,
  ToolDocsInput,
} from "@cyrnel/sdk";
import ivm from "isolated-vm";
import ts from "typescript";

const DEFAULT_POOL_SIZE = 2;
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MEMORY_LIMIT_MB = 128;

const ENVIRONMENT_DOCS = `
Code runs as transpiled TypeScript/JavaScript (ES2022) inside an isolated
\`ivm\` sandbox. Each execution is wrapped in an async function, so top-level
\`await\` is supported. No module loading, filesystem access, networking,
Node.js APIs, or other host capabilities are available. Use only the provided
globals and write fully self-contained code.

## Globals

- \`cyrnel.output(data)\`: Emit the execution result. \`data\` must be a plain
  JSON-serializable object.

- \`await cyrnel.services[serviceId].tools[toolId].invoke(parameters)\`: Invoke
  a tool. \`parameters\` must satisfy the tool's \`inputSchema\`. Returns the
  tool's result.

## Aliases

- \`console.log(...args)\` writes to stdout.
- \`console.error(...args)\` writes to stderr.

Objects are pretty-printed as JSON; strings are written verbatim.

## Example

\`\`\`ts
const result = await cyrnel.services.weather.tools.forecast.invoke({
  city: "Accra",
});

cyrnel.output({ result });
\`\`\`
`;

type Interrupt = {
  promise: Promise<ExecutionExitState>;
  resolve: (state: ExecutionExitState) => void;
};

type ExecutionJob = {
  input: ExecutionInput;
  code: string;
  resolve: (state: ExecutionExitState) => void;
};

type RunningExecution = {
  eid: number;
  interrupt: Interrupt;
  timeoutHandle: ReturnType<typeof setTimeout> | null;
};

function getEffectiveTimeoutMs(options: ExecutionOptions | undefined): number {
  return options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
}

type TerminableIsolate = ivm.Isolate & {
  terminateExecution: () => Promise<void>;
};

type WorkerSlot = {
  isolate: TerminableIsolate;
  busy: boolean;
  running: RunningExecution | null;
};

function transpileTypeScript(code: string): string {
  const result = ts.transpileModule(code, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      strict: false,
    },
    reportDiagnostics: true,
  });

  if (result.diagnostics?.length) {
    const diagnostics = result.diagnostics
      .map((item) => ts.flattenDiagnosticMessageText(item.messageText, "\n"))
      .join("; ");
    throw new Error(`Failed to transpile TypeScript: ${diagnostics}`);
  }

  return result.outputText;
}

function assertSize(size: number, maxSize: number): void {
  if (size > maxSize) {
    throw new RangeError(
      `Text exceeds maximum size (${size} > ${maxSize} bytes)`,
    );
  }
}

export function toBuffer(data: unknown): Buffer {
  const MAX_BUFFER_SIZE = 4 * 1024 * 1024;

  if (Buffer.isBuffer(data)) {
    assertSize(data.byteLength, 4 * 1024 * 1024);
    return data;
  }

  if (typeof data === "string") {
    const size = Buffer.byteLength(data, "utf8");
    assertSize(size, MAX_BUFFER_SIZE);
    return Buffer.from(data, "utf8");
  }

  if (data instanceof Uint8Array) {
    assertSize(data.byteLength, MAX_BUFFER_SIZE);
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  }

  const text = String(data);
  const size = Buffer.byteLength(text, "utf8");

  assertSize(size, MAX_BUFFER_SIZE);

  return Buffer.from(text, "utf8");
}

function createInterrupt(): Interrupt {
  let settled = false;
  let resolve!: (state: ExecutionExitState) => void;
  const promise = new Promise<ExecutionExitState>((r) => {
    resolve = (state) => {
      if (settled) return;
      settled = true;
      r(state);
    };
  });
  return { promise, resolve };
}

function buildWrappedCode(code: string): string {
  return `async function __cyrnelMain__() {${code}}__cyrnelMain__();`;
}

function schemaTypeLabel(schema: JSONSchema | undefined): string {
  if (!schema || typeof schema !== "object") return "any";
  const t = schema.type;
  if (typeof t === "string") return t;
  if (Array.isArray(t) && t.length > 0)
    return t.filter((v) => typeof v === "string").join(" | ") || "any";
  if (schema.enum && Array.isArray(schema.enum)) return "enum";
  return "any";
}

function exampleValue(schema: JSONSchema | undefined): unknown {
  if (!schema || typeof schema !== "object") return null;
  if ("example" in schema && schema.example !== undefined)
    return schema.example;
  if (Array.isArray(schema.enum) && schema.enum.length > 0)
    return schema.enum[0];
  const t = Array.isArray(schema.type) ? schema.type[0] : schema.type;
  switch (t) {
    case "string":
      return "string";
    case "number":
    case "integer":
      return 0;
    case "boolean":
      return false;
    case "array":
      return [];
    case "object": {
      if (
        schema.properties &&
        typeof schema.properties === "object" &&
        !Array.isArray(schema.properties)
      ) {
        const out: Record<string, unknown> = {};
        for (const [name, prop] of Object.entries(
          schema.properties as Record<string, JSONSchema>,
        )) {
          out[name] = exampleValue(prop);
        }
        return out;
      }
      return {};
    }
    case "null":
      return null;
    default:
      return null;
  }
}

function renderProperties(schema: JSONSchema | undefined): string {
  if (
    !schema ||
    typeof schema !== "object" ||
    !schema.properties ||
    typeof schema.properties !== "object" ||
    Array.isArray(schema.properties)
  ) {
    return "_(no parameters)_";
  }

  const required = new Set<string>(
    Array.isArray(schema.required)
      ? (schema.required as unknown[]).filter(
          (v): v is string => typeof v === "string",
        )
      : [],
  );

  const entries = Object.entries(
    schema.properties as Record<string, JSONSchema>,
  );
  if (entries.length === 0) return "_(no parameters)_";

  return entries
    .map(([name, prop]) => {
      const type = schemaTypeLabel(prop);
      const tag = required.has(name) ? "required" : "optional";
      const description =
        prop && typeof prop === "object" && typeof prop.description === "string"
          ? ` ${prop.description}`
          : "";
      return `- \`${name}\` (${type}, ${tag})${description}`;
    })
    .join("\n");
}

function renderToolDocs(input: ToolDocsInput): string {
  const exampleInput = exampleValue(input.inputSchema) ?? {};
  const exampleJson = JSON.stringify(exampleInput, null, 2);
  const description = input.description.trim() || "_(no description)_";

  return `
  # Tool: \`${input.serviceId}.${input.toolId}\`

  ${description}

  ## Parameters

  ${renderProperties(input.inputSchema)}

  ## Returns

  Shape (\`outputSchema.type\`): \`${schemaTypeLabel(input.outputSchema)}\`

  ${renderProperties(input.outputSchema)}

  ## Example

  \`\`\`ts
  const result = await cyrnel.services.${input.serviceId}.tools.${input.toolId}.invoke(${exampleJson});
  cyrnel.output({ result });
  \`\`\`
  `;
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

class TypescriptIvmEnvironment implements EnvironmentModule {
  private bindings: EnvironmentBindings | null = null;
  private workers: WorkerSlot[] = [];
  private queue: ExecutionJob[] = [];
  private runningByEid = new Map<number, WorkerSlot>();
  private pumping = false;
  private shuttingDown = false;
  private isolatePreludeJs: string | null = null;

  async setup(context: EnvironmentSetupContext): Promise<void> {
    this.bindings = context.bindings;
    this.shuttingDown = false;
    this.isolatePreludeJs ??= await this.loadIsolatePreludeJs();

    if (this.workers.length === 0) {
      this.workers = Array.from({ length: DEFAULT_POOL_SIZE }, () =>
        this.createWorkerSlot(),
      );
    }
  }

  async teardown(): Promise<void> {
    this.shuttingDown = true;
    this.isolatePreludeJs = null;

    for (const job of this.queue.splice(0, this.queue.length)) {
      job.resolve("canceled");
    }

    const runningWorkers = Array.from(this.runningByEid.values());
    await Promise.all(
      runningWorkers.map(async (worker) => {
        worker.running?.interrupt.resolve("canceled");
        await this.terminateExecution(worker);
      }),
    );

    for (const worker of this.workers) {
      try {
        worker.isolate.dispose();
      } catch {}
    }

    this.workers = [];
    this.runningByEid.clear();
    this.queue = [];
    this.bindings = null;
  }

  async execute(input: ExecutionInput): Promise<ExecutionExitState> {
    if (!this.bindings) {
      throw new Error("Environment module is not setup");
    }

    if (this.shuttingDown) {
      return "canceled";
    }

    if (this.runningByEid.has(input.eid)) {
      throw new Error(`execution ${input.eid} is already running`);
    }

    if (this.queue.some((job) => job.input.eid === input.eid)) {
      throw new Error(`execution ${input.eid} is already queued`);
    }

    let code: string;

    try {
      code = transpileTypeScript(input.code);
    } catch (err) {
      this.bindings.setError(input.eid, errorMessage(err));
      return "failed";
    }

    this.bindings.setState(input.eid, "queued");

    return new Promise<ExecutionExitState>((resolve) => {
      this.queue.push({ input, code, resolve });
      void this.pumpQueue();
    });
  }

  async generateDocs(): Promise<string> {
    return ENVIRONMENT_DOCS;
  }

  async generateToolDocs(input: ToolDocsInput): Promise<string> {
    return renderToolDocs(input);
  }

  async kill(eid: number): Promise<void> {
    const queuedIndex = this.queue.findIndex((job) => job.input.eid === eid);

    if (queuedIndex >= 0) {
      const [job] = this.queue.splice(queuedIndex, 1);
      job.resolve("canceled");
      return;
    }

    const worker = this.runningByEid.get(eid);
    if (!worker?.running) return;

    worker.running.interrupt.resolve("canceled");
    await this.terminateExecution(worker);
  }

  private createWorkerSlot(): WorkerSlot {
    return {
      isolate: new ivm.Isolate({
        memoryLimit: DEFAULT_MEMORY_LIMIT_MB,
      }) as TerminableIsolate,
      busy: false,
      running: null,
    };
  }

  private async pumpQueue(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;

    try {
      while (!this.shuttingDown) {
        const worker = this.workers.find((slot) => !slot.busy);
        if (!worker) break;
        const job = this.queue.shift();
        if (!job) break;
        worker.busy = true;
        void this.runJob(worker, job);
      }
    } finally {
      this.pumping = false;
    }
  }

  private async runJob(worker: WorkerSlot, job: ExecutionJob): Promise<void> {
    let result: ExecutionExitState = "failed";
    const interrupt = createInterrupt();
    const running: RunningExecution = {
      eid: job.input.eid,
      interrupt,
      timeoutHandle: null,
    };

    worker.running = running;
    this.runningByEid.set(job.input.eid, worker);

    try {
      this.bindings?.setState(job.input.eid, "running");

      const effectiveTimeoutMs = getEffectiveTimeoutMs(job.input.options);
      const executionPromise = this.executeInIsolate(worker, job)
        .then(() => "success" as const)
        .catch((err) => {
          this.bindings?.setError(job.input.eid, errorMessage(err));
          return "failed" as const;
        });

      const timeoutPromise = new Promise<ExecutionExitState>((resolve) => {
        running.timeoutHandle = setTimeout(() => {
          void this.terminateExecution(worker);
          resolve("timeout");
        }, effectiveTimeoutMs);
      });

      result = await Promise.race([
        executionPromise,
        interrupt.promise,
        timeoutPromise,
      ]);
    } catch {
      result = "failed";
    } finally {
      if (running.timeoutHandle) {
        clearTimeout(running.timeoutHandle);
      }

      worker.running = null;
      worker.busy = false;
      this.runningByEid.delete(job.input.eid);
      job.resolve(result);

      void this.pumpQueue();
    }
  }

  private async executeInIsolate(
    worker: WorkerSlot,
    job: ExecutionJob,
  ): Promise<void> {
    if (!this.bindings) {
      throw new Error("Environment module is not setup");
    }

    const context = await worker.isolate.createContext();
    const jail = context.global;

    await jail.set("globalThis", jail.derefInto());

    const eid = job.input.eid;
    const bindings = this.bindings;

    await jail.set(
      "__cyrnel_emitStdout",
      new ivm.Reference((data: string) => {
        void bindings.emitStdout(eid, Buffer.from(data, "utf8"));
      }),
    );

    await jail.set(
      "__cyrnel_emitStderr",
      new ivm.Reference((data: string) => {
        void bindings.emitStderr(eid, Buffer.from(data, "utf8"));
      }),
    );

    await jail.set(
      "__cyrnel_emitOutput",
      new ivm.Reference((data: string) => {
        bindings.emitOutput(eid, JSON.parse(data) as Record<string, unknown>);
      }),
    );

    await jail.set(
      "__cyrnel_invokeTool",
      new ivm.Reference(async (jsonInput: string) => {
        const input = JSON.parse(jsonInput) as InvokeInput;
        const result = await bindings.invokeTool(input);
        return JSON.stringify(result);
      }),
    );

    const prelude = this.isolatePreludeJs ? `${this.isolatePreludeJs}\n` : "";
    const script = await worker.isolate.compileScript(
      buildWrappedCode(`${prelude}${job.code}`),
    );
    const result = await script.run(context);

    await Promise.resolve(result);
  }

  private async loadIsolatePreludeJs(): Promise<string | null> {
    try {
      const url = new URL("../src/bindings.ts", import.meta.url);
      const source = await fs.readFile(url, "utf8");
      return transpileTypeScript(source);
    } catch {
      return null;
    }
  }

  private async terminateExecution(worker: WorkerSlot): Promise<void> {
    try {
      worker.isolate.dispose();
      worker.isolate = new ivm.Isolate({
        memoryLimit: DEFAULT_MEMORY_LIMIT_MB,
      }) as TerminableIsolate;
    } catch {}
  }
}

export default {
  configSchema: {
    type: "object",
    properties: {
      poolSize: { type: "integer", minimum: 1 },
    },
    additionalProperties: false,
  },
  secretsSchema: { type: "null" },
  instantiate: () => new TypescriptIvmEnvironment(),
};
