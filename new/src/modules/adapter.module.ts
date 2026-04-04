export class AdapterModule {
  async invoke(
    _serviceId: string,
    _toolId: string,
    _parameters: Record<string, unknown>,
  ): Promise<string> {
    return "hello world";
  }
}
