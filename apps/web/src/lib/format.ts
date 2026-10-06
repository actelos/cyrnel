export function formatDateTime(value: string | number | Date): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function formatRelativeTime(value: string | number | Date): string {
  const date = value instanceof Date ? value : new Date(value);
  const time = date.getTime();
  if (Number.isNaN(time)) return String(value);
  const diffMs = Date.now() - time;
  const absMs = Math.abs(diffMs);
  const suffix = diffMs >= 0 ? "ago" : "from now";
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (absMs < minute) return "just now";
  if (absMs < hour) {
    const n = Math.floor(absMs / minute);
    return `${n}m ${suffix}`;
  }
  if (absMs < day) {
    const n = Math.floor(absMs / hour);
    return `${n}h ${suffix}`;
  }
  const n = Math.floor(absMs / day);
  if (n < 30) return `${n}d ${suffix}`;
  return formatDateTime(date);
}

export function formatVersion(version: string | null | undefined): string {
  if (!version || version.trim().length === 0) return "unknown";
  const trimmed = version.trim();
  return trimmed.startsWith("v") ? trimmed : `v${trimmed}`;
}
