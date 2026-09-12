import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  dispatcherForUrl,
  httpDispatcherSingleton,
  httpsDispatcherSingleton,
} from "@/utils/secure-dispatcher";

const originalEnv = { ...process.env };

beforeEach(() => {
  vi.unstubAllGlobals();
  process.env = { ...originalEnv };
});

afterEach(() => {
  process.env = originalEnv;
  vi.unstubAllGlobals();
});

describe("secure-dispatcher", () => {
  describe("httpsDispatcherSingleton", () => {
    it("returns an Agent instance", () => {
      const dispatcher = httpsDispatcherSingleton();
      expect(dispatcher).toBeInstanceOf(require("undici").Agent);
    });

    it("returns the same instance on subsequent calls", () => {
      const d1 = httpsDispatcherSingleton();
      const d2 = httpsDispatcherSingleton();
      expect(d1).toBe(d2);
    });
  });

  describe("httpDispatcherSingleton", () => {
    it("returns an Agent instance", () => {
      const dispatcher = httpDispatcherSingleton();
      expect(dispatcher).toBeInstanceOf(require("undici").Agent);
    });

    it("returns the same instance on subsequent calls", () => {
      const d1 = httpDispatcherSingleton();
      const d2 = httpDispatcherSingleton();
      expect(d1).toBe(d2);
    });
  });

  describe("dispatcherForUrl", () => {
    it("returns https dispatcher for https URLs", () => {
      const dispatcher = dispatcherForUrl("https://example.com/api");
      expect(dispatcher).toBe(httpsDispatcherSingleton());
    });

    it("returns http dispatcher for http URLs", () => {
      const dispatcher = dispatcherForUrl("http://example.com/api");
      expect(dispatcher).toBe(httpDispatcherSingleton());
    });

    it("returns undefined for invalid URLs", () => {
      expect(dispatcherForUrl("not-a-url")).toBeUndefined();
    });

    it("returns undefined for non-http(s) protocols", () => {
      expect(dispatcherForUrl("ftp://example.com")).toBeUndefined();
      expect(dispatcherForUrl("ws://example.com")).toBeUndefined();
      expect(dispatcherForUrl("wss://example.com")).toBeUndefined();
    });

    it("handles URLs with paths and query strings", () => {
      expect(dispatcherForUrl("https://example.com/path?query=1")).toBe(
        httpsDispatcherSingleton(),
      );
      expect(dispatcherForUrl("http://example.com:8080/path")).toBe(
        httpDispatcherSingleton(),
      );
    });

    it("handles URLs with authentication", () => {
      expect(dispatcherForUrl("https://user:pass@example.com")).toBe(
        httpsDispatcherSingleton(),
      );
      expect(dispatcherForUrl("http://user:pass@example.com")).toBe(
        httpDispatcherSingleton(),
      );
    });

    it("handles URLs with IPv6 host", () => {
      expect(dispatcherForUrl("https://[::1]:8080/path")).toBe(
        httpsDispatcherSingleton(),
      );
      expect(dispatcherForUrl("http://[::1]:8080/path")).toBe(
        httpDispatcherSingleton(),
      );
    });
  });

  describe("dispatcher singleton isolation", () => {
    it("https and http dispatchers are different instances", () => {
      const https = httpsDispatcherSingleton();
      const http = httpDispatcherSingleton();
      expect(https).not.toBe(http);
    });

    it("multiple calls to dispatcherForUrl return same dispatcher for same protocol", () => {
      const d1 = dispatcherForUrl("https://a.com");
      const d2 = dispatcherForUrl("https://b.com");
      expect(d1).toBe(d2);

      const d3 = dispatcherForUrl("http://a.com");
      const d4 = dispatcherForUrl("http://b.com");
      expect(d3).toBe(d4);
    });
  });

  describe("environment variable handling", () => {
    it("dispatchers are created without env vars set", () => {
      delete process.env.CYRNEL_REGISTRY_BLOCKED_IPS;
      delete process.env.CYRNEL_REGISTRY_ALLOWED_IPS;
      delete process.env.CYRNEL_BLOCK_ALL_REGISTRIES;
      delete process.env.CYRNEL_REGISTRY_AUTH_INSECURE_CIDRS;

      const https = httpsDispatcherSingleton();
      const http = httpDispatcherSingleton();

      expect(https).toBeInstanceOf(require("undici").Agent);
      expect(http).toBeInstanceOf(require("undici").Agent);
    });

    it("dispatchers are created with all env vars set", () => {
      process.env.CYRNEL_REGISTRY_BLOCKED_IPS = "10.0.0.0/8";
      process.env.CYRNEL_REGISTRY_ALLOWED_IPS = "192.168.1.0/24";
      process.env.CYRNEL_BLOCK_ALL_REGISTRIES = "true";
      process.env.CYRNEL_REGISTRY_AUTH_INSECURE_CIDRS = "172.16.0.0/12";

      const https = httpsDispatcherSingleton();
      const http = httpDispatcherSingleton();

      expect(https).toBeInstanceOf(require("undici").Agent);
      expect(http).toBeInstanceOf(require("undici").Agent);
    });
  });
});
