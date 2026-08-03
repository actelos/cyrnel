import { afterEach, describe, expect, it, vi } from "vitest";

import { HttpError } from "@/models/error.model";
import { computeBinaryHash } from "@/utils/hash.util";

vi.mock("@/utils/download.util", () => ({
  downloadBinary: vi.fn(),
}));

import { downloadBinary } from "@/utils/download.util";
import { fetchAndValidateIcon, sniffImageMime } from "@/utils/icon.util";

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(16),
]);

const JPEG = Buffer.concat([
  Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
  Buffer.alloc(16),
]);

const GIF = Buffer.concat([Buffer.from("GIF89a", "ascii"), Buffer.alloc(16)]);

const WEBP = Buffer.concat([
  Buffer.from("RIFF", "ascii"),
  Buffer.alloc(4),
  Buffer.from("WEBP", "ascii"),
  Buffer.alloc(16),
]);

const SVG = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg"></svg>',
  "utf8",
);

const mockDownload = (data: Buffer | HttpError): void => {
  if (data instanceof HttpError) {
    vi.mocked(downloadBinary).mockRejectedValueOnce(data);
  } else {
    vi.mocked(downloadBinary).mockResolvedValueOnce(data);
  }
};

describe("sniffImageMime", () => {
  it("detects png and webp magic bytes", () => {
    expect(sniffImageMime(PNG)).toBe("image/png");
    expect(sniffImageMime(WEBP)).toBe("image/webp");
  });

  it("rejects jpeg, gif, svg and unknown content", () => {
    expect(sniffImageMime(JPEG)).toBeNull();
    expect(sniffImageMime(GIF)).toBeNull();
    expect(sniffImageMime(SVG)).toBeNull();
    expect(sniffImageMime(Buffer.from("not an image", "utf8"))).toBeNull();
    expect(sniffImageMime(Buffer.alloc(0))).toBeNull();
  });
});

describe("fetchAndValidateIcon", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("returns data, mime and hash for a valid png", async () => {
    mockDownload(PNG);
    const icon = {
      url: "https://example.com/icon.png",
      hash: computeBinaryHash(PNG),
    };
    const result = await fetchAndValidateIcon(icon, "service", "alpha");
    expect(result).toEqual({ data: PNG, mime: "image/png", hash: icon.hash });
    expect(downloadBinary).toHaveBeenCalledWith(
      "https://example.com/icon.png",
      256 * 1024,
      "icon",
    );
  });

  it("returns null when the content hash does not match", async () => {
    mockDownload(PNG);
    const result = await fetchAndValidateIcon(
      { url: "https://example.com/icon.png", hash: "deadbeef" },
      "module",
      "beta",
    );
    expect(result).toBeNull();
  });

  it("returns null when the content is not a supported raster image", async () => {
    mockDownload(SVG);
    const result = await fetchAndValidateIcon(
      {
        url: "https://example.com/icon.svg",
        hash: computeBinaryHash(SVG),
      },
      "service",
      "gamma",
    );
    expect(result).toBeNull();
  });

  it("returns null for jpeg content even with a matching hash", async () => {
    mockDownload(JPEG);
    const result = await fetchAndValidateIcon(
      {
        url: "https://example.com/icon.png",
        hash: computeBinaryHash(JPEG),
      },
      "service",
      "gamma2",
    );
    expect(result).toBeNull();
  });

  it("returns null when the download fails", async () => {
    mockDownload(new HttpError(502, "Failed to download icon."));
    const result = await fetchAndValidateIcon(
      { url: "https://example.com/icon.png", hash: "abc" },
      "module",
      "delta",
    );
    expect(result).toBeNull();
  });

  it("returns null when the download is oversized", async () => {
    mockDownload(
      new HttpError(413, "icon exceeds maximum allowed size of 262144 bytes."),
    );
    const result = await fetchAndValidateIcon(
      { url: "https://example.com/icon.png", hash: "abc" },
      "service",
      "epsilon",
    );
    expect(result).toBeNull();
  });

  it("verifies mime by magic bytes regardless of any remote content-type", async () => {
    mockDownload(WEBP);
    const result = await fetchAndValidateIcon(
      { url: "https://example.com/icon.png", hash: computeBinaryHash(WEBP) },
      "service",
      "zeta",
    );
    expect(result?.mime).toBe("image/webp");
  });
});
