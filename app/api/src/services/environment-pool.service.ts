import { HttpError } from "@/models/error.model";
import type {
  ServiceManifest,
  StagedServiceManifest,
} from "@/models/manifest.model";
import { EnvironmentModule } from "@/modules/environment.module";
import type { ManifestService } from "@/services/manifest.service";

type StagingStatus = "idle" | "staging" | "ready" | "failed";

interface StagingState {
  status: StagingStatus;
}

export class EnvironmentPoolService {
  private environmentModule: EnvironmentModule | null = null;
  private isShutdown = false;
  private readonly leaseCounts = new Map<EnvironmentModule, number>();
  private readonly retiredModules = new Set<EnvironmentModule>();
  private pendingRestage = false;
  private stagingPromise: Promise<boolean> | null = null;
  private manifestService: Pick<
    ManifestService,
    "getAllStagedServiceManifests"
  > | null = null;
  private readonly stagingState: StagingState = {
    status: "idle",
  };

  hasReadyEnvironment(): boolean {
    return this.environmentModule !== null;
  }

  getStagingState(): Readonly<StagingState> {
    return { ...this.stagingState };
  }

  async initialize(
    manifestService: Pick<ManifestService, "getAllStagedServiceManifests">,
  ): Promise<void> {
    this.manifestService = manifestService;
    await this.tryStageNow();
  }

  requestRestage(): void {
    if (this.isShutdown) {
      return;
    }

    this.pendingRestage = true;

    if (this.getLeaseCount(this.environmentModule) > 0) {
      return;
    }

    void this.tryStageNow();
  }

  allocate(): EnvironmentModule {
    if (this.isShutdown) {
      throw new HttpError(503, "Environment pool has been shut down.");
    }

    if (!this.environmentModule) {
      throw new HttpError(503, "No staged environment is available.");
    }

    const module = this.environmentModule;
    this.leaseCounts.set(module, this.getLeaseCount(module) + 1);
    return module;
  }

  release(module: EnvironmentModule): void {
    const leaseCount = this.getLeaseCount(module);
    if (leaseCount === 0) {
      return;
    }

    if (leaseCount === 1) {
      this.leaseCounts.delete(module);
    } else {
      this.leaseCounts.set(module, leaseCount - 1);
    }

    const remainingLeaseCount = this.getLeaseCount(module);

    if (this.retiredModules.has(module) && remainingLeaseCount === 0) {
      this.retiredModules.delete(module);
      void module.kill().catch(() => {
        // best-effort cleanup for retired environments
      });
    }

    if (
      this.environmentModule === module &&
      remainingLeaseCount === 0 &&
      this.pendingRestage &&
      !this.isShutdown
    ) {
      void this.tryStageNow();
    }
  }

  recycleEnvironment(module: EnvironmentModule): void {
    const leaseCount = this.getLeaseCount(module);
    if (leaseCount === 0) {
      return;
    }

    if (leaseCount === 1) {
      this.leaseCounts.delete(module);
    } else {
      this.leaseCounts.set(module, leaseCount - 1);
    }

    const remainingLeaseCount = this.getLeaseCount(module);

    if (this.environmentModule === module) {
      this.environmentModule = null;
      this.pendingRestage = true;
    }

    this.retiredModules.add(module);

    if (remainingLeaseCount === 0) {
      this.retiredModules.delete(module);
      void module.kill().catch(() => {
        // best-effort cleanup for recycled environments
      });
    }

    if (!this.isShutdown) {
      void this.tryStageNow();
    }
  }

  destroy(module: EnvironmentModule): void {
    this.recycleEnvironment(module);
  }

  async shutdown(): Promise<void> {
    if (this.isShutdown) {
      return;
    }

    const current = this.environmentModule;
    const retired = [...this.retiredModules];
    this.environmentModule = null;
    this.leaseCounts.clear();
    this.retiredModules.clear();

    if (current) {
      await current.kill();
    }

    for (const module of retired) {
      if (module !== current) {
        await module.kill();
      }
    }

    this.isShutdown = true;
  }

  private async tryStageNow(): Promise<boolean> {
    if (this.isShutdown) {
      return false;
    }

    if (!this.manifestService) {
      this.recordStagingFailure(
        new Error("Manifest service not configured for environment staging."),
      );
      return false;
    }

    if (this.stagingPromise) {
      return this.stagingPromise;
    }

    this.stagingPromise = this.stageFromManifestService(this.manifestService)
      .catch((error: unknown) => {
        this.recordStagingFailure(error);
        return false;
      })
      .finally(() => {
        this.stagingPromise = null;
      });

    return this.stagingPromise;
  }

  private async stageFromManifestService(
    manifestService: Pick<ManifestService, "getAllStagedServiceManifests">,
  ): Promise<boolean> {
    this.stagingState.status = "staging";

    const manifests = await manifestService.getAllStagedServiceManifests();
    const stagedModule = new EnvironmentModule();

    try {
      for (const manifest of manifests) {
        stagedModule.setServiceManifestBindings(
          toServiceManifestBinding(manifest),
        );
      }

      const previous = this.environmentModule;
      this.environmentModule = stagedModule;
      this.pendingRestage = false;
      this.stagingState.status = "ready";

      if (previous) {
        if (this.getLeaseCount(previous) === 0) {
          await previous.kill();
        } else {
          this.retiredModules.add(previous);
        }
      }

      return true;
    } catch (error: unknown) {
      await stagedModule.kill();
      throw error;
    }
  }

  private recordStagingFailure(error: unknown): void {
    this.stagingState.status = "failed";
    void error;
  }

  private getLeaseCount(module: EnvironmentModule | null): number {
    if (!module) {
      return 0;
    }

    return this.leaseCounts.get(module) ?? 0;
  }
}

function toServiceManifestBinding(
  manifest: StagedServiceManifest,
): ServiceManifest {
  return {
    name: manifest.name,
    description: "",
    enabled: true,
    metadata: {},
    tools: manifest.tools.map((tool) => {
      const stagedTool = tool as {
        inputSchema?: Record<string, unknown> | null;
        outputSchema?: Record<string, unknown> | null;
      };

      return {
        name: tool.name,
        description: "",
        enabled: true,
        metadata: {},
        inputSchema: (stagedTool.inputSchema ?? null) as unknown as Record<
          string,
          unknown
        >,
        outputSchema: (stagedTool.outputSchema ?? null) as unknown as Record<
          string,
          unknown
        >,
      };
    }),
  };
}
