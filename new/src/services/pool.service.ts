import { EnvironmentModule } from "@/modules/environment.module";

export class EnvironmentPoolService {
  private readonly defaultEnvironmentModule = new EnvironmentModule();
  private isShutdown = false;

  allocate(): EnvironmentModule {
    if (this.isShutdown) {
      throw new Error("Environment pool has been shut down.");
    }

    return this.defaultEnvironmentModule;
  }

  async shutdown(): Promise<void> {
    if (this.isShutdown) {
      return;
    }

    await this.defaultEnvironmentModule.kill();
    this.isShutdown = true;
  }
}
