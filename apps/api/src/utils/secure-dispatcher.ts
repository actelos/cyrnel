import dns from "node:dns";

import ipaddr from "ipaddr.js";
import { Agent } from "undici";

type ParsedCIDR = [ipaddr.IPv4 | ipaddr.IPv6, number];

function parseCIDRList(value?: string): ParsedCIDR[] {
  if (!value?.trim()) return [];
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => ipaddr.parseCIDR(entry) as ParsedCIDR);
}

function matchesCIDRs(address: string, cidrs: ParsedCIDR[]): boolean {
  const parsed = ipaddr.process(address);
  return cidrs.some(
    ([range, prefix]) =>
      parsed.kind() === range.kind() && parsed.match(range, prefix),
  );
}

function isTruthy(value?: string): boolean {
  return value === "1" || value?.toLowerCase() === "true";
}

function readCIDRs(envKey: string): ParsedCIDR[] {
  return parseCIDRList(process.env[envKey]);
}

function isLoopback(address: string): boolean {
  try {
    const parsed = ipaddr.process(address);
    if (parsed.kind() === "ipv4") return parsed.range() === "loopback";
    if (parsed.range() === "ipv4Mapped") {
      return (parsed as ipaddr.IPv6).toIPv4Address().range() === "loopback";
    }
    return parsed.range() === "loopback";
  } catch {
    return false;
  }
}

function ssrfKeeps(address: string): boolean {
  const blocked = readCIDRs("CYRNEL_REGISTRY_BLOCKED_IPS");
  if (matchesCIDRs(address, blocked)) return false;
  const allowed = readCIDRs("CYRNEL_REGISTRY_ALLOWED_IPS");
  if (matchesCIDRs(address, allowed)) return true;
  if (isTruthy(process.env.CYRNEL_BLOCK_ALL_REGISTRIES)) return false;
  if (!ipaddr.isValid(address)) return false;
  try {
    return ipaddr.process(address).range() === "unicast";
  } catch {
    return false;
  }
}

function httpTransportKeeps(address: string): boolean {
  const loopback = isLoopback(address);
  let insecure = false;
  try {
    insecure = matchesCIDRs(
      address,
      readCIDRs("CYRNEL_REGISTRY_AUTH_INSECURE_CIDRS"),
    );
  } catch {
    insecure = false;
  }
  if (!loopback && !insecure) return false;
  return ssrfKeeps(address);
}

type LookupCallback = (
  err: NodeJS.ErrnoException | null,
  address: string | dns.LookupAddress[],
  family?: number,
) => void;

function makeLookup(mode: "ssrf" | "http-strict") {
  const keeps = mode === "http-strict" ? httpTransportKeeps : ssrfKeeps;
  return (
    hostname: string,
    options: dns.LookupOptions,
    callback: LookupCallback,
  ): void => {
    const normalized =
      hostname.startsWith("[") && hostname.endsWith("]")
        ? hostname.slice(1, -1)
        : hostname;
    if (ipaddr.isValid(normalized)) {
      const family = ipaddr.process(normalized).kind() === "ipv6" ? 6 : 4;
      callback(null, normalized, family);
      return;
    }
    dns.lookup(
      normalized,
      { ...options, all: true, verbatim: true },
      (err, addresses) => {
        if (err) {
          callback(err, "", 0);
          return;
        }
        const list = (
          Array.isArray(addresses) ? addresses : [addresses]
        ) as dns.LookupAddress[];
        const survivors = list.filter((entry) => {
          try {
            return keeps(entry.address);
          } catch {
            return false;
          }
        });
        if (survivors.length === 0) {
          const denied = new Error(
            `DNS lookup for '${hostname}' returned no allowed addresses.`,
          ) as NodeJS.ErrnoException;
          denied.code = "ENOTFOUND";
          callback(denied, "", 0);
          return;
        }
        if ((options as dns.LookupOptions & { all?: boolean }).all) {
          callback(null, survivors);
          return;
        }
        callback(null, survivors[0].address, survivors[0].family);
      },
    );
  };
}

export type FetchDispatcher = NonNullable<
  NonNullable<Parameters<typeof fetch>[1]> & { dispatcher?: unknown }
>["dispatcher"];

let httpsDispatcher: Agent | null = null;
let httpDispatcher: Agent | null = null;

export function httpsDispatcherSingleton(): Agent {
  if (!httpsDispatcher) {
    httpsDispatcher = new Agent({ connect: { lookup: makeLookup("ssrf") } });
  }
  return httpsDispatcher;
}

export function httpDispatcherSingleton(): Agent {
  if (!httpDispatcher) {
    httpDispatcher = new Agent({
      connect: { lookup: makeLookup("http-strict") },
    });
  }
  return httpDispatcher;
}

export function dispatcherForUrl(url: string): FetchDispatcher | undefined {
  let protocol: string;
  try {
    protocol = new URL(url).protocol;
  } catch {
    return undefined;
  }
  if (protocol === "https:")
    return httpsDispatcherSingleton() as unknown as FetchDispatcher;
  if (protocol === "http:")
    return httpDispatcherSingleton() as unknown as FetchDispatcher;
  return undefined;
}
