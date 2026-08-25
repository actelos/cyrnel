import dns from "node:dns/promises";

import ipaddr from "ipaddr.js";

import { HttpError } from "@/models/error.model";
import { fetchWithRegistryAuth } from "@/utils/registry-auth.util";

export const MAX_REDIRECTS = 5;
export const DOWNLOAD_TIMEOUT_MS = 10_000;

type ParsedCIDR = [ipaddr.IPv4 | ipaddr.IPv6, number];

export type { ParsedCIDR };

let cachedAllowedIPs: string | undefined;
let cachedAllowedCIDRs: ParsedCIDR[] = [];

let cachedBlockedIPs: string | undefined;
let cachedBlockedCIDRs: ParsedCIDR[] = [];

function isTruthy(value?: string): boolean {
  return value === "1" || value?.toLowerCase() === "true";
}

export function parseCIDRList(value?: string): ParsedCIDR[] {
  if (!value?.trim()) return [];

  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => ipaddr.parseCIDR(entry) as ParsedCIDR);
}

function getAllowedCIDRs(): ParsedCIDR[] {
  const value = process.env.CYRNEL_REGISTRY_ALLOWED_IPS;

  if (value !== cachedAllowedIPs) {
    cachedAllowedIPs = value;
    cachedAllowedCIDRs = parseCIDRList(value);
  }

  return cachedAllowedCIDRs;
}

function getBlockedCIDRs(): ParsedCIDR[] {
  const value = process.env.CYRNEL_REGISTRY_BLOCKED_IPS;

  if (value !== cachedBlockedIPs) {
    cachedBlockedIPs = value;
    cachedBlockedCIDRs = parseCIDRList(value);
  }

  return cachedBlockedCIDRs;
}

function isBlockAllRegistriesEnabled(): boolean {
  return isTruthy(process.env.CYRNEL_BLOCK_ALL_REGISTRIES);
}
export function matchesCIDRs(address: string, cidrs: ParsedCIDR[]): boolean {
  const parsed = ipaddr.process(address);

  return cidrs.some(
    ([range, prefix]) =>
      parsed.kind() === range.kind() && parsed.match(range, prefix),
  );
}

export async function assertRegistryAddressAllowed(url: string): Promise<void> {
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

  let addresses: string[];

  if (ipaddr.isValid(normalizedHost)) {
    addresses = [normalizedHost];
  } else {
    let resolved: { address: string }[];

    try {
      resolved = await dns.lookup(normalizedHost, { all: true });
    } catch {
      throw new HttpError(502, "Failed to resolve registry hostname.");
    }

    if (resolved.length === 0) throw blockedError;

    addresses = resolved.map(({ address }) => address);
  }
  const blockedCIDRs = getBlockedCIDRs();
  const allowedCIDRs = getAllowedCIDRs();

  if (addresses.some((address) => matchesCIDRs(address, blockedCIDRs))) {
    throw blockedError;
  }

  if (addresses.some((address) => matchesCIDRs(address, allowedCIDRs))) {
    return;
  }

  if (isBlockAllRegistriesEnabled()) {
    throw blockedError;
  }
  for (const address of addresses) {
    if (!ipaddr.isValid(address)) throw blockedError;
    if (ipaddr.process(address).range() !== "unicast") {
      throw blockedError;
    }
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
      ({ response: hopResponse } = await fetchWithRegistryAuth(currentUrl, {
        method: "GET",
        headers,
        signal,
      }));
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
