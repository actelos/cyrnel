import { describe, expect, it, vi } from "vitest";

import {
  DefinitionService,
  isUniqueConstraintViolation,
} from "@/services/definition.service";

describe("definition.service unit", () => {
  it("rejects unsupported definition types before any database call", async () => {
    const service = new DefinitionService();

    await expect(
      service.createDefinition(
        "bar",
        "",
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

    await expect(
      service.createDefinition("foo", "", "   "),
    ).rejects.toMatchObject({
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
      description: "",
      hash: "hash-1",
    });

    const installed = await service.installDefinitionFromRegistry(
      "foo",
      "",
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
    expect(createSpy).toHaveBeenCalledWith("foo", "", sourceContent);
    expect(installed).toEqual({
      id: "def-1",
      type: "foo",
      description: "",
      hash: "hash-1",
    });
  });

  it("rejects invalid source file url", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const service = new DefinitionService({ fetchImpl });

    await expect(
      service.installDefinitionFromRegistry("foo", "", "not-a-url"),
    ).rejects.toMatchObject({ statusCode: 400 });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("detects SQLite and Postgres unique-constraint errors", () => {
    expect(
      isUniqueConstraintViolation(
        new Error("UNIQUE constraint failed: manifests.definition_id"),
      ),
    ).toBe(true);

    expect(
      isUniqueConstraintViolation(
        new Error(
          'duplicate key value violates unique constraint "manifests_definition_id_unique"',
        ),
      ),
    ).toBe(true);

    expect(
      isUniqueConstraintViolation({
        code: "23505",
        message: "some driver-specific unique violation",
      }),
    ).toBe(true);
  });

  it("does not mislabel non-unique constraint errors", () => {
    expect(
      isUniqueConstraintViolation(
        new Error("NOT NULL constraint failed: definitions.hash"),
      ),
    ).toBe(false);

    expect(
      isUniqueConstraintViolation(new Error("FOREIGN KEY constraint failed")),
    ).toBe(false);

    expect(
      isUniqueConstraintViolation(new Error("CHECK constraint failed")),
    ).toBe(false);
  });
});
