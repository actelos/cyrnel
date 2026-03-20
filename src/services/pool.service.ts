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
  initialize(modules: Map<string, EnvironmentModule>): Promise<void>;
  acquire(): Promise<PooledInstance>;
  release(instance: PooledInstance): void;
  getInstances(): readonly PooledInstance[];
  getQueue(): readonly QueueEntry[];
};

class PoolService implements Pool {
  private readonly instances: PooledInstance[] = [];
  private readonly queue: QueueEntry[] = [];

  async initialize(modules: Map<string, EnvironmentModule>): Promise<void> {
    const queuedEntries = this.queue.splice(0);

    for (const entry of queuedEntries) {
      entry.reject(new Error("Pool was re-initialized"));
    }

    this.instances.length = 0;

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
    if (!this.instances.includes(instance)) {
      logger.warn(
        { module: instance.module.label },
        "Attempted to release unknown instance",
      );
      return;
    }

    const next = this.queue.shift();

    if (next) {
      next.resolve(instance);
      return;
    }

    instance.busy = false;
  }

  getInstances(): readonly PooledInstance[] {
    return this.instances.slice();
  }

  getQueue(): readonly QueueEntry[] {
    return this.queue.slice();
  }
}

export const createPool = (): Pool => new PoolService();
