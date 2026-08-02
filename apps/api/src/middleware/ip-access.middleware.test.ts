import type { Request, Response } from "express";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ipAccessMiddleware } from "@/middleware/ip-access.middleware";
import { HttpError } from "@/models/error.model";

describe("ipAccessMiddleware", () => {
  const originalAllowed = process.env.CYRNEL_ALLOWED_IPS;
  const originalBlocked = process.env.CYRNEL_BLOCKED_IPS;

  afterEach(() => {
    if (originalAllowed === undefined) {
      delete process.env.CYRNEL_ALLOWED_IPS;
    } else {
      process.env.CYRNEL_ALLOWED_IPS = originalAllowed;
    }

    if (originalBlocked === undefined) {
      delete process.env.CYRNEL_BLOCKED_IPS;
    } else {
      process.env.CYRNEL_BLOCKED_IPS = originalBlocked;
    }
  });

  function makeReq(overrides: Partial<Request> = {}): Request {
    return {
      ip: "203.0.113.5",
      socket: { remoteAddress: "203.0.113.5" },
      ...overrides,
    } as unknown as Request;
  }

  function nextError(next: ReturnType<typeof vi.fn>): HttpError {
    const [error] = next.mock.calls[0] as [HttpError];
    return error;
  }

  function makeRequestWithoutAddress(): Request {
    return {
      ip: undefined,
      socket: { remoteAddress: undefined },
    } as unknown as Request;
  }

  it("passes request when no lists are configured", () => {
    delete process.env.CYRNEL_ALLOWED_IPS;
    delete process.env.CYRNEL_BLOCKED_IPS;

    const next = vi.fn();

    ipAccessMiddleware(makeReq(), {} as Response, next);

    expect(next).toHaveBeenCalledOnce();
    expect(next).toHaveBeenCalledWith();
  });

  it("treats whitespace-only env values as unconfigured", () => {
    process.env.CYRNEL_ALLOWED_IPS = "  ";
    process.env.CYRNEL_BLOCKED_IPS = " ";

    const next = vi.fn();

    ipAccessMiddleware(makeReq(), {} as Response, next);

    expect(next).toHaveBeenCalledOnce();
    expect(next).toHaveBeenCalledWith();
  });

  it("rejects request when IP matches a blocked CIDR", () => {
    process.env.CYRNEL_BLOCKED_IPS = "198.51.100.0/24, 203.0.113.0/24";

    const next = vi.fn();

    ipAccessMiddleware(makeReq(), {} as Response, next);

    expect(next).toHaveBeenCalledOnce();
    expect(next).toHaveBeenCalledWith(expect.any(HttpError));

    const error = nextError(next);
    expect(error.statusCode).toBe(403);
    expect(error.message).toBe("Access denied.");
  });

  it("passes request when IP does not match a blocked CIDR", () => {
    process.env.CYRNEL_BLOCKED_IPS = "198.51.100.0/24";

    const next = vi.fn();

    ipAccessMiddleware(makeReq(), {} as Response, next);

    expect(next).toHaveBeenCalledOnce();
    expect(next).toHaveBeenCalledWith();
  });

  it("rejects request when IP is not in the allowed CIDRs", () => {
    process.env.CYRNEL_ALLOWED_IPS = "10.0.0.0/8";

    const next = vi.fn();

    ipAccessMiddleware(makeReq(), {} as Response, next);

    expect(next).toHaveBeenCalledOnce();
    expect(next).toHaveBeenCalledWith(expect.any(HttpError));

    const error = nextError(next);
    expect(error.statusCode).toBe(403);
    expect(error.message).toBe("Access denied.");
  });

  it("passes request when IP is in the allowed CIDRs", () => {
    process.env.CYRNEL_ALLOWED_IPS = "203.0.113.0/24";

    const next = vi.fn();

    ipAccessMiddleware(makeReq(), {} as Response, next);

    expect(next).toHaveBeenCalledOnce();
    expect(next).toHaveBeenCalledWith();
  });

  it("applies the blocklist before the allowlist", () => {
    process.env.CYRNEL_BLOCKED_IPS = "203.0.113.0/24";
    process.env.CYRNEL_ALLOWED_IPS = "0.0.0.0/0";

    const next = vi.fn();

    ipAccessMiddleware(makeReq(), {} as Response, next);

    expect(next).toHaveBeenCalledOnce();
    expect(next).toHaveBeenCalledWith(expect.any(HttpError));
  });

  it("matches IPv4-mapped IPv6 addresses against IPv4 CIDRs", () => {
    process.env.CYRNEL_ALLOWED_IPS = "203.0.113.0/24";

    const next = vi.fn();

    ipAccessMiddleware(
      makeReq({ ip: "::ffff:203.0.113.9" }),
      {} as Response,
      next,
    );

    expect(next).toHaveBeenCalledOnce();
    expect(next).toHaveBeenCalledWith();
  });

  it("falls back to socket.remoteAddress when req.ip is missing", () => {
    process.env.CYRNEL_ALLOWED_IPS = "203.0.113.0/24";

    const next = vi.fn();

    ipAccessMiddleware(makeReq({ ip: undefined }), {} as Response, next);

    expect(next).toHaveBeenCalledOnce();
    expect(next).toHaveBeenCalledWith();
  });

  it("passes request when no address is available and only a blocklist is set", () => {
    process.env.CYRNEL_BLOCKED_IPS = "203.0.113.0/24";

    const next = vi.fn();

    ipAccessMiddleware(makeRequestWithoutAddress(), {} as Response, next);

    expect(next).toHaveBeenCalledOnce();
    expect(next).toHaveBeenCalledWith();
  });

  it("rejects request when no address is available and allowlist is set", () => {
    process.env.CYRNEL_ALLOWED_IPS = "203.0.113.0/24";

    const next = vi.fn();

    ipAccessMiddleware(makeRequestWithoutAddress(), {} as Response, next);

    expect(next).toHaveBeenCalledOnce();
    expect(next).toHaveBeenCalledWith(expect.any(HttpError));

    const error = nextError(next);
    expect(error.statusCode).toBe(403);
    expect(error.message).toBe("Access denied.");
  });
});
