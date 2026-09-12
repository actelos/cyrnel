import { satisfies } from "semver";

import { HttpError } from "@/models/error.model";

export const KIND_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*@\d+(?:\.\d+){0,2}$/;

export interface DefinitionKind {
  identifier: string;
  version: string;
}

export interface CompatibilityEntry {
  identifier: string;
  version: string;
}

export interface RankableAdapter {
  id: string;
  name: string;
  active?: boolean;
  isBuiltin?: boolean;
  compatibility?: readonly CompatibilityEntry[];
}

export function assertKind(value: string, message: string): void {
  if (!KIND_PATTERN.test(value.trim())) {
    throw new HttpError(400, message);
  }
}

export function parseKind(
  kind: string | undefined,
): DefinitionKind | undefined {
  if (kind === undefined) return undefined;
  assertKind(
    kind,
    "Definition kind must match <identifier>@<version>, e.g. 'openapi@3.0'.",
  );
  const [identifier, version] = kind.trim().split("@") as [string, string];
  return { identifier, version };
}

function normalizeKindVersion(version: string): string {
  const parts = version.split(".");
  while (parts.length < 3) parts.push("0");
  return parts.join(".");
}

export function isKindCompatible(
  kind: DefinitionKind | undefined,
  compatibility: readonly CompatibilityEntry[] | undefined,
): boolean {
  if (kind === undefined || !compatibility || compatibility.length === 0) {
    return false;
  }
  const version = normalizeKindVersion(kind.version);
  return compatibility.some(
    (entry) =>
      entry.identifier === kind.identifier && satisfies(version, entry.version),
  );
}

export function rankAdapters(
  kind: DefinitionKind | undefined,
  adapters: readonly RankableAdapter[],
): RankableAdapter[] {
  const rank = (adapter: RankableAdapter): number => {
    const compatible = isKindCompatible(kind, adapter.compatibility);
    const active = adapter.active ?? false;
    const builtin = adapter.isBuiltin ?? false;
    const group = compatible ? 0 : 4;
    if (active) return group + (builtin ? 0 : 1);
    return group + (builtin ? 2 : 3);
  };
  return [...adapters].sort(
    (a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name),
  );
}

export function resolveDefaultAdapterId(
  kind: DefinitionKind | undefined,
  adapters: readonly RankableAdapter[],
): string | undefined {
  const ranked = rankAdapters(kind, adapters);
  return ranked.find(
    (adapter) =>
      isKindCompatible(kind, adapter.compatibility) && adapter.active,
  )?.id;
}
