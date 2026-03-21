import type { EnvironmentModule } from "@/config/modules";
import { logger } from "@/logger";

export type EnvironmentPoolInstance = {
  module: EnvironmentModule;
  matcher: RegExp;
  busy: boolean;
};

export type EnvironmentPoolQueueEntry = {
  environment: string;
  resolve: (instance: EnvironmentPoolInstance) => void;
  reject: (err: Error) => void;
};

export type Pool<TInstance, TQueueEntry> = {
  acquire(environment: string): Promise<TInstance>;
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
  supportsEnvironment(environment: string): boolean;
};

type EnvironmentPoolModuleEntry = {
  id: string;
  module: EnvironmentModule;
  matcher: RegExp;
};

class EnvironmentPoolService implements EnvironmentPool {
  private readonly instances: EnvironmentPoolInstance[] = [];
  private readonly queue: EnvironmentPoolQueueEntry[] = [];
  private readonly shutdownWaiters: Array<() => void> = [];
  private modules: EnvironmentPoolModuleEntry[] = [];
  private readonly initializedModules: EnvironmentPoolModuleEntry[] = [];
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
    const compiled: EnvironmentPoolModuleEntry[] = [];

    for (const [id, module] of modules.entries()) {
      try {
        const matcher = new RegExp(module.label);
        compiled.push({ id, module, matcher });
      } catch (err) {
        logger.warn(
          { err, moduleId: id, moduleLabel: module.label },
          "Invalid module label regex; skipping",
        );
      }
    }

    if (compiled.length === 0 && modules.size > 0) {
      throw new Error("No valid environment module labels");
    }

    this.modules = compiled.slice();
    this.initializedModules.length = 0;
    this.initializedModules.push(...compiled);
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

  async acquire(environment: string): Promise<EnvironmentPoolInstance> {
    if (this.isShutdown) {
      throw new Error("Pool has been shut down");
    }

    const free = this.findFreeInstance(environment);

    if (free) {
      free.busy = true;
      return free;
    }

    const decision = await this.withSetupLock(async () => {
      if (this.isShutdown) {
        throw new Error("Pool has been shut down");
      }

      const available = this.findFreeInstance(environment);
      if (available) {
        available.busy = true;
        return { kind: "instance", instance: available } as const;
      }

      const hasMatchingInstances = this.instances.some((instance) =>
        this.matchesEnvironment(instance.matcher, environment),
      );
      const hasMatchingCandidates =
        hasMatchingInstances ||
        this.modules.some((entry) =>
          this.matchesEnvironment(entry.matcher, environment),
        );

      const instance = await this.setupNextInstance(environment);
      if (instance) {
        return { kind: "instance", instance } as const;
      }

      if (!hasMatchingCandidates) {
        throw new Error(`No environment modules match "${environment}"`);
      }

      if (!hasMatchingInstances && this.instances.length === 0) {
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
      const entry = { environment, resolve, reject };
      this.queue.push(entry);
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

    instance.busy = false;
    this.assignQueuedInstances();
    if (!instance.busy) {
      this.notifyShutdownWaitersIfIdle();
    }
  }

  getInstances(): readonly EnvironmentPoolInstance[] {
    return this.instances.slice();
  }

  getQueue(): readonly EnvironmentPoolQueueEntry[] {
    return this.queue.slice();
  }

  supportsEnvironment(environment: string): boolean {
    return (
      this.instances.some((instance) =>
        this.matchesEnvironment(instance.matcher, environment),
      ) ||
      this.modules.some((entry) =>
        this.matchesEnvironment(entry.matcher, environment),
      ) ||
      this.initializedModules.some((entry) =>
        this.matchesEnvironment(entry.matcher, environment),
      )
    );
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

  private async setupNextInstance(
    environment: string,
  ): Promise<EnvironmentPoolInstance | null> {
    while (this.modules.length > 0) {
      const index = this.modules.findIndex((entry) =>
        this.matchesEnvironment(entry.matcher, environment),
      );
      if (index === -1) {
        return null;
      }

      const [entry] = this.modules.splice(index, 1);
      const { id, module, matcher } = entry;
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
        const instance = { module, matcher, busy: true };
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

  private matchesEnvironment(matcher: RegExp, environment: string): boolean {
    return matcher.test(environment);
  }

  private findFreeInstance(
    environment: string,
  ): EnvironmentPoolInstance | undefined {
    return this.instances.find(
      (instance) =>
        !instance.busy &&
        this.matchesEnvironment(instance.matcher, environment),
    );
  }

  private assignQueuedInstances(): void {
    if (this.queue.length === 0) {
      return;
    }

    let index = 0;
    while (index < this.queue.length) {
      const entry = this.queue[index];
      const instance = this.findFreeInstance(entry.environment);
      if (!instance) {
        index += 1;
        continue;
      }

      instance.busy = true;
      this.queue.splice(index, 1);
      entry.resolve(instance);
    }
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
