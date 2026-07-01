export function apiUrl(): string {
  return import.meta.env.VITE_CYRNEL_API_URL ?? "";
}
