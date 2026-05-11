import { eq } from "drizzle-orm";

import { db } from "@/db/client";
import { configurations, manifests, secrets } from "@/db/schema";
import { HttpError } from "@/models/error.model";
import { AdapterModule } from "@/modules/adapter.module";
import { decryptSecrets } from "@/utils/secrets.util";
import { applyJsonSchemaDefaults } from "@/utils/validation.util";

export class AdapterPoolService {
  private adapter: AdapterModule;
  private readonly leaseCounts = new Map<AdapterModule, number>();
  private isShutdown = false;
  private pendingRestage = false;
  private stagingPromise: Promise<boolean> | null = null;
  private readonly retiredAdapters = new Set<AdapterModule>();

  constructor() {
    this.adapter = new AdapterModule();
    this.adapter.setServiceConfigs({});
    this.adapter.setServiceSecrets({});
  }

  requestRestage(): void {
    if (this.isShutdown) {
      return;
    }

    this.pendingRestage = true;

    if (this.getLeaseCount(this.adapter) > 0) {
      return;
    }

    void this.tryStageNow();
  }

  updateServiceConfig(
    serviceName: string,
    config: Record<string, unknown>,
  ): void {
    if (this.isShutdown) {
      return;
    }

    this.adapter.setServiceConfig(serviceName, config);

    for (const adapter of this.retiredAdapters) {
      adapter.setServiceConfig(serviceName, config);
    }
  }

  updateServiceSecrets(
    serviceName: string,
    secretsPayload: Record<string, unknown>,
  ): void {
    if (this.isShutdown) {
      return;
    }

    this.adapter.setServiceSecret(serviceName, secretsPayload);

    for (const adapter of this.retiredAdapters) {
      adapter.setServiceSecret(serviceName, secretsPayload);
    }
  }

  allocate(): AdapterModule {
    if (this.isShutdown) {
      throw new HttpError(503, "Adapter pool has been shut down.");
    }

    this.leaseCounts.set(this.adapter, this.getLeaseCount(this.adapter) + 1);
    return this.adapter;
  }

  release(adapter: AdapterModule): void {
    const leaseCount = this.getLeaseCount(adapter);

    if (leaseCount === 0) {
      return;
    }

    if (leaseCount === 1) {
      this.leaseCounts.delete(adapter);
    } else {
      this.leaseCounts.set(adapter, leaseCount - 1);
    }

    const remainingLeaseCount = this.getLeaseCount(adapter);

    if (this.retiredAdapters.has(adapter) && remainingLeaseCount === 0) {
      this.retiredAdapters.delete(adapter);
    }

    if (
      this.adapter === adapter &&
      remainingLeaseCount === 0 &&
      this.pendingRestage &&
      !this.isShutdown
    ) {
      void this.tryStageNow();
    }
  }

  shutdown(): void {
    if (this.isShutdown) {
      return;
    }

    this.isShutdown = true;
    this.leaseCounts.clear();
    this.retiredAdapters.clear();
  }

  private getLeaseCount(adapter: AdapterModule | null): number {
    if (!adapter) {
      return 0;
    }

    return this.leaseCounts.get(adapter) ?? 0;
  }

  private async tryStageNow(): Promise<boolean> {
    if (this.isShutdown) {
      return false;
    }

    if (this.stagingPromise) {
      return this.stagingPromise;
    }

    this.stagingPromise = this.stageFromDatabase()
      .catch(() => false)
      .finally(() => {
        this.stagingPromise = null;
      });

    return this.stagingPromise;
  }

  private async stageFromDatabase(): Promise<boolean> {
    const snapshot = await this.hydrateSnapshot();
    const staged = new AdapterModule();
    staged.setServiceConfigs(snapshot.configs);
    staged.setServiceSecrets(snapshot.secrets);

    const previous = this.adapter;
    this.adapter = staged;
    this.pendingRestage = false;

    if (previous && this.getLeaseCount(previous) > 0) {
      this.retiredAdapters.add(previous);
    }

    return true;
  }

  private async hydrateSnapshot(): Promise<{
    configs: Record<string, unknown>;
    secrets: Record<string, unknown>;
  }> {
    const rows = await db
      .select({
        serviceName: manifests.id,
        configSchema: manifests.configSchema,
        secretsSchema: manifests.secretsSchema,
        config: configurations.config,
        secrets: secrets.payload,
      })
      .from(manifests)
      .leftJoin(configurations, eq(configurations.serviceName, manifests.id))
      .leftJoin(secrets, eq(secrets.serviceName, manifests.id));

    const configSnapshot: Record<string, unknown> = {};
    const secretsSnapshot: Record<string, unknown> = {};
    for (const row of rows) {
      const rawConfig =
        row.config &&
        typeof row.config === "object" &&
        !Array.isArray(row.config)
          ? row.config
          : {};

      if (isNullOnlySchema(row.configSchema)) {
        configSnapshot[row.serviceName] = rawConfig;
      } else {
        configSnapshot[row.serviceName] = applyJsonSchemaDefaults(
          row.configSchema,
          rawConfig,
          `Invalid configuration for service '${row.serviceName}'.`,
        );
      }

      const rawSecrets = row.secrets ? decryptSecrets(row.secrets) : {};

      if (isNullOnlySchema(row.secretsSchema)) {
        secretsSnapshot[row.serviceName] = rawSecrets;
      } else {
        secretsSnapshot[row.serviceName] = applyJsonSchemaDefaults(
          row.secretsSchema,
          rawSecrets,
          `Invalid secrets for service '${row.serviceName}'.`,
        );
      }
    }

    return { configs: configSnapshot, secrets: secretsSnapshot };
  }
}

function isNullOnlySchema(schema: Record<string, unknown>): boolean {
  const type = schema.type;

  if (type === "null") {
    return true;
  }

  if (Array.isArray(type) && type.length === 1 && type[0] === "null") {
    return true;
  }

  return false;
}
