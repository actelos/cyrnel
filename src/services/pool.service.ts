import type { EnvironmentModule } from "@/config/modules";
import { logger } from "@/logger";

export type EnvironmentPoolInstance = {
  module: EnvironmentModule;
  busy: boolean;
};

export type EnvironmentPoolQueueEntry = {
  resolve: (instance: EnvironmentPoolInstance) => void;
  reject: (err: Error) => void;
};

export type Pool<TInstance, TQueueEntry> = {
  acquire(): Promise<TInstance>;
  release(instance: TInstance): void;
  getInstances(): readonly TInstance[];
  getQueue(): readonly TQueueEntry[];
};

export type EnvironmentPool = Pool<
  EnvironmentPoolInstance,
  EnvironmentPoolQueueEntry
> & {
  initialize(modules: Map<string, EnvironmentModule>): Promise<void>;
  shutdown(): Promise<void>;
};

class EnvironmentPoolService implements EnvironmentPool {
  private readonly instances: EnvironmentPoolInstance[] = [];
  private readonly queue: EnvironmentPoolQueueEntry[] = [];
  private readonly shutdownWaiters: Array<() => void> = [];
  private isShutdown = false;

  async initialize(modules: Map<string, EnvironmentModule>): Promise<void> {
    this.isShutdown = false;
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

  async shutdown(): Promise<void> {
    this.isShutdown = true;
    const queuedEntries = this.queue.splice(0);

    for (const entry of queuedEntries) {
      entry.reject(new Error("Pool has been shut down"));
    }

    if (this.instances.some((instance) => instance.busy)) {
      await new Promise<void>((resolve) => {
        this.shutdownWaiters.push(resolve);
      });
    }

    const instances = this.instances.splice(0);

    const results = await Promise.allSettled(
      instances.map((instance) => instance.module.teardown()),
    );

    results.forEach((result, index) => {
      if (result.status === "rejected") {
        logger.warn(
          { err: result.reason, moduleLabel: instances[index]?.module.label },
          "Failed to teardown module instance",
        );
      }
    });
  }

  async acquire(): Promise<EnvironmentPoolInstance> {
    if (this.isShutdown) {
      throw new Error("Pool has been shut down");
    }

    const free = this.instances.find((instance) => !instance.busy);

    if (free) {
      free.busy = true;
      return free;
    }

    return new Promise<EnvironmentPoolInstance>((resolve, reject) => {
      this.queue.push({ resolve, reject });
    });
  }

  release(instance: EnvironmentPoolInstance): void {
    if (!this.instances.includes(instance)) {
      logger.warn(
        { module: instance.module.label },
        "Attempted to release unknown instance",
      );
      return;
    }

    if (!instance.busy) {
      logger.warn(
        { module: instance.module.label },
        "Attempted to release non-busy instance",
      );
      return;
    }

    const next = this.queue.shift();

    if (next) {
      next.resolve(instance);
      return;
    }

    instance.busy = false;
    this.notifyShutdownWaitersIfIdle();
  }

  getInstances(): readonly EnvironmentPoolInstance[] {
    return this.instances.slice();
  }

  getQueue(): readonly EnvironmentPoolQueueEntry[] {
    return this.queue.slice();
  }

  private notifyShutdownWaitersIfIdle(): void {
    if (!this.isShutdown) {
      return;
    }

    if (this.instances.some((instance) => instance.busy)) {
      return;
    }

    const waiters = this.shutdownWaiters.splice(0);

    for (const waiter of waiters) {
      waiter();
    }
  }
}

export const createEnvironmentPool = (): EnvironmentPool =>
  new EnvironmentPoolService();
