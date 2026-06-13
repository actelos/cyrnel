import dns from "node:dns/promises";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ORIGINAL_ALLOWED_IPS = process.env.CYRNEL_ALLOWED_IPS;
const ORIGINAL_BLOCKED_IPS = process.env.CYRNEL_BLOCKED_IPS;
const ORIGINAL_BLOCK_ALL = process.env.CYRNEL_BLOCK_ALL_REGISTRIES;

async function _resolve4Fixture(hostname: string) {
  if (hostname === "example.com") return [{ address: "93.184.216.34" }];
  if (hostname === "localhost") return [{ address: "127.0.0.1" }];
  if (hostname === "10.0.0.1") return [{ address: "10.0.0.1" }];
  return [];
}

describe("download util", () => {
  beforeEach(() => {
    delete process.env.CYRNEL_ALLOWED_IPS;
    delete process.env.CYRNEL_BLOCKED_IPS;
    delete process.env.CYRNEL_BLOCK_ALL_REGISTRIES;
  });

  afterEach(() => {
    if (ORIGINAL_ALLOWED_IPS === undefined) {
      delete process.env.CYRNEL_ALLOWED_IPS;
    } else {
      process.env.CYRNEL_ALLOWED_IPS = ORIGINAL_ALLOWED_IPS;
    }

    if (ORIGINAL_BLOCKED_IPS === undefined) {
      delete process.env.CYRNEL_BLOCKED_IPS;
    } else {
      process.env.CYRNEL_BLOCKED_IPS = ORIGINAL_BLOCKED_IPS;
    }

    if (ORIGINAL_BLOCK_ALL === undefined) {
      delete process.env.CYRNEL_BLOCK_ALL_REGISTRIES;
    } else {
      process.env.CYRNEL_BLOCK_ALL_REGISTRIES = ORIGINAL_BLOCK_ALL;
    }

    vi.restoreAllMocks();
  });

  // -----------------------------------------------------------------------
  // assertRegistryAddressAllowed
  // -----------------------------------------------------------------------
  describe("assertRegistryAddressAllowed", () => {
    it("allows public unicast IPs", async () => {
      vi.spyOn(dns, "lookup").mockResolvedValue([
        { address: "93.184.216.34", family: 4 },
      ] as never);

      const { assertRegistryAddressAllowed } = await import(
        "@/utils/download.util"
      );
      await expect(
        assertRegistryAddressAllowed("https://example.com/file"),
      ).resolves.toBeUndefined();
    });

    it("blocks loopback IPs", async () => {
      const { assertRegistryAddressAllowed } = await import(
        "@/utils/download.util"
      );
      await expect(
        assertRegistryAddressAllowed("https://127.0.0.1/file"),
      ).rejects.toMatchObject({
        statusCode: 502,
        message: "Registry download blocked: address is not publicly routable.",
      });
    });

    it("blocks private IP ranges via DNS resolution", async () => {
      vi.spyOn(dns, "lookup").mockResolvedValue([
        { address: "10.0.0.1", family: 4 },
      ] as never);

      const { assertRegistryAddressAllowed } = await import(
        "@/utils/download.util"
      );
      await expect(
        assertRegistryAddressAllowed("https://internal-registry/file"),
      ).rejects.toMatchObject({
        statusCode: 502,
      });
    });

    it("allows private IPs in the allow list", async () => {
      process.env.CYRNEL_ALLOWED_IPS = "127.0.0.1/32";
      const { assertRegistryAddressAllowed } = await import(
        "@/utils/download.util"
      );

      await expect(
        assertRegistryAddressAllowed("https://127.0.0.1/file"),
      ).resolves.toBeUndefined();
    });

    it("rejects unresolvable hostnames", async () => {
      vi.spyOn(dns, "lookup").mockRejectedValue(new Error("ENOTFOUND"));

      const { assertRegistryAddressAllowed } = await import(
        "@/utils/download.util"
      );
      await expect(
        assertRegistryAddressAllowed("https://nonexistent.example/file"),
      ).rejects.toMatchObject({
        statusCode: 502,
        message: "Failed to resolve registry hostname.",
      });
    });
    it("blocks explicitly blocked IPs", async () => {
      process.env.CYRNEL_BLOCKED_IPS = "127.0.0.1/32";

      const { assertRegistryAddressAllowed } = await import(
        "@/utils/download.util"
      );

      await expect(
        assertRegistryAddressAllowed("https://127.0.0.1/file"),
      ).rejects.toMatchObject({
        statusCode: 502,
      });
    });
    it("allows private IPs in the allow list", async () => {
      process.env.CYRNEL_ALLOWED_IPS = "10.0.0.0/8";

      const { assertRegistryAddressAllowed } = await import(
        "@/utils/download.util"
      );

      await expect(
        assertRegistryAddressAllowed("https://10.0.0.1/file"),
      ).resolves.toBeUndefined();
    });
    it("blocked IPs take precedence over allowed IPs", async () => {
      process.env.CYRNEL_ALLOWED_IPS = "10.0.0.0/8";
      process.env.CYRNEL_BLOCKED_IPS = "10.0.0.100/32";

      const { assertRegistryAddressAllowed } = await import(
        "@/utils/download.util"
      );

      await expect(
        assertRegistryAddressAllowed("https://10.0.0.100/file"),
      ).rejects.toMatchObject({
        statusCode: 502,
      });
    });
    it("blocks all registries when block-all is enabled", async () => {
      process.env.CYRNEL_BLOCK_ALL_REGISTRIES = "true";

      vi.spyOn(dns, "lookup").mockResolvedValue([
        { address: "93.184.216.34", family: 4 },
      ] as never);

      const { assertRegistryAddressAllowed } = await import(
        "@/utils/download.util"
      );

      await expect(
        assertRegistryAddressAllowed("https://example.com/file"),
      ).rejects.toMatchObject({
        statusCode: 502,
      });
    });
    it("allows allowlisted addresses when block-all is enabled", async () => {
      process.env.CYRNEL_BLOCK_ALL_REGISTRIES = "true";
      process.env.CYRNEL_ALLOWED_IPS = "10.0.0.0/8";

      const { assertRegistryAddressAllowed } = await import(
        "@/utils/download.util"
      );

      await expect(
        assertRegistryAddressAllowed("https://10.0.0.1/file"),
      ).resolves.toBeUndefined();
    });
  });

  // -----------------------------------------------------------------------
  // downloadBinary
  // -----------------------------------------------------------------------
  describe("downloadBinary", () => {
    beforeEach(() => {
      vi.spyOn(dns, "lookup").mockResolvedValue([
        { address: "93.184.216.34", family: 4 },
      ] as never);
    });

    it("downloads a valid binary payload", async () => {
      const body = new Uint8Array([1, 2, 3, 4]);
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => ({
          ok: true,
          status: 200,
          headers: new Map(),
          body: new ReadableStream({
            start(controller) {
              controller.enqueue(body);
              controller.close();
            },
          }),
        })),
      );

      const { downloadBinary } = await import("@/utils/download.util");
      const result = await downloadBinary(
        "https://example.com/module.tar.zst",
        10_000,
      );
      expect(Buffer.from(result)).toEqual(Buffer.from(body));
    });

    it("rejects empty payloads with 400", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => ({
          ok: true,
          status: 200,
          headers: new Map(),
          body: new ReadableStream({
            start(controller) {
              controller.close();
            },
          }),
        })),
      );

      const { downloadBinary } = await import("@/utils/download.util");
      await expect(
        downloadBinary("https://example.com/empty.tar.zst", 10_000),
      ).rejects.toMatchObject({
        statusCode: 400,
        message: "Downloaded archive was empty.",
      });
    });

    it("rejects oversize payloads via stream with 413", async () => {
      const chunk = new Uint8Array(6000);
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => ({
          ok: true,
          status: 200,
          headers: new Map(),
          body: new ReadableStream({
            start(controller) {
              controller.enqueue(chunk);
              controller.enqueue(chunk);
              controller.close();
            },
          }),
        })),
      );

      const { downloadBinary } = await import("@/utils/download.util");
      await expect(
        downloadBinary("https://example.com/big.tar.zst", 10_000),
      ).rejects.toMatchObject({
        statusCode: 413,
      });
    });

    it("follows redirects within limit", async () => {
      let callCount = 0;
      vi.stubGlobal(
        "fetch",
        vi.fn(async (_url: string) => {
          callCount++;
          if (callCount < 3) {
            return {
              status: 302,
              headers: new Map([
                ["location", `https://redirect-${callCount}.com`],
              ]),
              body: null,
            };
          }
          return {
            ok: true,
            status: 200,
            headers: new Map(),
            body: new ReadableStream({
              start(controller) {
                controller.enqueue(new Uint8Array([1]));
                controller.close();
              },
            }),
          };
        }),
      );

      const { downloadBinary } = await import("@/utils/download.util");
      await expect(
        downloadBinary("https://example.com/redirect.tar.zst", 10_000),
      ).resolves.toBeDefined();
      expect(callCount).toBe(3);
    });

    it("rejects excessive redirects", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => ({
          status: 302,
          headers: new Map([["location", "https://loop.example"]]),
          body: null,
        })),
      );

      const { downloadBinary } = await import("@/utils/download.util");
      await expect(
        downloadBinary("https://example.com/loop.tar.zst", 10_000),
      ).rejects.toMatchObject({
        statusCode: 502,
        message: "archive download exceeded maximum redirect count.",
      });
    });

    it("rejects non-ok status codes", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => ({
          ok: false,
          status: 404,
          headers: new Map(),
          body: new ReadableStream({
            start(controller) {
              controller.enqueue(new Uint8Array([1]));
              controller.close();
            },
          }),
        })),
      );

      const { downloadBinary } = await import("@/utils/download.util");
      await expect(
        downloadBinary("https://example.com/missing.tar.zst", 10_000),
      ).rejects.toMatchObject({
        statusCode: 502,
        message: "Failed to download archive with status 404.",
      });
    });

    it("rejects oversize via content-length header with 413", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => ({
          ok: true,
          status: 200,
          headers: new Map([["content-length", "50000"]]),
          body: new ReadableStream({
            start(controller) {
              controller.enqueue(new Uint8Array([1]));
              controller.close();
            },
          }),
        })),
      );

      const { downloadBinary } = await import("@/utils/download.util");
      await expect(
        downloadBinary("https://example.com/big.tar.zst", 1000),
      ).rejects.toMatchObject({
        statusCode: 413,
        message: "archive exceeds maximum allowed size of 1000 bytes.",
      });
    });

    it("respects custom label in error messages", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => ({
          status: 302,
          headers: new Map([["location", "https://loop.example"]]),
          body: null,
        })),
      );

      const { downloadBinary } = await import("@/utils/download.util");
      await expect(
        downloadBinary("https://example.com/x", 1000, "custom"),
      ).rejects.toMatchObject({
        statusCode: 502,
        message: "custom download exceeded maximum redirect count.",
      });
    });
  });

  // -----------------------------------------------------------------------
  // downloadText
  // -----------------------------------------------------------------------
  describe("downloadText", () => {
    beforeEach(() => {
      vi.spyOn(dns, "lookup").mockResolvedValue([
        { address: "93.184.216.34", family: 4 },
      ] as never);
    });

    it("downloads and decodes UTF-8 text", async () => {
      const encoder = new TextEncoder();
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => ({
          ok: true,
          status: 200,
          headers: new Map(),
          body: new ReadableStream({
            start(controller) {
              controller.enqueue(encoder.encode('{"name":"test"}'));
              controller.close();
            },
          }),
        })),
      );

      const { downloadText } = await import("@/utils/download.util");
      const result = await downloadText("https://example.com/def.json", 10_000);
      expect(result).toBe('{"name":"test"}');
    });

    it("rejects empty text content with 400", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => ({
          ok: true,
          status: 200,
          headers: new Map(),
          body: new ReadableStream({
            start(controller) {
              controller.close();
            },
          }),
        })),
      );

      const { downloadText } = await import("@/utils/download.util");
      await expect(
        downloadText("https://example.com/empty.json", 10_000),
      ).rejects.toMatchObject({
        statusCode: 400,
        message: "Downloaded definition was empty.",
      });
    });

    it("rejects whitespace-only content as empty", async () => {
      const encoder = new TextEncoder();
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => ({
          ok: true,
          status: 200,
          headers: new Map(),
          body: new ReadableStream({
            start(controller) {
              controller.enqueue(encoder.encode("   \n  "));
              controller.close();
            },
          }),
        })),
      );

      const { downloadText } = await import("@/utils/download.util");
      await expect(
        downloadText("https://example.com/whitespace.json", 10_000),
      ).rejects.toMatchObject({
        statusCode: 400,
      });
    });

    it("respects custom label in error messages", async () => {
      const _encoder = new TextEncoder();
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => ({
          ok: true,
          status: 200,
          headers: new Map(),
          body: new ReadableStream({
            start(controller) {
              controller.close();
            },
          }),
        })),
      );

      const { downloadText } = await import("@/utils/download.util");
      await expect(
        downloadText("https://example.com/x", 1000, "config"),
      ).rejects.toMatchObject({
        statusCode: 400,
        message: "Downloaded config was empty.",
      });
    });

    it("sends accept header", async () => {
      let capturedHeaders: Record<string, string> | undefined;
      vi.stubGlobal(
        "fetch",
        vi.fn(async (_url: string, opts: RequestInit) => {
          capturedHeaders = opts.headers as Record<string, string>;
          return {
            ok: true,
            status: 200,
            headers: new Map(),
            body: new ReadableStream({
              start(controller) {
                controller.enqueue(new TextEncoder().encode("ok"));
                controller.close();
              },
            }),
          };
        }),
      );

      const { downloadText } = await import("@/utils/download.util");
      await downloadText("https://example.com/def.json", 10_000);
      expect(capturedHeaders?.accept).toBe(
        "application/json, text/plain, application/octet-stream",
      );
    });
  });
});
