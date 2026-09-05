import { randomBytes, randomUUID } from "node:crypto";
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
  InvokeInput,
  JSONSchema,
  ToolDocsInput,
} from "@cyrnel/sdk";
import { build } from "esbuild";
import ivm from "isolated-vm";
import ts from "typescript";

const DEFAULT_POOL_SIZE = 2;
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MEMORY_LIMIT_MB = 128;
const DEFAULT_MAX_QUEUE_SIZE = 100;
const DEFAULT_QUEUE_TTL_MS = 60_000;
const DEFAULT_MAX_CODE_SIZE = 100 * 1024;
const TRANSPILE_TIMEOUT_MS = 10_000;

const MAX_TIMER_DELAY_MS = 60_000;
const MAX_CONCURRENT_TIMERS = 16;
const MAX_RANDOM_BYTES = 65_536;

const BINDINGS_KEYS = [
  "base64",
  "textCodecs",
  "url",
  "timers",
  "randomValues",
  "fullConsole",
] as const;

type BindingsKey = (typeof BINDINGS_KEYS)[number];

type BindingsConfig = Record<BindingsKey, boolean>;

const BINDINGS_DEFAULTS: BindingsConfig = {
  base64: false,
  textCodecs: false,
  url: false,
  timers: false,
  randomValues: false,
  fullConsole: false,
};

function parseBindingsConfig(config: Record<string, unknown>): BindingsConfig {
  const raw = config.bindings;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ...BINDINGS_DEFAULTS };
  }
  const out = { ...BINDINGS_DEFAULTS };
  for (const key of BINDINGS_KEYS) {
    const value = (raw as Record<string, unknown>)[key];
    if (typeof value === "boolean") {
      out[key] = value;
    }
  }
  if (out.url) {
    out.textCodecs = true;
  }
  return out;
}

const ENVIRONMENT_DOCS_CORE = `
Code runs as transpiled TypeScript/JavaScript (ES2022) inside an isolated
\`ivm\` sandbox. Each execution is wrapped in an async function, so top-level
\`await\` is supported. No module loading, filesystem access, networking,
Node.js APIs, or other host capabilities are available unless explicitly
listed as an enabled binding below. Use only the provided globals and write
fully self-contained code.

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

## Per-execution configuration (\`envConfig\`)

When creating a process you can pass an \`envConfig\` object to override
environment defaults for that execution:

| Key | Type | Default | Description |
| --- | --- | ------- | ----------- |
| \`timeoutMs\` | \`integer\` (>= 1) | 30000 | Sandbox execution timeout in milliseconds. |
| \`memoryLimitMb\` | \`integer\` (>= 16) | 128 | Per-execution memory limit in megabytes. |

Example:

\`\`\`ts
envConfig: { timeoutMs: 10000, memoryLimitMb: 256 }
\`\`\`

## Example

\`\`\`ts
const result = await cyrnel.services.weather.tools.forecast.invoke({
  city: "Accra",
});

cyrnel.output({ result });
\`\`\`
`;

const BINDING_DOCS: Record<
  BindingsKey,
  { apis: string; description: string; risk: string }
> = {
  base64: {
    apis: "btoa(str), atob(str)",
    description:
      "Base64 encode/decode of Latin-1 strings. btoa throws on characters above U+00FF.",
    risk: "Low. Can obfuscate data in output; exposes no host capability.",
  },
  textCodecs: {
    apis: "TextEncoder, TextDecoder",
    description:
      "UTF-8 encoding/decoding between strings and Uint8Array (encode/decode only; no encodeInto or stream support).",
    risk: "Low. Enables binary payload construction; nothing can leave the sandbox beyond the normal output channel.",
  },
  url: {
    apis: "URL, URLSearchParams",
    description:
      "WHATWG-compliant URL parsing and search-parameter handling. Implies the textCodecs binding (WHATWG URL internally needs TextEncoder/TextDecoder).",
    risk: "Low. Pure string parsing; only becomes sensitive if a networking binding is ever added.",
  },
  timers: {
    apis: "setTimeout(cb, ms), setInterval(cb, ms), clearTimeout(id), clearInterval(id), queueMicrotask(cb)",
    description:
      "Schedule callbacks. Host-supervised: max delay 60000ms, max 16 concurrent per execution. Timers are cleared when the execution function returns or is terminated - only awaited timers keep the execution alive.",
    risk: "Moderate. Sleep/busy patterns occupy pool slots until the host timeout kills the isolate; runaway intervals can flood output. Caps are enforced by the host.",
  },
  randomValues: {
    apis: "crypto.getRandomValues(typedArray), crypto.randomUUID()",
    description:
      "Cryptographically secure random bytes and UUIDs sourced from the host.",
    risk: "Low. Consumes host entropy; enables random state that can be fed into tool calls.",
  },
  fullConsole: {
    apis: "console.warn/info/debug/table/trace/time/count/group/assert and other methods",
    description:
      "Routes all remaining console methods to stdout, prefixed with the method name.",
    risk: "Low. Log flooding can bloat output buffers.",
  },
};

