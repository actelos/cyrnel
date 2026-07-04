import ky, { HTTPError, type KyInstance } from "ky";
import { z } from "zod";

const env = z
  .object({
    CYRNEL_API_URL: z
      .url()
      .default("http://localhost:9371")
      .transform((v) => v.replace(/\/+$/, "")),
    CYRNEL_API_KEY: z.string().optional(),
    CYRNEL_API_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
  })
  .parse(process.env);

export class RateLimitError extends Error {
  constructor(
    message: string,
    public readonly retryAfter: number,
    public readonly limit: number,
    public readonly remaining: number,
    public readonly reset: number,
  ) {
    super(message);
    this.name = "RateLimitError";
  }
}

export const api: KyInstance = ky.create({
  prefix: env.CYRNEL_API_URL,
  timeout: env.CYRNEL_API_TIMEOUT_MS,
  headers: env.CYRNEL_API_KEY
    ? { Authorization: `Bearer ${env.CYRNEL_API_KEY}` }
    : undefined,
  retry: {
    limit: 0,
  },
  hooks: {
    beforeError: [
      async ({ request, error }) => {
        if (!(error instanceof HTTPError)) return error;
        let text = "";
        try {
          text = await error.response.clone().text();
        } catch {
          try {
            text = await error.response.text();
          } catch {}
        }
        let detail = text;
        let retryAfter = 0;
        let limit = 0;
        let remaining = 0;
        let reset = 0;
        try {
          const body = JSON.parse(text) as Record<string, unknown>;
          detail = String(body.error ?? body.message ?? text);
          if (error.response.status === 429) {
            retryAfter =
              typeof body.retryAfter === "number" ? body.retryAfter : 0;
            limit = Number(
              error.response.headers.get("X-RateLimit-Limit") ?? 0,
            );
            remaining = Number(
              error.response.headers.get("X-RateLimit-Remaining") ?? 0,
            );
            reset = Number(
              error.response.headers.get("X-RateLimit-Reset") ?? 0,
            );
          }
        } catch {}
        const url = new URL(request.url);
        if (error.response.status === 429 && retryAfter > 0) {
          return new RateLimitError(
            `API ${request.method} ${url.pathname} -> 429: ${detail}`,
            retryAfter,
            limit,
            remaining,
            reset,
          );
        }
        error.message = `API ${request.method} ${url.pathname} -> ${error.response.status}: ${detail}`;
        return error;
      },
    ],
  },
});

export function searchParams(
  params: Record<string, string | number | boolean | undefined>,
): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined) out[k] = v;
  }
  return out;
}
