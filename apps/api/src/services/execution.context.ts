import { AsyncLocalStorage } from "node:async_hooks";

export interface ExecutionContext {
  executionId: number;
  processId: number;
}

const storage = new AsyncLocalStorage<ExecutionContext>();

export function runWithExecutionContext<T>(
  context: ExecutionContext,
  fn: () => Promise<T>,
): Promise<T> {
  return storage.run(context, fn);
}

export function getExecutionContext(): ExecutionContext | null {
  return storage.getStore() ?? null;
}
