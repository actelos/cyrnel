import { describe, expect, it } from "vitest";

import { DefinitionService } from "@/services/definition.service";

describe("definition.service unit", () => {
  it("rejects unsupported definition types before any database call", async () => {
    const service = new DefinitionService();

    await expect(
      service.createDefinition(
        "bar",
        '{"name":"svc","metadata":{},"tools":[]}',
      ),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it("rejects empty definition ids", async () => {
    const service = new DefinitionService();

    await expect(service.getDefinition("   ")).rejects.toMatchObject({
      statusCode: 400,
    });

    await expect(service.deleteDefinition("\n\t")).rejects.toMatchObject({
      statusCode: 400,
    });
  });

  it("rejects empty content", async () => {
    const service = new DefinitionService();

    await expect(service.createDefinition("foo", "   ")).rejects.toMatchObject({
      statusCode: 400,
    });
  });
});
