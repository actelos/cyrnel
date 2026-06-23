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

export const api: KyInstance = ky.create({
  prefix: env.CYRNEL_API_URL,
  timeout: env.CYRNEL_API_TIMEOUT_MS,
  headers: env.CYRNEL_API_KEY
    ? { Authorization: `Bearer ${env.CYRNEL_API_KEY}` }
    : undefined,
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
        try {
          const body = JSON.parse(text) as Record<string, unknown>;
          detail = String(body.error ?? body.message ?? text);
        } catch {}
        const url = new URL(request.url);
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
