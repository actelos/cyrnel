import fs from "node:fs/promises";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
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
const DEFAULT_MAX_QUEUE_SIZE = 100;
const DEFAULT_QUEUE_TTL_MS = 60_000;
const DEFAULT_MAX_CODE_SIZE = 100 * 1024;
const TRANSPILE_TIMEOUT_MS = 10_000;

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
  queuedAt: number;
  resolve: (state: ExecutionExitState) => void;
};

type RunningExecution = {
  eid: number;
  interrupt: Interrupt;
  timeoutHandle: ReturnType<typeof setTimeout> | null;
};

function getEffectiveTimeoutMs(
  options: ExecutionOptions | undefined,
  defaultMs: number,
): number {
  return options?.timeoutMs ?? defaultMs;
}

type TerminableIsolate = ivm.Isolate & {
  terminateExecution: () => Promise<void>;
};

type WorkerSlot = {
  isolate: TerminableIsolate;
  busy: boolean;
  running: RunningExecution | null;
};

class BoundedQueue<T> {
  private items: T[];
  readonly max: number;

  constructor(maxSize: number) {
    this.max = maxSize;
    this.items = [];
  }

  get length(): number {
    return this.items.length;
  }

  get isFull(): boolean {
    return this.items.length >= this.max;
  }

  enqueue(item: T): boolean {
    if (this.isFull) return false;
    this.items.push(item);
    return true;
  }

  dequeue(): T | undefined {
    return this.items.shift();
  }

  find(predicate: (item: T) => boolean): T | undefined {
    return this.items.find(predicate);
  }

  remove(predicate: (item: T) => boolean): T | undefined {
    const index = this.items.findIndex(predicate);
    if (index < 0) return undefined;
    return this.items.splice(index, 1)[0];
  }

  drain(): T[] {
    return this.items.splice(0);
  }
}

function transpileWorkerCode(): string {
  return [
    `const { parentPort, workerData } = await import("worker_threads");`,
    `const { code, typescriptUrl } = workerData;`,
    `try {`,
    `  const tsMod = await import(typescriptUrl);`,
    `  const ts = tsMod.default || tsMod;`,
    `  const result = ts.transpileModule(code, {`,
    `    compilerOptions: {`,
    `      target: ts.ScriptTarget.ES2022,`,
    `      module: ts.ModuleKind.ESNext,`,
    `      strict: false,`,
    `    },`,
    `    reportDiagnostics: true,`,
    `  });`,
    `  if (result.diagnostics && result.diagnostics.length) {`,
    `    const diagnostics = result.diagnostics`,
    `      .map((item) => ts.flattenDiagnosticMessageText(item.messageText, "\\n"))`,
    `      .join("; ");`,
    `    parentPort.postMessage({ error: "Failed to transpile TypeScript: " + diagnostics });`,
    `    return;`,
    `  }`,
    `  parentPort.postMessage({ outputText: result.outputText });`,
    `} catch (err) {`,
    `  parentPort.postMessage({ error: String(err) });`,
    `}`,
  ].join("\n");
}

let _tsUrl: string | null = null;
function getTypescriptUrl(): string {
  if (!_tsUrl) {
    const _require = createRequire(import.meta.url);
    _tsUrl = pathToFileURL(_require.resolve("typescript")).href;
  }
  return _tsUrl;
}