function renderBindingSection(
  config: BindingsConfig,
  enabled: boolean,
): string {
  const keys = BINDINGS_KEYS.filter((key) => config[key] === enabled);
  if (keys.length === 0) return "";

  const title = enabled
    ? "## Enabled optional bindings (operator-configured)"
    : "## Optional bindings (currently disabled)";

  const lines = keys.map((key) => {
    const doc = BINDING_DOCS[key];
    if (enabled) {
      return `- **${key}**: \`${doc.apis}\`. ${doc.description} Risk if misused: ${doc.risk}`;
    }
    return `- **${key}**: \`${doc.apis}\`. Not enabled; calling these will fail.`;
  });

  return `${title}

${lines.join("\n")}
`;
}

function buildEnvironmentDocs(config: BindingsConfig): string {
  const disabledKeys = BINDINGS_KEYS.filter((key) => !config[key]);

  const unavailable = [
    "Node.js APIs: process, Buffer, require, module, exports, __dirname, __filename",
    "Networking: fetch, WebSocket, XMLHttpRequest, Headers, Request, Response, Blob, FormData, EventSource",
    "Filesystem access, environment variables, and all other host capabilities",
    ...disabledKeys.map((key) => {
      const doc = BINDING_DOCS[key];
      return `${doc.apis} (${key} binding disabled)`;
    }),
  ];

  return `${ENVIRONMENT_DOCS_CORE}

${renderBindingSection(config, true)}
${renderBindingSection(config, false)}
## Unavailable APIs

The following are NOT available in this environment:

${unavailable.map((line) => `- ${line}`).join("\n")}
`;
}

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
  effectiveTimeoutMs?: number;
  startTime?: number;
};

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
    `(async () => {`,
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
    `})();`,
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

