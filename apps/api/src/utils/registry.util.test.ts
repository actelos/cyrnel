import { afterEach, describe, expect, it, vi } from "vitest";

import { HttpError } from "@/models/error.model";
import {
  resolveModuleRegistry,
  resolveServiceRegistry,
} from "@/utils/registry.util";

function mockFetchJson(body: unknown, status = 200): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(JSON.stringify(body), {
          status,
          headers: { "content-type": "application/json" },
        }),
    ),
  );
}

function mockFetchError(): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new Error("Network failure");
    }),
  );
}

describe("resolveModuleRegistry", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns downloadUrl from a valid response", async () => {
    mockFetchJson({ downloadUrl: "https://example.com/mod.tar.zst" });
    const result = await resolveModuleRegistry(
      "https://registry.example.com/mod",
    );
    expect(result.downloadUrl).toBe("https://example.com/mod.tar.zst");
    expect(result.hash).toBeUndefined();
  });

  it("returns hash when present", async () => {
    mockFetchJson({
      downloadUrl: "https://example.com/mod.tar.zst",
      hash: "abc123",
    });
    const result = await resolveModuleRegistry(
      "https://registry.example.com/mod",
    );
    expect(result.downloadUrl).toBe("https://example.com/mod.tar.zst");
    expect(result.hash).toBe("abc123");
  });

  it("throws 400 when downloadUrl is missing", async () => {
    mockFetchJson({});
    await expect(
      resolveModuleRegistry("https://registry.example.com/mod"),
    ).rejects.toBeInstanceOf(HttpError);
  });

  it("throws 400 when downloadUrl is empty", async () => {
    mockFetchJson({ downloadUrl: "" });
    await expect(
      resolveModuleRegistry("https://registry.example.com/mod"),
    ).rejects.toBeInstanceOf(HttpError);
  });

  it("throws 400 when downloadUrl is not a string", async () => {
    mockFetchJson({ downloadUrl: 123 });
    await expect(
      resolveModuleRegistry("https://registry.example.com/mod"),
    ).rejects.toBeInstanceOf(HttpError);
  });

  it("throws 400 when registry returns invalid JSON", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("not-json", { status: 200 })),
    );
    await expect(
      resolveModuleRegistry("https://registry.example.com/mod"),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it("throws 502 on fetch failure", async () => {
    mockFetchError();
    await expect(
      resolveModuleRegistry("https://registry.example.com/mod"),
    ).rejects.toMatchObject({ statusCode: 502 });
  });

  it("throws 502 on non-OK response", async () => {
    mockFetchJson({ error: "not found" }, 404);
    await expect(
      resolveModuleRegistry("https://registry.example.com/mod"),
    ).rejects.toMatchObject({ statusCode: 502 });
  });

  it("trims downloadUrl whitespace", async () => {
    mockFetchJson({ downloadUrl: "  https://example.com/mod.tar.zst  " });
    const result = await resolveModuleRegistry(
      "https://registry.example.com/mod",
    );
    expect(result.downloadUrl).toBe("https://example.com/mod.tar.zst");
  });

  it("throws 400 when hash is present but empty", async () => {
    mockFetchJson({
      downloadUrl: "https://example.com/mod.tar.zst",
      hash: "",
    });
    await expect(
      resolveModuleRegistry("https://registry.example.com/mod"),
    ).rejects.toBeInstanceOf(HttpError);
  });
});

describe("resolveServiceRegistry", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns downloadUrl from a valid response", async () => {
    mockFetchJson({ downloadUrl: "https://example.com/svc.json" });
    const result = await resolveServiceRegistry(
      "https://registry.example.com/svc",
    );
    expect(result.downloadUrl).toBe("https://example.com/svc.json");
    expect(result.hash).toBeUndefined();
    expect(result.id).toBeUndefined();
    expect(result.adapter).toBeUndefined();
  });

  it("returns optional fields when present", async () => {
    mockFetchJson({
      downloadUrl: "https://example.com/svc.json",
      hash: "def456",
      id: "my-service",
      adapter: "my-adapter",
    });
    const result = await resolveServiceRegistry(
      "https://registry.example.com/svc",
    );
    expect(result.downloadUrl).toBe("https://example.com/svc.json");
    expect(result.hash).toBe("def456");
    expect(result.id).toBe("my-service");
    expect(result.adapter).toBe("my-adapter");
  });

  it("throws 400 when downloadUrl is missing", async () => {
    mockFetchJson({});
    await expect(
      resolveServiceRegistry("https://registry.example.com/svc"),
    ).rejects.toBeInstanceOf(HttpError);
  });

  it("throws 502 on fetch failure", async () => {
    mockFetchError();
    await expect(
      resolveServiceRegistry("https://registry.example.com/svc"),
    ).rejects.toMatchObject({ statusCode: 502 });
  });

  it("throws 400 when id is present but empty", async () => {
    mockFetchJson({
      downloadUrl: "https://example.com/svc.json",
      id: "",
    });
    await expect(
      resolveServiceRegistry("https://registry.example.com/svc"),
    ).rejects.toBeInstanceOf(HttpError);
  });

  it("throws 400 when adapter is present but empty", async () => {
    mockFetchJson({
      downloadUrl: "https://example.com/svc.json",
      adapter: "",
    });
    await expect(
      resolveServiceRegistry("https://registry.example.com/svc"),
    ).rejects.toBeInstanceOf(HttpError);
  });

  it("trims all string fields", async () => {
    mockFetchJson({
      downloadUrl: "  https://example.com/svc.json  ",
      hash: "  abc  ",
      id: "  my-svc  ",
      adapter: "  my-adapter  ",
    });
    const result = await resolveServiceRegistry(
      "https://registry.example.com/svc",
    );
    expect(result.downloadUrl).toBe("https://example.com/svc.json");
    expect(result.hash).toBe("abc");
    expect(result.id).toBe("my-svc");
    expect(result.adapter).toBe("my-adapter");
  });
});
