function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isSchemaObject(value: unknown): value is Record<string, unknown> {
  return isPlainObject(value);
}

export function isNullOnlySchema(schema: Record<string, unknown>): boolean {
  const type = schema.type;
  return (
    type === "null" ||
    (Array.isArray(type) && type.length === 1 && type[0] === "null")
  );
}

interface WalkResult {
  value: unknown;
  outdated: string[];
}

function isPermissiveLevel(additionalProperties: unknown): boolean {
  return (
    additionalProperties === true ||
    additionalProperties === undefined ||
    isSchemaObject(additionalProperties)
  );
}

function escapePointerSegment(segment: string): string {
  return segment.replace(/~/g, "~0").replace(/\//g, "~1");
}

function childPath(base: string, key: string): string {
  const escaped = escapePointerSegment(key);
  return base ? `${base}/${escaped}` : `/${escaped}`;
}

function walk(
  schema: unknown,
  value: unknown,
  keepPermitted: boolean,
  path: string,
): WalkResult {
  if (Array.isArray(value)) {
    const items = isSchemaObject(schema) ? schema.items : undefined;
    if (isSchemaObject(items) || Array.isArray(items)) {
      const projected: unknown[] = [];
      const outdated: string[] = [];
      for (let i = 0; i < value.length; i++) {
        const itemSchema = Array.isArray(items)
          ? items[Math.min(i, items.length - 1)]
          : items;
        const item = walk(
          itemSchema,
          value[i],
          keepPermitted,
          `${path}/items/${i}`,
        );
        projected.push(item.value);
        outdated.push(...item.outdated);
      }
      return { value: projected, outdated };
    }
    return { value, outdated: [] };
  }

  if (!isPlainObject(value)) return { value, outdated: [] };

  const properties =
    isSchemaObject(schema) && isSchemaObject(schema.properties)
      ? schema.properties
      : undefined;
  const additionalProperties = isSchemaObject(schema)
    ? schema.additionalProperties
    : undefined;

  if (!isPermissiveLevel(additionalProperties)) {
    const out: Record<string, unknown> = {};
    const outdated: string[] = [];
    for (const [key, child] of Object.entries(value)) {
      const sub = properties?.[key];
      if (sub !== undefined) {
        const result = walk(sub, child, keepPermitted, childPath(path, key));
        out[key] = result.value;
        outdated.push(...result.outdated);
      } else {
        outdated.push(childPath(path, key));
      }
    }
    return { value: out, outdated };
  }

  if (keepPermitted) {
    const out: Record<string, unknown> = {};
    const outdated: string[] = [];
    const additionalSchema = isSchemaObject(additionalProperties)
      ? additionalProperties
      : undefined;
    for (const [key, child] of Object.entries(value)) {
      const sub = properties?.[key] ?? additionalSchema;
      const result = walk(sub, child, keepPermitted, childPath(path, key));
      out[key] = result.value;
      outdated.push(...result.outdated);
    }
    return { value: out, outdated };
  }

  const out: Record<string, unknown> = {};
  const outdated: string[] = [];
  for (const [key, child] of Object.entries(value)) {
    const sub = properties?.[key];
    if (sub !== undefined) {
      const result = walk(sub, child, keepPermitted, childPath(path, key));
      out[key] = result.value;
      outdated.push(...result.outdated);
    }
  }
  return { value: out, outdated };
}

export interface FilterPayloadOptions {
  keepPermitted?: boolean;
}

/**
 * Projects a stored payload onto the schema surface.
 *
 * Default (declared-only) keeps keys declared in `properties`; keys at
 * permissive levels (`additionalProperties` absent, `true`, or a schema) are
 * dropped unless `keepPermitted` is set. Undeclared keys at strict levels
 * (`additionalProperties: false`) are always dropped.
 */
export function filterPayloadToSchema(
  schema: Record<string, unknown>,
  payload: Record<string, unknown>,
  options?: FilterPayloadOptions,
): Record<string, unknown> {
  const result = walk(schema, payload, options?.keepPermitted ?? false, "");
  return isPlainObject(result.value) ? result.value : {};
}

export function collectOutdatedPaths(
  schema: Record<string, unknown>,
  payload: Record<string, unknown>,
): string[] {
  const result = walk(schema, payload, true, "");
  return [...new Set(result.outdated)];
}

export function newOutdatedPaths(before: string[], after: string[]): string[] {
  const known = new Set(before);
  return after.filter((path) => !known.has(path));
}

export function mergeStaleKeys<T>(view: T, raw: unknown): T {
  return mergeValues(view, raw) as T;
}

function mergeValues(view: unknown, raw: unknown): unknown {
  if (Array.isArray(view) && Array.isArray(raw)) {
    const length = Math.max(view.length, raw.length);
    const merged: unknown[] = [];
    for (let i = 0; i < length; i++) {
      const viewItem = view[i];
      const rawItem = raw[i];
      if (viewItem === undefined) {
        merged.push(rawItem);
      } else if (rawItem === undefined) {
        merged.push(viewItem);
      } else if (isPlainObject(viewItem) && isPlainObject(rawItem)) {
        merged.push(mergeValues(viewItem, rawItem));
      } else {
        merged.push(viewItem);
      }
    }
    return merged;
  }
  if (isPlainObject(view) && isPlainObject(raw)) {
    const merged: Record<string, unknown> = {};
    for (const [key, viewValue] of Object.entries(view)) {
      const rawValue = raw[key];
      if (Array.isArray(viewValue) && Array.isArray(rawValue)) {
        merged[key] = mergeValues(viewValue, rawValue);
      } else if (isPlainObject(viewValue) && isPlainObject(rawValue)) {
        merged[key] = mergeValues(viewValue, rawValue);
      } else {
        merged[key] = viewValue;
      }
    }
    for (const [key, rawValue] of Object.entries(raw)) {
      if (!Object.hasOwn(view, key)) merged[key] = rawValue;
    }
    return merged;
  }
  return view;
}

export function pathExists(doc: unknown, path: string): boolean {
  if (path === "") return true;
  if (!path.startsWith("/")) return false;
  let current = doc;
  for (const rawSegment of path.slice(1).split("/")) {
    const segment = rawSegment.replace(/~1/g, "/").replace(/~0/g, "~");
    if (Array.isArray(current)) {
      if (!/^\d+$/.test(segment)) return false;
      const index = Number(segment);
      if (index >= current.length) return false;
      current = current[index];
    } else if (isPlainObject(current)) {
      if (!Object.hasOwn(current, segment)) return false;
      current = current[segment];
    } else {
      return false;
    }
  }
  return true;
}
