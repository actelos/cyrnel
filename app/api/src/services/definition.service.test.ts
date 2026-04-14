import { describe, expect, it, vi } from "vitest";

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

  it("downloads and installs a definition from registry", async () => {
    const sourceContent = '{"name":"svc","metadata":{},"tools":[]}';
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(sourceContent, { status: 200 }));
    const service = new DefinitionService({ fetchImpl });

    const createSpy = vi.spyOn(service, "createDefinition").mockResolvedValue({
      id: "def-1",
      type: "foo",
      hash: "hash-1",
    });

    const installed = await service.installDefinitionFromRegistry(
      "foo",
      "https://registry.example.com/my-definition.json",
    );

    expect(fetchImpl).toHaveBeenCalledWith(
      "https://registry.example.com/my-definition.json",
      {
        method: "GET",
        headers: {
          accept: "application/json, text/plain, application/octet-stream",
        },
      },
    );
    expect(createSpy).toHaveBeenCalledWith("foo", sourceContent);
    expect(installed).toEqual({
      id: "def-1",
      type: "foo",
      hash: "hash-1",
    });
  });

  it("rejects invalid source file url", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const service = new DefinitionService({ fetchImpl });

    await expect(
      service.installDefinitionFromRegistry("foo", "not-a-url"),
    ).rejects.toMatchObject({ statusCode: 400 });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
