declare global {
  interface Window {
    __CYRNEL_CONFIG__?: {
      CYRNEL_API_URL: string;
      CYRNEL_API_KEY: string;
    };
  }
}

function runtimeConfig(): Window["__CYRNEL_CONFIG__"] | undefined {
  if (typeof window === "undefined") return undefined;
  return window.__CYRNEL_CONFIG__;
}

export function apiUrl(): string {
  return (
    runtimeConfig()?.CYRNEL_API_URL ??
    import.meta.env.VITE_CYRNEL_API_URL ??
    "http://127.0.0.1:7687"
  );
}

export function apiKey(): string {
  return (
    runtimeConfig()?.CYRNEL_API_KEY ?? import.meta.env.VITE_CYRNEL_API_KEY ?? ""
  );
}
