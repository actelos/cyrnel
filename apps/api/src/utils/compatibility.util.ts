import { satisfies } from "semver";

import { HttpError } from "@/models/error.model";

/**
 * A definition kind is an identifier plus a version, e.g. `openapi@3.0`.
 * The identifier names the definition family and the version names the
 * family's specification version.
 */
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

/**
 * Whether a definition kind is accepted by an adapter's compatibility list.
 * Kind versions like `3.0` are padded to full semver (`3.0.0`) before the
 * range check.
 */
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

/**
 * Ranks adapters for a definition kind: compatible adapters first, then
 * incompatible ones. Within each group, active adapters sort before inactive
 * ones, built-in (canonical) adapters sort before third-party ones, and ties
 * break by name.
 */
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

/**
 * The best adapter to install a definition kind with: the top-ranked
 * compatible adapter that is currently active, if any.
 */
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
