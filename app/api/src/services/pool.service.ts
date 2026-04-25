import { EnvironmentModule } from "@/modules/environment.module";
import type {
  ServiceManifest,
  StagedServiceManifest,
} from "@/models/manifest.model";
import { HttpError } from "@/models/error.model";
import type { ManifestService } from "@/services/manifest.service";

type StagingStatus = "idle" | "staging" | "ready" | "failed";

interface StagingState {
  status: StagingStatus;
  lastError: string | null;
  retryCount: number;
  nextRetryAt: number | null;
}

export class EnvironmentPoolService {
  private environmentModule: EnvironmentModule | null = null;
  private isShutdown = false;
  private isLeased = false;
  private pendingRestage = false;
  private readonly retryBaseDelayMs = 1_000;
  private readonly retryMaxDelayMs = 30_000;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private stagingPromise: Promise<boolean> | null = null;
  private manifestService: Pick<
    ManifestService,
    "getAllStagedServiceManifests"
  > | null = null;
  private readonly stagingState: StagingState = {
    status: "idle",
    lastError: null,
    retryCount: 0,
    nextRetryAt: null,
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

    if (this.isLeased) {
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

    this.isLeased = true;
    return this.environmentModule;
  }

  release(module: EnvironmentModule): void {
    if (this.environmentModule !== module) {
      return;
    }

    this.isLeased = false;

    if (this.pendingRestage && !this.isShutdown) {
      void this.tryStageNow();
    }
  }

  async shutdown(): Promise<void> {
    if (this.isShutdown) {
      return;
    }

    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }

    const current = this.environmentModule;
    this.environmentModule = null;

    if (current) {
      await current.kill();
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
    this.stagingState.nextRetryAt = null;

    const manifests = await manifestService.getAllStagedServiceManifests();
    const stagedModule = new EnvironmentModule();

    try {
      for (const manifest of manifests) {
        stagedModule.setServiceManifestBindings(
          toServiceManifestBinding(manifest),
        );
      }

      const verification = await this.verifyStaging(stagedModule, manifests);
      if (!verification) {
        throw new Error("Environment staging verification failed.");
      }

      const previous = this.environmentModule;
      this.environmentModule = stagedModule;
      this.pendingRestage = false;
      this.stagingState.status = "ready";
      this.stagingState.lastError = null;
      this.stagingState.retryCount = 0;
      this.stagingState.nextRetryAt = null;

      if (this.retryTimer) {
        clearTimeout(this.retryTimer);
        this.retryTimer = null;
      }

      if (previous) {
        await previous.kill();
      }

      return true;
    } catch (error: unknown) {
      await stagedModule.kill();
      throw error;
    }
  }

  private async verifyStaging(
    module: EnvironmentModule,
    manifests: StagedServiceManifest[],
  ): Promise<boolean> {
    const expectedEntries = manifests
      .map((manifest) => ({
        serviceName: manifest.name,
        tools: manifest.tools.map((tool) => tool.name),
      }))
      .filter((entry) => entry.tools.length > 0);

    const encoded = JSON.stringify(expectedEntries);

    const status = await module.execute(`
      const expected = ${encoded};

      for (const entry of expected) {
        if (!(entry.serviceName in invoke)) {
          throw new Error(
            "staging verification missing service binding: " + entry.serviceName,
          );
        }

        for (const toolName of entry.tools) {
          if (typeof invoke[entry.serviceName]?.[toolName] !== "function") {
            throw new Error(
              "staging verification missing tool binding: " +
                entry.serviceName +
                "." +
                toolName,
            );
          }
        }
      }

      return true;
    `);

    return status === "success";
  }

  private recordStagingFailure(error: unknown): void {
    this.stagingState.status = "failed";
    this.stagingState.lastError =
      error instanceof Error
        ? error.message
        : String(error ?? "Unknown staging error");
    this.stagingState.retryCount += 1;

    const delay = Math.min(
      this.retryMaxDelayMs,
      this.retryBaseDelayMs * 2 ** (this.stagingState.retryCount - 1),
    );
    const jitter = Math.floor(Math.random() * Math.max(1, Math.floor(delay * 0.2)));
    const nextDelay = delay + jitter;
    this.stagingState.nextRetryAt = Date.now() + nextDelay;

    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
    }

    this.retryTimer = setTimeout(() => {
      if (this.isShutdown || this.isLeased) {
        return;
      }

      void this.tryStageNow();
    }, nextDelay);
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
    tools: manifest.tools.map((tool) => ({
      name: tool.name,
      description: "",
      enabled: true,
      metadata: {},
      inputSchema: {},
      outputSchema: {},
    })),
  };
}
