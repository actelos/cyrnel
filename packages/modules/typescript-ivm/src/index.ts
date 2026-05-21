import fs from "node:fs/promises";
import type {
  DiscoverInput,
  EnvironmentBindings,
  EnvironmentModule,
  EnvironmentSetupContext,
  ExecutionExitState,
  ExecutionParams,
  GetServiceInput,
  GetToolInput,
  InvokeInput,
} from "@mci/sdk";
import ivm from "isolated-vm";
import ts from "typescript";

const DEFAULT_POOL_SIZE = 2;
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MEMORY_LIMIT_MB = 128;

type Interrupt = {
  promise: Promise<ExecutionExitState>;
  resolve: (state: ExecutionExitState) => void;
};

type ExecutionJob = {
  input: ExecutionParams;
  code: string;
  resolve: (state: ExecutionExitState) => void;
};

type RunningExecution = {
  eid: number;
  interrupt: Interrupt;
  timeoutHandle: ReturnType<typeof setTimeout> | null;
};

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

function createInterupt(): Interrupt {
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

function getEffectiveTimeoutMs(
  options: ExecutionParams["options"],
): number | null {
  if (options.timeoutMs === null) return null;
  if (options.timeoutMs === undefined) return DEFAULT_TIMEOUT_MS;
  return options.timeoutMs;
}

function buildWrappedCode(code: string): string {
  return `async function __mciMain__() {${code}}__mciMain__();`;
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

  async execute(input: ExecutionParams): Promise<ExecutionExitState> {
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
    } catch {
      return "failed";
    }

    this.bindings.setState(input.eid, "queued");

    return new Promise<ExecutionExitState>((resolve) => {
      this.queue.push({ input, code, resolve });
      void this.pumpQueue();
    });
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
    const interrupt = createInterupt();
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
        .catch(() => "failed" as const);

      const timeoutPromise =
        effectiveTimeoutMs === null
          ? null
          : new Promise<ExecutionExitState>((resolve) => {
              running.timeoutHandle = setTimeout(() => {
                void this.terminateExecution(worker);
                resolve("timeout");
              }, effectiveTimeoutMs);
            });

      result = await Promise.race([
        executionPromise,
        interrupt.promise,
        ...(timeoutPromise ? [timeoutPromise] : []),
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
      "__mci_emitStdout",
      new ivm.Reference((data: string) => {
        void bindings.emitStdout(eid, Buffer.from(data, "utf8"));
      }),
    );

    await jail.set(
      "__mci_emitStderr",
      new ivm.Reference((data: string) => {
        void bindings.emitStderr(eid, Buffer.from(data, "utf8"));
      }),
    );

    await jail.set(
      "__mci_emitOutput",
      new ivm.Reference((data: string) => {
        bindings.emitOutput(eid, JSON.parse(data) as Record<string, unknown>);
      }),
    );

    await jail.set(
      "__mci_getService",
      new ivm.Reference(async (jsonInput: string) => {
        const input = JSON.parse(jsonInput) as GetServiceInput;
        const result = await bindings.getService(input);
        return JSON.stringify(result);
      }),
    );

    await jail.set(
      "__mci_getTool",
      new ivm.Reference(async (jsonInput: string) => {
        const input = JSON.parse(jsonInput) as GetToolInput;
        const result = await bindings.getTool(input);
        return JSON.stringify(result);
      }),
    );

    await jail.set(
      "__mci_invokeTool",
      new ivm.Reference(async (jsonInput: string) => {
        const input = JSON.parse(jsonInput) as InvokeInput;
        const result = await bindings.invokeTool(input);
        return JSON.stringify(result);
      }),
    );

    await jail.set(
      "__mci_discoverTools",
      new ivm.Reference(async (jsonInput: string) => {
        const input = JSON.parse(jsonInput) as DiscoverInput;
        const result = await bindings.discoverTools(input);
        return JSON.stringify(result);
      }),
    );

    await jail.set(
      "__mci_discoverServices",
      new ivm.Reference(async (jsonInput: string) => {
        const input = JSON.parse(jsonInput) as DiscoverInput;
        const result = await bindings.discoverServices(input);
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
      const url = new URL("./bindings.ts", import.meta.url);
      const source = await fs.readFile(url, "utf8");
      return transpileTypeScript(source);
    } catch {
      return null;
    }
  }

  private async terminateExecution(worker: WorkerSlot): Promise<void> {
    try {
      worker.isolate.dispose();
      // Create a new isolate for future use
      worker.isolate = new ivm.Isolate({
        memoryLimit: DEFAULT_MEMORY_LIMIT_MB,
      }) as TerminableIsolate;
    } catch {
      // Ignore disposal errors
    }
  }
}

export const manifest = {
  name: "typescript-ivm",
  version: "1.0.0",
  description: "TypeScript environment powered by isolated-vm",
  type: "environment" as const,
};

export function instantiate(): EnvironmentModule {
  return new TypescriptIvmEnvironment();
}
