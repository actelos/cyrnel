import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createRateLimiter,
  globalRateLimiter,
} from "@/middleware/rate-limit.middleware";
import { logger } from "@/services/log.service";

vi.mock("@/services/log.service", () => ({
  logger: {
    warn: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
  },
}));

describe("globalRateLimiter", () => {
  const originalMax = process.env.CYRNEL_RATE_LIMIT_MAX;
  const originalWindowMs = process.env.CYRNEL_RATE_LIMIT_WINDOW_MS;

  afterEach(() => {
    if (originalMax === undefined) {
      delete process.env.CYRNEL_RATE_LIMIT_MAX;
    } else {
      process.env.CYRNEL_RATE_LIMIT_MAX = originalMax;
    }

    if (originalWindowMs === undefined) {
      delete process.env.CYRNEL_RATE_LIMIT_WINDOW_MS;
    } else {
      process.env.CYRNEL_RATE_LIMIT_WINDOW_MS = originalWindowMs;
    }
  });

  it("returns null when env vars are unset", () => {
    delete process.env.CYRNEL_RATE_LIMIT_MAX;
    delete process.env.CYRNEL_RATE_LIMIT_WINDOW_MS;

    expect(globalRateLimiter()).toBeNull();
  });

  it("returns null when only one env var is set", () => {
    process.env.CYRNEL_RATE_LIMIT_MAX = "10";
    delete process.env.CYRNEL_RATE_LIMIT_WINDOW_MS;

    expect(globalRateLimiter()).toBeNull();
  });

  it("returns null for non-numeric values", () => {
    process.env.CYRNEL_RATE_LIMIT_MAX = "ten";
    process.env.CYRNEL_RATE_LIMIT_WINDOW_MS = "60000";

    expect(globalRateLimiter()).toBeNull();
  });

  it("returns null for non-finite values", () => {
    process.env.CYRNEL_RATE_LIMIT_MAX = "Infinity";
    process.env.CYRNEL_RATE_LIMIT_WINDOW_MS = "60000";

    expect(globalRateLimiter()).toBeNull();
  });

  it("returns null for values below 1", () => {
    process.env.CYRNEL_RATE_LIMIT_MAX = "0";
    process.env.CYRNEL_RATE_LIMIT_WINDOW_MS = "-100";

    expect(globalRateLimiter()).toBeNull();
  });

  it("returns a middleware when both values are valid", () => {
    process.env.CYRNEL_RATE_LIMIT_MAX = "100";
    process.env.CYRNEL_RATE_LIMIT_WINDOW_MS = "60000";

    const limiter = globalRateLimiter();

    expect(limiter).toBeTypeOf("function");
  });
});

describe("createRateLimiter", () => {
  let server: Server | undefined;

  afterEach(async () => {
    vi.mocked(logger.warn).mockClear();
    if (!server) return;
    await new Promise<void>((resolve, reject) =>
      server!.close((err) => (err ? reject(err) : resolve())),
    );
    server = undefined;
  });

  async function startServer(): Promise<string> {
    const app = express();
    app.use(createRateLimiter(2, 60_000, "test-route"));
    app.get("/", (_req, res) => {
      res.json({ ok: true });
    });

    server = app.listen(0);
    await new Promise<void>((resolve) => server!.once("listening", resolve));
    const { port } = server.address() as AddressInfo;
    return `http://127.0.0.1:${port}`;
  }

  it("rejects requests beyond the max with a 429 payload", async () => {
    const baseUrl = await startServer();

    const first = await fetch(`${baseUrl}/`);
    const second = await fetch(`${baseUrl}/`);
    const third = await fetch(`${baseUrl}/`);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(third.status).toBe(429);
    expect(await third.json()).toEqual({
      error: "rate_limit_exceeded",
      message: "Too many requests. Try again in 60 seconds.",
      retryAfter: 60,
    });
  });

  it("computes retryAfter from the window", async () => {
    const app = express();
    app.use(createRateLimiter(1, 5_000, "short-window"));
    app.get("/", (_req, res) => {
      res.json({ ok: true });
    });

    server = app.listen(0);
    await new Promise<void>((resolve) => server!.once("listening", resolve));
    const { port } = server.address() as AddressInfo;

    const first = await fetch(`http://127.0.0.1:${port}/`);
    const second = await fetch(`http://127.0.0.1:${port}/`);

    expect(first.status).toBe(200);
    expect(second.status).toBe(429);
    const body = (await second.json()) as { retryAfter: number };
    expect(body.retryAfter).toBe(5);
  });

  it("logs a warning with the route label when rate limited", async () => {
    const baseUrl = await startServer();

    await fetch(`${baseUrl}/`);
    await fetch(`${baseUrl}/`);
    await fetch(`${baseUrl}/`);

    expect(logger.warn).toHaveBeenCalledOnce();
    expect(logger.warn).toHaveBeenCalledWith(
      { event: "rate-limit-exceeded", rateLimited: true, route: "test-route" },
      "Rate limit exceeded",
    );
  });
});
