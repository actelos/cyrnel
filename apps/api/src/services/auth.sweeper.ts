import { lt } from "drizzle-orm";
import { db } from "@/db/client";
import { oauthPendings } from "@/db/schema";
import { logger } from "@/infra/logging";
import {
  CredentialService,
  TOKEN_EXPIRY_SKEW_MS,
} from "@/services/credential.service";

export const DEFAULT_AUTH_REFRESH_INTERVAL_MS = 300_000;
export const MAX_AUTH_REFRESH_INTERVAL_MS = 2_147_483_647;

export interface AuthSweepStats {
  expiredPending: number;
  tokensChecked: number;
  tokensRefreshed: number;
  tokensFailed: number;
}

export async function sweepExpiredPendingAuthorizations(): Promise<number> {
  const deleted = await db
    .delete(oauthPendings)
    .where(lt(oauthPendings.expiresAt, Date.now()))
    .returning({ state: oauthPendings.state })
    .catch(() => [] as { state: string }[]);
  if (deleted.length > 0) {
    logger.info(
      { event: "auth-pending-sweep", prunedCount: deleted.length },
      "Pruned expired pending OAuth authorizations",
    );
  }
  return deleted.length;
}

export async function sweepExpiringOAuthTokens(
  horizonMs: number = DEFAULT_AUTH_REFRESH_INTERVAL_MS + TOKEN_EXPIRY_SKEW_MS,
  service: CredentialService = new CredentialService(),
): Promise<{ checked: number; refreshed: number; failed: number }> {
  const stats = { checked: 0, refreshed: 0, failed: 0 };
  const ids = await service.listActiveOAuthCredentials().catch(
    () =>
      [] as Array<{
        kind: "service" | "module" | "registry";
        ownerId: string;
        id: string;
      }>,
  );
  const horizon = Date.now() + horizonMs;

  for (const { kind, ownerId, id } of ids) {
    const store = service.storeFor(kind, ownerId);
    let auth: Record<string, unknown> | null = null;
    try {
      auth = await store.getDecryptedAuth(id);
    } catch {
      continue;
    }
    if (!auth) continue;
    const expiresAt = auth.expiresAt;
    const refreshToken = auth.refreshToken;
    if (typeof expiresAt !== "number" || typeof refreshToken !== "string") {
      continue;
    }
    stats.checked++;
    if (expiresAt - TOKEN_EXPIRY_SKEW_MS > horizon) continue;
    try {
      await store.refreshOAuthToken(id, "background");
      stats.refreshed++;
    } catch {
      stats.failed++;
    }
  }

  if (stats.refreshed > 0 || stats.failed > 0) {
    logger.info(
      { event: "auth-refresh-sweep", ...stats },
      "Background OAuth token refresh sweep finished",
    );
  }
  return stats;
}

export async function sweepAuth(
  horizonMs: number = DEFAULT_AUTH_REFRESH_INTERVAL_MS + TOKEN_EXPIRY_SKEW_MS,
): Promise<AuthSweepStats> {
  const [expiredPending, tokens] = await Promise.all([
    sweepExpiredPendingAuthorizations(),
    sweepExpiringOAuthTokens(horizonMs),
  ]);
  return {
    expiredPending,
    tokensChecked: tokens.checked,
    tokensRefreshed: tokens.refreshed,
    tokensFailed: tokens.failed,
  };
}

export function parseAuthRefreshInterval(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_AUTH_REFRESH_INTERVAL_MS;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) {
    logger.warn(
      { event: "invalid-auth-refresh-interval", raw },
      "Invalid CYRNEL_AUTH_REFRESH_INTERVAL_MS; using default",
    );
    return DEFAULT_AUTH_REFRESH_INTERVAL_MS;
  }
  if (parsed === 0) {
    logger.info(
      { event: "auth-refresh-disabled" },
      "CYRNEL_AUTH_REFRESH_INTERVAL_MS is 0; background auth refresh disabled",
    );
    return 0;
  }
  if (parsed > MAX_AUTH_REFRESH_INTERVAL_MS) {
    logger.warn(
      {
        event: "invalid-auth-refresh-interval",
        raw,
        max: MAX_AUTH_REFRESH_INTERVAL_MS,
      },
      "Invalid CYRNEL_AUTH_REFRESH_INTERVAL_MS; using default",
    );
    return DEFAULT_AUTH_REFRESH_INTERVAL_MS;
  }
  return parsed;
}