function transpileTypeScriptSync(code: string): string {
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

function isTestEnv(): boolean {
  return typeof process !== "undefined" && process.env.VITEST === "true";
}

async function transpileTypeScript(code: string): Promise<string> {
  if (isTestEnv()) {
    return transpileTypeScriptSync(code);
  }

  const worker = new Worker(transpileWorkerCode(), {
    eval: true,
    workerData: { code, typescriptUrl: getTypescriptUrl() },
  });

  const timer = setTimeout(() => {
    worker.terminate();
  }, TRANSPILE_TIMEOUT_MS);

  return new Promise<string>((resolve, reject) => {
    let settled = false;

    worker.on("message", (msg: unknown) => {
      if (settled) return;
      const data = msg as { outputText?: string; error?: string };
      settled = true;
      clearTimeout(timer);
      if (data.error) {
        reject(new Error(data.error));
      } else if (data.outputText) {
        resolve(data.outputText);
      }
      void worker.terminate();
    });

    worker.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });

    worker.on("exit", (exitCode) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`Transpilation worker exited with code ${exitCode}`));
    });
  });
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
  private queue: BoundedQueue<ExecutionJob> = new BoundedQueue(
    DEFAULT_MAX_QUEUE_SIZE,
  );
  private runningByEid = new Map<number, WorkerSlot>();
  private pumping = false;
  private shuttingDown = false;
  private isolatePreludeJs: string | null = null;
  private defaultTimeoutMs: number = DEFAULT_TIMEOUT_MS;
  private memoryLimitMb: number = DEFAULT_MEMORY_LIMIT_MB;
  private maxQueueSize: number = DEFAULT_MAX_QUEUE_SIZE;
  private queueTtlMs: number = DEFAULT_QUEUE_TTL_MS;
  private maxCodeSizeBytes: number = DEFAULT_MAX_CODE_SIZE;

  async setup(context: EnvironmentSetupContext): Promise<void> {
    this.bindings = context.bindings;
    this.shuttingDown = false;
    this.isolatePreludeJs ??= await this.loadIsolatePreludeJs();

    this.defaultTimeoutMs =
      typeof context.config.timeoutMs === "number" &&
      Number.isInteger(context.config.timeoutMs) &&
      context.config.timeoutMs >= 1
        ? context.config.timeoutMs
        : DEFAULT_TIMEOUT_MS;

    this.memoryLimitMb =
      typeof context.config.memoryLimitMb === "number" &&
      Number.isInteger(context.config.memoryLimitMb) &&
      context.config.memoryLimitMb >= 16
        ? context.config.memoryLimitMb
        : DEFAULT_MEMORY_LIMIT_MB;

    this.maxQueueSize =
      typeof context.config.maxQueueSize === "number" &&
      Number.isInteger(context.config.maxQueueSize) &&
      context.config.maxQueueSize >= 1
        ? context.config.maxQueueSize
        : DEFAULT_MAX_QUEUE_SIZE;

    this.queueTtlMs =
      typeof context.config.queueTtlMs === "number" &&
      Number.isInteger(context.config.queueTtlMs) &&
      context.config.queueTtlMs >= 1
        ? context.config.queueTtlMs
        : DEFAULT_QUEUE_TTL_MS;

    this.maxCodeSizeBytes =
      typeof context.config.maxCodeSizeBytes === "number" &&
      Number.isInteger(context.config.maxCodeSizeBytes) &&
      context.config.maxCodeSizeBytes >= 1024
        ? context.config.maxCodeSizeBytes
        : DEFAULT_MAX_CODE_SIZE;

    this.queue = new BoundedQueue(this.maxQueueSize);

    if (this.workers.length === 0) {
      const poolSize =
        typeof context.config.poolSize === "number" &&
        Number.isInteger(context.config.poolSize) &&
        context.config.poolSize >= 1
          ? context.config.poolSize
          : DEFAULT_POOL_SIZE;

      this.workers = Array.from({ length: poolSize }, () =>
        this.createWorkerSlot(),
      );
    }
  }

  async teardown(): Promise<void> {
    this.shuttingDown = true;
    this.isolatePreludeJs = null;

    for (const job of this.queue.drain()) {
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
    this.queue = new BoundedQueue(DEFAULT_MAX_QUEUE_SIZE);
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

    if (this.queue.find((job) => job.input.eid === input.eid)) {
      throw new Error(`execution ${input.eid} is already queued`);
    }

    if (this.queue.isFull) {
      throw new Error(
        `Execution queue is full (max ${this.maxQueueSize} pending).`,
      );
    }

    const codeSizeBytes = Buffer.byteLength(input.code, "utf8");
    if (codeSizeBytes > this.maxCodeSizeBytes) {
      this.bindings.setError(
        input.eid,
        `Code exceeds maximum size (${codeSizeBytes} > ${this.maxCodeSizeBytes} bytes).`,
      );
      return "failed";
    }

    let code: string;

    try {
      code = await transpileTypeScript(input.code);
    } catch (err) {
      this.bindings.setError(input.eid, errorMessage(err));
      return "failed";
    }

    this.bindings.setState(input.eid, "queued");

    return new Promise<ExecutionExitState>((resolve) => {
      this.queue.enqueue({ input, code, queuedAt: Date.now(), resolve });
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
    const job = this.queue.remove((j) => j.input.eid === eid);

    if (job) {
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
        memoryLimit: this.memoryLimitMb,
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

        const job = this.queue.dequeue();
        if (!job) break;

        if (Date.now() - job.queuedAt > this.queueTtlMs) {
          job.resolve("canceled");
          continue;
        }

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

      const effectiveTimeoutMs = getEffectiveTimeoutMs(
        job.input.options,
        this.defaultTimeoutMs,
      );
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

    const refs: ivm.Reference[] = [];

    try {
      const refStdout = new ivm.Reference((data: string) => {
        void bindings.emitStdout(eid, Buffer.from(data, "utf8"));
      });
      refs.push(refStdout);
      await jail.set("__cyrnel_emitStdout", refStdout);

      const refStderr = new ivm.Reference((data: string) => {
        void bindings.emitStderr(eid, Buffer.from(data, "utf8"));
      });
      refs.push(refStderr);
      await jail.set("__cyrnel_emitStderr", refStderr);

      const refOutput = new ivm.Reference((data: string) => {
        bindings.emitOutput(eid, JSON.parse(data) as Record<string, unknown>);
      });
      refs.push(refOutput);
      await jail.set("__cyrnel_emitOutput", refOutput);

      const refInvoke = new ivm.Reference(async (jsonInput: string) => {
        const input = JSON.parse(jsonInput) as InvokeInput;
        const result = await bindings.invokeTool(input);
        return JSON.stringify(result);
      });
      refs.push(refInvoke);
      await jail.set("__cyrnel_invokeTool", refInvoke);

      const prelude = this.isolatePreludeJs ? `${this.isolatePreludeJs}\n` : "";
      const script = await worker.isolate.compileScript(
        buildWrappedCode(`${prelude}${job.code}`),
      );
      const result = await script.run(context);

      await Promise.resolve(result);
    } finally {
      for (const ref of refs) {
        try {
          ref.release();
        } catch {}
      }

      try {
        context.release();
      } catch {}
    }
  }

  private async loadIsolatePreludeJs(): Promise<string | null> {
    try {
      const url = new URL("../src/bindings.ts", import.meta.url);
      const source = await fs.readFile(url, "utf8");
      return await transpileTypeScript(source);
    } catch {
      return null;
    }
  }

  private async terminateExecution(worker: WorkerSlot): Promise<void> {
    try {
      worker.isolate.dispose();
      worker.isolate = new ivm.Isolate({
        memoryLimit: this.memoryLimitMb,
      }) as TerminableIsolate;
    } catch {}
  }
}

export default {
  configSchema: {
    type: "object",
    properties: {
      poolSize: { type: "integer", minimum: 1 },
      maxQueueSize: { type: "integer", minimum: 1 },
      queueTtlMs: { type: "integer", minimum: 1 },
      maxCodeSizeBytes: { type: "integer", minimum: 1024 },
      timeoutMs: { type: "integer", minimum: 1 },
      memoryLimitMb: { type: "integer", minimum: 16 },
    },
    additionalProperties: false,
  },
  secretsSchema: { type: "null" },
  instantiate: () => new TypescriptIvmEnvironment(),
};
