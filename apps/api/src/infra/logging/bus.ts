import type { LogEntry } from "@/infra/logging/log-entry";

export type LogListener = (entry: LogEntry) => void;

export class LogBus {
  private listeners = new Set<LogListener>();

  constructor(private maxSubscribers = 32) {}

  subscribe(listener: LogListener): () => void {
    if (this.listeners.size >= this.maxSubscribers) {
      throw new Error(`Log subscriber limit of ${this.maxSubscribers} reached`);
    }
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  get subscriberCount(): number {
    return this.listeners.size;
  }

  emit(entry: LogEntry): void {
    for (const listener of this.listeners) {
      try {
        listener(entry);
      } catch {}
    }
  }
}
