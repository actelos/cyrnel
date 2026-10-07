export interface ExecutionObserver {
  onEvent(event: ExecutionEvent): void | Promise<void>;
}

export interface ExecutionEvent {
  type: string;
  timestamp: string;
  monotonicMs: number;
  [key: string]: unknown;
}

let observer: ExecutionObserver | null = null;

export function setExecutionObserver(next: ExecutionObserver | null): void {
  observer = next;
}

export function hasExecutionObserver(): boolean {
  return observer !== null;
}

export function emitExecutionEvent(
  event: Omit<ExecutionEvent, "timestamp" | "monotonicMs">,
): void {
  if (!observer) return;
  const fullEvent: ExecutionEvent = {
    type: event.type as string,
    transport: (event.transport ?? "unknown") as string,
    method: (event.method ?? "unknown") as string,
    path: (event.path ?? "/") as string,
    payloadBytes: (event.payloadBytes ?? 0) as number,
    status: (event.status ?? 0) as number,
    durationMs: (event.durationMs ?? 0) as number,
    timestamp: new Date().toISOString(),
    monotonicMs: performance.now(),
  };
  queueMicrotask(() => {
    Promise.resolve(observer?.onEvent(fullEvent)).catch(() => {});
  });
}

export function safeJsonBytes(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value), "utf8");
  } catch {
    return 0;
  }
}
