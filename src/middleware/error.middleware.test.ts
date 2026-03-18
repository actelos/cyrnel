import { describe, expect, it, vi } from "vitest";

import { errorMiddleware } from "@/middleware/error.middleware";
import { HttpError } from "@/models/error";

const makeRes = () => {
  const res: any = {};
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  return res;
};

describe("errorMiddleware", () => {
  it("returns status/message for HttpError", () => {
    const res = makeRes();

    errorMiddleware(new HttpError(400, "Bad request"), {} as any, res, vi.fn());

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ error: "Bad request" });
  });

  it("returns 500 for generic errors", () => {
    const res = makeRes();

    errorMiddleware(new Error("boom"), {} as any, res, vi.fn());

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({ error: "Internal server error." });
  });
});
