import { HttpError } from "@/models/error.model";
import { AdapterModule } from "@/modules/adapter.module";

export class AdapterPoolService {
  private readonly adapter: AdapterModule;
  private readonly leaseCounts = new Map<AdapterModule, number>();
  private isShutdown = false;

  constructor() {
    this.adapter = new AdapterModule();
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
  }

  shutdown(): void {
    if (this.isShutdown) {
      return;
    }

    this.isShutdown = true;
    this.leaseCounts.clear();
  }

  private getLeaseCount(adapter: AdapterModule): number {
    return this.leaseCounts.get(adapter) ?? 0;
  }
}
