export interface McpExecutionObserver {
  onEvent(event: McpExecutionEvent): void | Promise<void>;
}

export interface McpExecutionEvent {
  type: string;
  timestamp: string;
  monotonicMs: number;
  [key: string]: unknown;
}

let observer: McpExecutionObserver | null = null;

export function setMcpExecutionObserver(
  next: McpExecutionObserver | null,
): void {
  observer = next;
}

export function hasMcpExecutionObserver(): boolean {
  return observer !== null;
}

export function emitMcpExecutionEvent(
  event: Omit<McpExecutionEvent, "timestamp" | "monotonicMs">,
): void {
  if (!observer) return;
  const fullEvent: McpExecutionEvent = {
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
    (async () => {
      try {
        await observer?.onEvent(fullEvent);
      } catch {
        // Swallow observer failures so instrumentation cannot terminate the MCP process.
      }
    })().catch(() => {});
  });
}
