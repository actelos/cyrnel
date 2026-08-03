import { logger } from "@/logger";
import { HttpError } from "@/models/error.model";
import { downloadBinary } from "@/utils/download.util";
import { computeBinaryHash } from "@/utils/hash.util";

export const MAX_ICON_BYTES = 256 * 1024;

export type IconFetchReason =
  | "download"
  | "hash_mismatch"
  | "bad_magic"
  | "oversized";

export type IconEntityType = "service" | "module";

export interface IconFetchResult {
  data: Buffer;
  mime: string;
  hash: string;
}

export function sniffImageMime(data: Buffer): string | null {
  const head = (start: number, end: number): Buffer =>
    data.subarray(start, end);

  if (
    data.length >= 8 &&
    head(0, 8).equals(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    )
  ) {
    return "image/png";
  }
  if (
    data.length >= 12 &&
    head(0, 4).toString("ascii") === "RIFF" &&
    head(8, 12).toString("ascii") === "WEBP"
  ) {
    return "image/webp";
  }
  return null;
}

export async function fetchAndValidateIcon(
  icon: { url: string; hash: string },
  entityType: IconEntityType,
  entityId: string,
): Promise<IconFetchResult | null> {
  let data: Buffer;
  try {
    data = await downloadBinary(icon.url, MAX_ICON_BYTES, "icon");
  } catch (err) {
    const reason: IconFetchReason =
      err instanceof HttpError && err.statusCode === 413
        ? "oversized"
        : "download";
    logger.warn(
      {
        event: "icon_fetch_failed",
        entityType,
        entityId,
        reason,
        err: {
          message: err instanceof Error ? err.message : String(err),
          statusCode: err instanceof HttpError ? err.statusCode : undefined,
        },
      },
      "Failed to download icon",
    );
    return null;
  }

  if (computeBinaryHash(data) !== icon.hash) {
    logger.warn(
      {
        event: "icon_fetch_failed",
        entityType,
        entityId,
        reason: "hash_mismatch",
      },
      "Icon content hash does not match registry metadata hash",
    );
    return null;
  }

  const mime = sniffImageMime(data);
  if (!mime) {
    logger.warn(
      { event: "icon_fetch_failed", entityType, entityId, reason: "bad_magic" },
      "Icon is not a supported raster image",
    );
    return null;
  }

  return { data, mime, hash: icon.hash };
}

export interface IconColumns {
  iconData: Buffer | null;
  iconMime: string | null;
  iconHash: string | null;
}

export async function resolveIconUpdate(
  registryIcon: { url: string; hash: string } | undefined,
  storedIconHash: string | null,
  entityType: IconEntityType,
  entityId: string,
): Promise<IconColumns | undefined> {
  const iconChanged = (registryIcon?.hash ?? null) !== storedIconHash;

  if (!iconChanged) return undefined;

  if (!registryIcon) {
    return { iconData: null, iconMime: null, iconHash: null };
  }

  const icon = await fetchAndValidateIcon(registryIcon, entityType, entityId);
  if (!icon) return undefined; // re-fetch failed: keep the stored icon

  return {
    iconData: icon.data,
    iconMime: icon.mime,
    iconHash: icon.hash,
  };
}
