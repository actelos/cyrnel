import type { Request, Response } from "express";
import { afterEach, describe, expect, it, vi } from "vitest";

import { apiKeyMiddleware } from "@/middleware/auth.middleware";
import { HttpError } from "@/models/error.model";

describe("apiKeyMiddleware", () => {
  const originalApiKey = process.env.MCI_API_KEY;

  afterEach(() => {
    if (originalApiKey === undefined) {
      delete process.env.MCI_API_KEY;
      return;
    }

    process.env.MCI_API_KEY = originalApiKey;
  });

  it("passes request with matching bearer token", () => {
    process.env.MCI_API_KEY = "secret-key";

    const next = vi.fn();
    const req = {
      header: vi.fn().mockReturnValue("Bearer secret-key"),
    } as unknown as Request;

    apiKeyMiddleware(req, {} as Response, next);

    expect(next).toHaveBeenCalledOnce();
    expect(next).toHaveBeenCalledWith();
  });

  it("rejects request when token is missing", () => {
    process.env.MCI_API_KEY = "secret-key";

    const next = vi.fn();
    const req = {
      header: vi.fn().mockReturnValue(undefined),
    } as unknown as Request;

    apiKeyMiddleware(req, {} as Response, next);

    expect(next).toHaveBeenCalledOnce();
    expect(next).toHaveBeenCalledWith(expect.any(HttpError));

    const [error] = next.mock.calls[0] as [HttpError];
    expect(error.statusCode).toBe(401);
    expect(error.message).toBe("Unauthorized");
  });

  it("rejects request when token does not match", () => {
    process.env.MCI_API_KEY = "secret-key";

    const next = vi.fn();
    const req = {
      header: vi.fn().mockReturnValue("Bearer wrong-key"),
    } as unknown as Request;

    apiKeyMiddleware(req, {} as Response, next);

    expect(next).toHaveBeenCalledOnce();
    expect(next).toHaveBeenCalledWith(expect.any(HttpError));

    const [error] = next.mock.calls[0] as [HttpError];
    expect(error.statusCode).toBe(401);
    expect(error.message).toBe("Unauthorized");
  });

  it("passes request when api key is not configured", () => {
    delete process.env.MCI_API_KEY;

    const next = vi.fn();
    const req = {
      header: vi.fn().mockReturnValue("Bearer secret-key"),
    } as unknown as Request;

    apiKeyMiddleware(req, {} as Response, next);

    expect(next).toHaveBeenCalledOnce();
    expect(next).toHaveBeenCalledWith();
  });
});
