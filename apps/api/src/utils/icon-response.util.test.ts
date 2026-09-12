import type { Response } from "express";
import { describe, expect, it, vi } from "vitest";

import { sendIconResponse } from "@/utils/icon-response.util";

interface MockResponse {
  status: ReturnType<typeof vi.fn>;
  json: ReturnType<typeof vi.fn>;
  set: ReturnType<typeof vi.fn>;
  send: ReturnType<typeof vi.fn>;
}

const makeRes = (): MockResponse => {
  const res = {} as MockResponse;
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  res.set = vi.fn().mockReturnValue(res);
  res.send = vi.fn().mockReturnValue(res);
  return res;
};

const mockIcon = {
  data: Buffer.from("icon-data"),
  mime: "image/png",
  hash: "abc123",
};

describe("icon-response.util", () => {
  describe("sendIconResponse", () => {
    it("returns 404 with error when icon is null", () => {
      const res = makeRes();

      sendIconResponse(cast(res), null, "Module 'test'");

      expect(res.status).toHaveBeenCalledWith(404);
      expect(res.set).toHaveBeenCalledWith("Cache-Control", "no-cache");
      expect(res.json).toHaveBeenCalledWith({
        error: "Module 'test' has no icon.",
      });
      expect(res.send).not.toHaveBeenCalled();
    });

    it("returns 404 with error when icon is undefined", () => {
      const res = makeRes();

      sendIconResponse(cast(res), undefined, "Service 'svc-1'");

      expect(res.status).toHaveBeenCalledWith(404);
      expect(res.json).toHaveBeenCalledWith({
        error: "Service 'svc-1' has no icon.",
      });
    });

    it("sets correct headers and sends icon data when icon exists", () => {
      const res = makeRes();

      sendIconResponse(cast(res), mockIcon, "Module 'test'");

      expect(res.set).toHaveBeenCalledWith("Content-Type", "image/png");
      expect(res.set).toHaveBeenCalledWith(
        "Cache-Control",
        "public, max-age=86400",
      );
      expect(res.set).toHaveBeenCalledWith("ETag", '"abc123"');
      expect(res.send).toHaveBeenCalledWith(mockIcon.data);
      expect(res.status).not.toHaveBeenCalled();
      expect(res.json).not.toHaveBeenCalled();
    });

    it("uses entityLabel in 404 error message", () => {
      const res = makeRes();

      sendIconResponse(cast(res), null, "Custom Entity Name");

      expect(res.json).toHaveBeenCalledWith({
        error: "Custom Entity Name has no icon.",
      });
    });

    it("sends correct ETag with hash", () => {
      const res = makeRes();
      const customHash = "custom-hash-456";
      const icon = { ...mockIcon, hash: customHash };

      sendIconResponse(cast(res), icon, "Test");

      expect(res.set).toHaveBeenCalledWith("ETag", `"${customHash}"`);
    });

    it("sends correct mime type", () => {
      const res = makeRes();
      const icon = { ...mockIcon, mime: "image/webp" };

      sendIconResponse(cast(res), icon, "Test");

      expect(res.set).toHaveBeenCalledWith("Content-Type", "image/webp");
    });

    it("sends the exact buffer data", () => {
      const res = makeRes();
      const customData = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
      const icon = { ...mockIcon, data: customData };

      sendIconResponse(cast(res), icon, "Test");

      expect(res.send).toHaveBeenCalledWith(customData);
    });
  });
});

function cast(res: MockResponse) {
  return res as unknown as Response;
}
