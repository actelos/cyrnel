import dns from "node:dns/promises";

import ipaddr from "ipaddr.js";

import { HttpError } from "@/models/error.model";

export const MAX_REDIRECTS = 5;
export const DOWNLOAD_TIMEOUT_MS = 10_000;

export function isPrivateRegistryAllowed(): boolean {
  const v = process.env.MCI_ALLOW_PRIVATE_REGISTRY;
  return v === "1" || v?.toLowerCase() === "true";
}

export async function assertRegistryAddressAllowed(url: string): Promise<void> {
  if (isPrivateRegistryAllowed()) return;

  let hostname: string;

  try {
    hostname = new URL(url).hostname.trim().toLowerCase();
  } catch {
    throw new HttpError(502, "Registry download redirected to an invalid URL.");
  }

  const normalizedHost =
    hostname.startsWith("[") && hostname.endsWith("]")
      ? hostname.slice(1, -1)
      : hostname;

  const blockedError = new HttpError(
    502,
    "Registry download blocked: address is not publicly routable.",
  );

  if (ipaddr.isValid(normalizedHost)) {
    if (ipaddr.process(normalizedHost).range() !== "unicast") {
      throw blockedError;
    }
    return;
  }

  let resolved: { address: string }[];
  try {
    resolved = await dns.lookup(normalizedHost, { all: true });
  } catch {
    throw new HttpError(502, "Failed to resolve registry hostname.");
  }

  if (resolved.length === 0) throw blockedError;

  for (const { address } of resolved) {
    if (!ipaddr.isValid(address)) throw blockedError;
    if (ipaddr.process(address).range() !== "unicast") throw blockedError;
  }
}

interface FetchStreamResult {
  response: Response;
  body: ReadableStream<Uint8Array>;
}

async function fetchStream(
  fileUrl: string,
  maxBytes: number,
  label: string,
  headers?: Record<string, string>,
  signal?: AbortSignal,
): Promise<FetchStreamResult> {
  let currentUrl = fileUrl;
  for (let hop = 0; ; hop++) {
    await assertRegistryAddressAllowed(currentUrl);

    let hopResponse: Response;
    try {
      hopResponse = await fetch(currentUrl, {
        method: "GET",
        headers,
        signal,
        redirect: "manual",
      });
    } catch {
      if (signal?.aborted)
        throw new HttpError(502, `${label} download timed out.`);
      throw new HttpError(502, `Failed to download ${label}.`);
    }

    const isRedirect =
      hopResponse.status >= 300 &&
      hopResponse.status < 400 &&
      hopResponse.status !== 304;

    if (!isRedirect) {
      const sizeError = `${label} exceeds maximum allowed size of ${maxBytes} bytes.`;
      const contentLength = hopResponse.headers.get("content-length");
      if (
        contentLength &&
        Number.isFinite(+contentLength) &&
        +contentLength > maxBytes
      ) {
        throw new HttpError(413, sizeError);
      }

      if (!hopResponse.body) {
        throw new HttpError(
          502,
          `Downloaded ${label} did not include a response body.`,
        );
      }

      return { response: hopResponse, body: hopResponse.body };
    }

    if (hop >= MAX_REDIRECTS) {
      throw new HttpError(
        502,
        `${label} download exceeded maximum redirect count.`,
      );
    }

    const location = hopResponse.headers.get("location");
    if (!location) {
      throw new HttpError(
        502,
        `${label} download redirect was missing a Location header.`,
      );
    }

    let nextUrl: string;
    try {
      nextUrl = new URL(location, currentUrl).toString();
    } catch {
      throw new HttpError(
        502,
        `${label} download redirected to an invalid URL.`,
      );
    }

    await hopResponse.body?.cancel().catch(() => {});
    currentUrl = nextUrl;
  }
}

export async function downloadBinary(
  fileUrl: string,
  maxBytes: number,
  label = "archive",
): Promise<Buffer> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);

  try {
    const { response, body } = await fetchStream(
      fileUrl,
      maxBytes,
      label,
      undefined,
      controller.signal,
    );

    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new HttpError(
        502,
        `Failed to download ${label} with status ${response.status}.`,
      );
    }

    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        total += value.byteLength;
        if (total > maxBytes) {
          await reader.cancel();
          throw new HttpError(
            413,
            `${label} exceeds maximum allowed size of ${maxBytes} bytes.`,
          );
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }

    if (total === 0) {
      throw new HttpError(400, `Downloaded ${label} was empty.`);
    }

    return Buffer.concat(chunks);
  } finally {
    clearTimeout(timeout);
  }
}

export async function downloadText(
  fileUrl: string,
  maxBytes: number,
  label = "definition",
): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);

  try {
    const { response, body } = await fetchStream(
      fileUrl,
      maxBytes,
      label,
      {
        accept: "application/json, text/plain, application/octet-stream",
      },
      controller.signal,
    );

    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new HttpError(
        502,
        `Failed to download ${label} with status ${response.status}.`,
      );
    }

    const reader = body.getReader();
    const decoder = new TextDecoder("utf-8");
    let total = 0;
    let content = "";

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        total += value.byteLength;
        if (total > maxBytes) {
          await reader.cancel();
          throw new HttpError(
            413,
            `${label} exceeds maximum allowed size of ${maxBytes} bytes.`,
          );
        }
        content += decoder.decode(value, { stream: true });
      }
      content += decoder.decode();
    } finally {
      reader.releaseLock();
    }

    if (!content.trim()) {
      throw new HttpError(400, `Downloaded ${label} was empty.`);
    }

    return content;
  } finally {
    clearTimeout(timeout);
  }
}
