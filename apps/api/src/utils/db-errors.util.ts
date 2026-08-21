export function isUniqueConstraintError(
  err: unknown,
  seen = new Set<unknown>(),
): boolean {
  if (!err || typeof err !== "object" || seen.has(err)) return false;
  seen.add(err);
  const { code, message } = err as { code?: unknown; message?: unknown };
  const c = typeof code === "string" ? code : "";
  const m = typeof message === "string" ? message : "";
  if (
    c === "23505" ||
    /^SQLITE_CONSTRAINT_(UNIQUE|PRIMARYKEY)$/i.test(c) ||
    /UNIQUE constraint failed:|duplicate key value|\bduplicate key\b|violates unique constraint/i.test(
      m,
    )
  ) {
    return true;
  }
  return isUniqueConstraintError((err as { cause?: unknown }).cause, seen);
}

export function getUniqueConstraintColumn(
  err: unknown,
  seen = new Set<unknown>(),
): string | null {
  if (!err || typeof err !== "object" || seen.has(err)) return null;
  seen.add(err);
  const { message } = err as { message?: unknown };
  if (typeof message === "string") {
    const match = message.match(/UNIQUE constraint failed:\s*([^\s]+)/i);
    if (match) return match[1];
  }
  return getUniqueConstraintColumn((err as { cause?: unknown }).cause, seen);
}
