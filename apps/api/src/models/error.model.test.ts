import { describe, expect, it } from "vitest";

import { HttpError } from "@/models/error.model";

describe("HttpError", () => {
  it("sets statusCode, message and name", () => {
    const error = new HttpError(404, "Not found");

    expect(error).toBeInstanceOf(Error);
    expect(error.statusCode).toBe(404);
    expect(error.message).toBe("Not found");
    expect(error.name).toBe("HttpError");
  });

  it("preserves custom messages", () => {
    const error = new HttpError(429, "Too many requests.");

    expect(error.message).toBe("Too many requests.");
  });
});
