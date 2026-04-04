import { EnvironmentModule } from "@/modules/environment.module";

export class EnvironmentPoolService {
  private readonly defaultEnvironmentModule = new EnvironmentModule();

  allocate(): EnvironmentModule {
    return this.defaultEnvironmentModule;
  }
}
