import type { Response } from "express";

import type { IconFetchResult } from "@/utils/icon.util";

export function sendIconResponse(
  res: Response,
  icon: IconFetchResult | null,
  entityLabel: string,
): void {
  if (!icon) {
    res
      .status(404)
      .set("Cache-Control", "no-cache")
      .json({ error: `${entityLabel} has no icon.` });
    return;
  }

  res.set("Content-Type", icon.mime);
  res.set("Cache-Control", "public, max-age=86400");
  res.set("ETag", `"${icon.hash}"`);
  res.send(icon.data);
}
