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
  private modules: Array<[string, EnvironmentModule]> = [];
  private setupLock: Promise<void> = Promise.resolve();
  private isShutdown = false;
  private generation = 0;

  async initialize(modules: Map<string, EnvironmentModule>): Promise<void> {
    if (
      this.queue.length > 0 ||
      this.instances.some((instance) => instance.busy)
    ) {
      throw new Error("Pool has active instances");
    }

    this.generation += 1;
    this.isShutdown = false;
    const queuedEntries = this.queue.splice(0);

    for (const entry of queuedEntries) {
      entry.reject(new Error("Pool was re-initialized"));
    }

    this.instances.length = 0;
    this.modules = Array.from(modules.entries());
  }

  async shutdown(): Promise<void> {
    this.isShutdown = true;
    this.generation += 1;
    this.modules = [];
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

    const decision = await this.withSetupLock(async () => {
      if (this.isShutdown) {
        throw new Error("Pool has been shut down");
      }

      const available = this.instances.find((instance) => !instance.busy);
      if (available) {
        available.busy = true;
        return { kind: "instance", instance: available } as const;
      }

      const instance = await this.setupNextInstance();
      if (instance) {
        return { kind: "instance", instance } as const;
      }

      if (this.instances.length === 0) {
        throw new Error("No pool instances initialized");
      }

      return { kind: "queue" } as const;
    });

    if (decision.kind === "instance") {
      return decision.instance;
    }

    if (this.isShutdown) {
      throw new Error("Pool has been shut down");
    }

    return new Promise<EnvironmentPoolInstance>((resolve, reject) => {
      const entry = { resolve, reject };
      this.queue.push(entry);

      const available = this.instances.find((instance) => !instance.busy);
      if (available && this.queue[0] === entry) {
        this.queue.shift();
        available.busy = true;
        resolve(available);
      }
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

  private async setupNextInstance(): Promise<EnvironmentPoolInstance | null> {
    while (this.modules.length > 0) {
      const [id, module] = this.modules.shift()!;
      const generation = this.generation;
      try {
        await module.setup();
        if (generation !== this.generation) {
          await module.teardown().catch(() => {});
          continue;
        }
        if (this.isShutdown) {
          await module.teardown().catch(() => {});
          return null;
        }
        const instance = { module, busy: true };
        this.instances.push(instance);
        return instance;
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

    return null;
  }

  private async withSetupLock<T>(task: () => Promise<T>): Promise<T> {
    const previous = this.setupLock;
    let release: () => void;
    this.setupLock = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;

    try {
      return await task();
    } finally {
      release!();
    }
  }
}

export const createEnvironmentPool = (): EnvironmentPool =>
  new EnvironmentPoolService();
