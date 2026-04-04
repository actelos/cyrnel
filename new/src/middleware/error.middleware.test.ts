import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/logger", () => ({
  logger: {
    error: vi.fn(),
  },
}));

import { logger } from "@/logger";
import { errorMiddleware } from "@/middleware/error.middleware";

describe("errorMiddleware", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("logs and returns internal server error payload", () => {
    const err = new Error("boom");
    const status = vi.fn().mockReturnThis();
    const json = vi.fn();

    errorMiddleware(
      err,
      {} as never,
      { status, json } as never,
      vi.fn() as never,
    );

    expect(logger.error).toHaveBeenCalledWith({ err }, "request failed");
    expect(status).toHaveBeenCalledWith(500);
    expect(json).toHaveBeenCalledWith({ error: "internal_server_error" });
  });
});
