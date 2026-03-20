import type { EnvironmentModule } from "@/config/modules";
import { logger } from "@/logger";

export type PooledInstance = {
  module: EnvironmentModule;
  busy: boolean;
};

export type QueueEntry = {
  resolve: (instance: PooledInstance) => void;
  reject: (err: Error) => void;
};

export type Pool = {
  instances: PooledInstance[];
  queue: QueueEntry[];
  initialize(modules: Map<string, EnvironmentModule>): Promise<void>;
  acquire(): Promise<PooledInstance>;
  release(instance: PooledInstance): void;
};

class PoolService implements Pool {
  readonly instances: PooledInstance[] = [];
  readonly queue: QueueEntry[] = [];

  async initialize(modules: Map<string, EnvironmentModule>): Promise<void> {
    this.instances.length = 0;
    this.queue.length = 0;

    for (const [id, module] of modules) {
      try {
        await module.setup();
        this.instances.push({ module, busy: false });
      } catch (err) {
        logger.warn(
          {
            err,
            moduleId: id,
            moduleLabel: module.label,
          },
          "Failed to setup module instance; skipping",
        );
      }
    }

    if (this.instances.length === 0) {
      throw new Error("No pool instances initialized");
    }
  }

  async acquire(): Promise<PooledInstance> {
    const free = this.instances.find((instance) => !instance.busy);

    if (free) {
      free.busy = true;
      return free;
    }

    return new Promise<PooledInstance>((resolve, reject) => {
      this.queue.push({ resolve, reject });
    });
  }

  release(instance: PooledInstance): void {
    const next = this.queue.shift();

    if (next) {
      instance.busy = true;
      next.resolve(instance);
      return;
    }

    instance.busy = false;
  }
}

export const createPool = (): Pool => new PoolService();