let _urlBundlePromise: Promise<string> | null = null;
function getUrlPolyfillBundle(): Promise<string> {
  _urlBundlePromise ??= (async () => {
    const _require = createRequire(import.meta.url);
    const result = await build({
      entryPoints: [_require.resolve("whatwg-url")],
      bundle: true,
      format: "iife",
      globalName: "__cyrnelUrlModule",
      platform: "neutral",
      mainFields: ["main"],
      target: ["es2022"],
      write: false,
      logLevel: "silent",
      footer: {
        js: `if (typeof globalThis !== "undefined") { globalThis.URL = __cyrnelUrlModule.URL; globalThis.URLSearchParams = __cyrnelUrlModule.URLSearchParams; }`,
      },
    });
    return result.outputFiles[0].text;
  })();
  return _urlBundlePromise;
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
    assertSize(data.byteLength, MAX_BUFFER_SIZE);
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

function escapePlainText(text: string): string {
  return text.replace(/\s+/g, " ").replace(/[\\*_`[\]<>#]/g, "\\$&");
}

function renderToolDocs(input: ToolDocsInput): string {
  const exampleInput = exampleValue(input.inputSchema) ?? {};
  const exampleJson = JSON.stringify(exampleInput, null, 2);
  const description = input.description.trim() || "_(no description)_";
  const summary = input.summary?.trim();

  return `
  # Tool: \`${input.serviceId}.${input.toolId}\`

  ${summary ? `_${escapePlainText(summary)}_` : ""}

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
  private logger: EnvironmentSetupContext["logger"] | null = null;
  private workers: WorkerSlot[] = [];
  private queue: BoundedQueue<ExecutionJob> = new BoundedQueue(
    DEFAULT_MAX_QUEUE_SIZE,
  );
  private runningByEid = new Map<number, WorkerSlot>();
  private pumping = false;
  private shuttingDown = false;
  private isolatePreludeJs: string | null = null;
  private preludeCache = new Map<string, string>();
  private bindingsConfig: BindingsConfig = { ...BINDINGS_DEFAULTS };
  private defaultTimeoutMs: number = DEFAULT_TIMEOUT_MS;
  private memoryLimitMb: number = DEFAULT_MEMORY_LIMIT_MB;
  private maxQueueSize: number = DEFAULT_MAX_QUEUE_SIZE;
  private queueTtlMs: number = DEFAULT_QUEUE_TTL_MS;
  private maxCodeSizeBytes: number = DEFAULT_MAX_CODE_SIZE;
  private suspendedEids = new Set<number>();
  private suspendTimeouts = new Map<
    number,
    { remainingMs: number; effectiveTimeoutMs: number }
  >();

  async setup(context: EnvironmentSetupContext): Promise<void> {
    this.bindings = context.bindings;
    const patterns =
      (context.config.redactionPatterns as string[] | undefined) ?? [];
    this.logger = context.logger?.redact(patterns).child({
      phase: "environment-setup",
    });
    this.shuttingDown = false;
    this.bindingsConfig = parseBindingsConfig(context.config);
    this.isolatePreludeJs = await this.loadIsolatePreludeJs(
      this.bindingsConfig,
    );

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
    this.logger?.info(
      { event: "environment-teardown-started" },
      "Tearing down environment",
    );
    this.shuttingDown = true;
    this.isolatePreludeJs = null;
    this.preludeCache.clear();

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
    this.logger?.info(
      { event: "environment-teardown-complete" },
      "Environment teardown complete",
    );
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
    return buildEnvironmentDocs(this.bindingsConfig);
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

  async suspend(eid: number): Promise<void> {
    const worker = this.runningByEid.get(eid);
    if (!worker?.running) return;
    if (this.suspendedEids.has(eid)) return;
    if (worker.running.timeoutHandle) {
      clearTimeout(worker.running.timeoutHandle);
      const elapsed = Date.now() - (worker.running.startTime ?? Date.now());
      const remaining = Math.max(
        0,
        (worker.running.effectiveTimeoutMs ?? this.defaultTimeoutMs) - elapsed,
      );
      this.suspendTimeouts.set(eid, {
        remainingMs: remaining,
        effectiveTimeoutMs:
          worker.running.effectiveTimeoutMs ?? this.defaultTimeoutMs,
      });
      worker.running.timeoutHandle = null;
    }
    this.suspendedEids.add(eid);
  }

  async resume(eid: number, remainingMs?: number): Promise<void> {
    const worker = this.runningByEid.get(eid);
    if (!worker?.running) return;
    if (!this.suspendedEids.has(eid)) return;
    this.suspendedEids.delete(eid);
    if (worker.running.timeoutHandle)
      clearTimeout(worker.running.timeoutHandle);
    const suspendInfo = this.suspendTimeouts.get(eid);
    const timeoutMs =
      remainingMs ?? suspendInfo?.remainingMs ?? this.defaultTimeoutMs;
    this.suspendTimeouts.delete(eid);
    worker.running.startTime = Date.now();
    worker.running.effectiveTimeoutMs = timeoutMs;
    worker.running.timeoutHandle = setTimeout(() => {
      void this.terminateExecution(worker);
      worker.running?.interrupt.resolve("timeout" as ExecutionExitState);
    }, timeoutMs);
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
    let result: ExecutionExitState;
    const interrupt = createInterrupt();
    const executionLogger = this.logger?.child({
      executionId: job.input.eid,
      phase: "execution",
    });
    const running: RunningExecution = {
      eid: job.input.eid,
      interrupt,
      timeoutHandle: null,
      effectiveTimeoutMs: undefined,
      startTime: Date.now(),
    };

    worker.running = running;
    this.runningByEid.set(job.input.eid, worker);

    let _isolateOverridden = false;

    try {
      this.bindings?.setState(job.input.eid, "running");
      executionLogger?.info(
        { event: "execution-started" },
        "Starting environment execution",
      );

      const rawTimeoutMs = job.input.envConfig?.timeoutMs as number | undefined;
      const effectiveTimeoutMs: number =
        typeof rawTimeoutMs === "number" &&
        Number.isInteger(rawTimeoutMs) &&
        rawTimeoutMs >= 1
          ? rawTimeoutMs
          : this.defaultTimeoutMs;
      const rawMemoryLimitMb = job.input.envConfig?.memoryLimitMb as
        | number
        | undefined;
      const effectiveMemoryLimitMb: number =
        typeof rawMemoryLimitMb === "number" &&
        Number.isInteger(rawMemoryLimitMb) &&
        rawMemoryLimitMb >= 16
          ? rawMemoryLimitMb
          : this.memoryLimitMb;
      if (effectiveMemoryLimitMb !== this.memoryLimitMb) {
        worker.isolate.dispose();
        worker.isolate = new ivm.Isolate({
          memoryLimit: effectiveMemoryLimitMb,
        }) as TerminableIsolate;
        _isolateOverridden = true;
      }
      running.effectiveTimeoutMs = effectiveTimeoutMs;
      running.startTime = Date.now();
      const executionPromise = this.executeInIsolate(
        worker,
        job,
        executionLogger,
      )
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
    }

    if (running.timeoutHandle) {
      clearTimeout(running.timeoutHandle);
    }

    if (_isolateOverridden) {
      worker.isolate.dispose();
      worker.isolate = new ivm.Isolate({
        memoryLimit: this.memoryLimitMb,
      }) as TerminableIsolate;
    }

    worker.running = null;
    worker.busy = false;
    this.runningByEid.delete(job.input.eid);
    executionLogger?.info(
      { event: "execution-complete", exitState: result },
      "Environment execution complete",
    );
    job.resolve(result);

    void this.pumpQueue();
  }

  private async executeInIsolate(
    worker: WorkerSlot,
    job: ExecutionJob,
    executionLogger?: EnvironmentSetupContext["logger"],
  ): Promise<void> {
    if (!this.bindings) {
      throw new Error("Environment module is not setup");
    }

    const context = await worker.isolate.createContext();
    const jail = context.global;

    await jail.set("globalThis", jail.derefInto());

    const eid = job.input.eid;
    const bindings = this.bindings;
    const config = this.bindingsConfig;

    const refs: ivm.Reference[] = [];
    let clearTimers: (() => void) | null = null;

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
        let input: InvokeInput;
        try {
          input = JSON.parse(jsonInput) as InvokeInput;
        } catch {
          return JSON.stringify({
            __cyrnel_error: "Invalid invoke input JSON",
          });
        }
        const dispatchLogger = executionLogger?.child({
          dispatchId: randomUUID(),
          serviceId: input.serviceId,
          toolId: input.toolId,
          phase: "dispatch",
        });
        dispatchLogger?.info(
          { event: "dispatch-started" },
          "Dispatching tool invocation",
        );
        try {
          const enriched = {
            ...input,
            eid: job.input.eid,
            ...(job.input.processId !== undefined && {
              processId: job.input.processId,
            }),
          } as InvokeInput & { processId?: number; eid: number };
          const result = await bindings.invokeTool(enriched);
          dispatchLogger?.info(
            { event: "dispatch-complete" },
            "Tool invocation complete",
          );
          return JSON.stringify(result);
        } catch (err) {
          dispatchLogger?.error(
            { event: "dispatch-failed", err },
            "Tool invocation failed",
          );
          return JSON.stringify({
            __ivmError: String(err),
            __ivmStack: err instanceof Error ? err.stack : undefined,
          });
        }
      });
      refs.push(refInvoke);
      await jail.set("__cyrnel_invokeTool", refInvoke);

      if (config.randomValues) {
        const refRandomBytes = new ivm.Reference((json: string) => {
          const input = JSON.parse(json) as {
            kind: "bytes" | "uuid";
            length?: number;
          };
          if (input.kind === "uuid") {
            return JSON.stringify(randomUUID());
          }
          const length = Math.min(
            Math.max(0, Math.floor(Number(input.length) || 0)),
            MAX_RANDOM_BYTES,
          );
          return JSON.stringify(Array.from(randomBytes(length)));
        });
        refs.push(refRandomBytes);
        await jail.set("__cyrnel_randomBytes", refRandomBytes);
      }

      if (config.timers) {
        const timerRegistry = new Map<
          number,
          { timer: NodeJS.Timeout; repeat: boolean }
        >();
        let nextTimerId = 1;

        const refSetTimer = new ivm.Reference((json: string) => {
          const input = JSON.parse(json) as {
            delay: number;
            repeat: boolean;
          };
          const delay = Math.floor(Number(input.delay) || 0);
          if (!Number.isFinite(delay) || delay < 0) {
            throw new Error("Invalid timer delay");
          }
          if (delay > MAX_TIMER_DELAY_MS) {
            throw new RangeError(
              `Timer delay exceeds maximum (${delay} > ${MAX_TIMER_DELAY_MS}ms)`,
            );
          }
          if (timerRegistry.size >= MAX_CONCURRENT_TIMERS) {
            throw new Error(
              `Timer limit reached (max ${MAX_CONCURRENT_TIMERS} per execution)`,
            );
          }

          const id = nextTimerId++;
          const fire = (): void => {
            void context
              .eval(`globalThis.__cyrnel_timerDispatch(${id})`)
              .catch(() => {});
            const entry = timerRegistry.get(id);
            if (entry?.repeat) {
              entry.timer = setTimeout(fire, delay);
            } else {
              timerRegistry.delete(id);
            }
          };
          timerRegistry.set(id, {
            timer: setTimeout(fire, delay),
            repeat: input.repeat,
          });
          return id;
        });
        refs.push(refSetTimer);
        await jail.set("__cyrnel_setTimer", refSetTimer);

        const refClearTimer = new ivm.Reference((json: string) => {
          const id = Number(json);
          const entry = timerRegistry.get(id);
          if (entry) {
            clearTimeout(entry.timer);
            timerRegistry.delete(id);
          }
        });
        refs.push(refClearTimer);
        await jail.set("__cyrnel_clearTimer", refClearTimer);

        clearTimers = () => {
          for (const entry of timerRegistry.values()) {
            clearTimeout(entry.timer);
          }
          timerRegistry.clear();
        };
      }

      const prelude = this.isolatePreludeJs ? `${this.isolatePreludeJs}\n` : "";
      const script = await worker.isolate.compileScript(
        buildWrappedCode(`${prelude}${job.code}`),
      );
      const result = await script.run(context, { promise: true });

      await Promise.resolve(result);
    } finally {
      clearTimers?.();

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

  private async loadIsolatePreludeJs(config: BindingsConfig): Promise<string> {
    const key = JSON.stringify(config);
    const cached = this.preludeCache.get(key);
    if (cached) return cached;

    const parts: string[] = [await this.loadPreludeSource("bindings.ts")];
    if (config.base64) {
      parts.push(await this.loadPreludeSource("polyfills/base64.ts"));
    }
    if (config.textCodecs) {
      parts.push(await this.loadPreludeSource("polyfills/text-codecs.ts"));
    }
    if (config.fullConsole) {
      parts.push(await this.loadPreludeSource("polyfills/console.ts"));
    }
    if (config.timers) {
      parts.push(await this.loadPreludeSource("polyfills/queue-microtask.ts"));
      parts.push(await this.loadPreludeSource("polyfills/timers.ts"));
    }
    if (config.randomValues) {
      parts.push(await this.loadPreludeSource("polyfills/random-values.ts"));
    }
    if (config.url) {
      parts.push(await getUrlPolyfillBundle());
    }

    const prelude = parts.join("\n");
    this.preludeCache.set(key, prelude);
    return prelude;
  }

  private async loadPreludeSource(relative: string): Promise<string> {
    const candidates = [
      new URL(`../src/${relative}`, import.meta.url),
      new URL(relative.replace(/\.ts$/, ".js"), import.meta.url),
    ];
    for (const url of candidates) {
      try {
        const source = await fs.readFile(url, "utf8");
        return await transpileTypeScript(source);
      } catch {}
    }
    throw new Error(`Failed to load prelude source: ${relative}`);
  }

  private async terminateExecution(worker: WorkerSlot): Promise<void> {
    const eid = worker.running?.eid;
    if (eid !== undefined) {
      this.suspendedEids.delete(eid);
      this.suspendTimeouts.delete(eid);
    }

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
      memoryLimitMb: { type: "integer", minimum: 16 },
      redactionPatterns: {
        type: "array",
        items: { type: "string" },
        description:
          "Additional redaction path patterns merged with the host-enforced baseline for this module's logs",
      },
      bindings: {
        type: "object",
        description:
          "Opt-in sandbox bindings that expose extra Web/Browser-standard globals. All bindings are disabled by default; enabling url also implies textCodecs.",
        properties: {
          base64: {
            type: "boolean",
            description:
              "Expose btoa(str)/atob(str) for Base64 encode/decode of Latin-1 strings. Low risk; obfuscates data in output only.",
          },
          textCodecs: {
            type: "boolean",
            description:
              "Expose TextEncoder/TextDecoder for UTF-8 encode/decode between strings and Uint8Array. Low risk.",
          },
          url: {
            type: "boolean",
            description:
              "Expose URL/URLSearchParams for WHATWG URL parsing. Implies textCodecs. Low risk; pure string parsing.",
          },
          timers: {
            type: "boolean",
            description:
              "Expose setTimeout/setInterval/clearTimeout/clearInterval/queueMicrotask, host-supervised (max 60000ms delay, 16 concurrent). Moderate risk; occupies pool slots until timeout.",
          },
          randomValues: {
            type: "boolean",
            description:
              "Expose crypto.getRandomValues()/crypto.randomUUID() sourced from the host. Low risk; consumes host entropy.",
          },
          fullConsole: {
            type: "boolean",
            description:
              "Route all remaining console methods (warn/info/debug/table/trace/time/count/group/assert) to stdout. Low risk; log flooding.",
          },
        },
        additionalProperties: false,
      },
    },
    additionalProperties: false,
  },
  secretsSchema: { type: "null" },
  instantiate: () => new TypescriptIvmEnvironment(),
};
