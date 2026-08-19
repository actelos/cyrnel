import { and, desc, eq, type SQL } from "drizzle-orm";

import { db } from "@/db/client";
import { type RegistryRecord, registries, registryAuth } from "@/db/schema";
import { logger } from "@/infra/logging";
import { HttpError } from "@/models/error.model";
import {
  getUniqueConstraintColumn,
  isUniqueConstraintError,
} from "@/utils/db-errors.util";
import {
  decodeCursor,
  invalidCursorError,
  keysetConditions,
  PAGINATION_DEFAULT_LIMIT,
  type PaginatedResult,
  paginatePage,
} from "@/utils/pagination.util";
import {
  fetchRegistryCapabilityPage,
  fetchRegistryIndex,
  type RegistryAuthDeclaration,
  type RegistryPage,
} from "@/utils/registry.util";
import {
  exchangeClientCredentials,
  invalidateRegistryAuthCache,
  isCredentialTransportAllowed,
} from "@/utils/registry-auth.util";
import {
  type EncryptedSecretsPayload,
  encryptSecrets,
} from "@/utils/secrets.util";

const REGISTRY_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

export interface CreateRegistryInput {
  id: string;
  baseUrl: string;
}

export interface ListRegistriesInput {
  limit?: number;
  cursor?: string;
}

export interface RegistryAuthSetupInput {
  type: "apiKey";
  apiKey: string;
}

export interface RegistryOAuthSetupInput {
  type: "oauth2";
  clientId: string;
  clientSecret: string;
  scopes?: string[];
}

export type RegistryAuthSetupInputUnion =
  | RegistryAuthSetupInput
  | RegistryOAuthSetupInput;

export interface RegistryAuthSetupResult {
  type: "apiKey" | "oauth2";
  status: "configured" | "error";
  message?: string;
  tokenExpiresAt?: number | null;
}

export type RegistryListRecord = RegistryRecord & {
  authType: "apiKey" | "oauth2" | null;
  tokenExpiresAt: number | null;
};

type ResolvedAuthDeclaration =
  | {
      ok: true;
      type: "apiKey";
      declaration: { type: "apiKey"; name: string };
      material: RegistryAuthSetupInput;
    }
  | {
      ok: true;
      type: "oauth2";
      declaration: {
        type: "oauth2";
        grantType: "client_credentials";
        tokenEndpoint: string;
        scopes?: string[];
      };
      material: RegistryOAuthSetupInput;
    }
  | { ok: false; message: string };

interface AuthStateRecord {
  authType: "apiKey" | "oauth2" | null;
  tokenEndpoint: string | null;
  headerName: string | null;
  tokenExpiresAt: number | null;
}

export class RegistriesService {
  async createRegistry(input: CreateRegistryInput): Promise<RegistryRecord> {
    const id = input.id.trim();
    if (!REGISTRY_ID_PATTERN.test(id)) {
      throw new HttpError(
        400,
        `Registry id '${id}' must be a slug matching /^[A-Za-z0-9_-]+$/.`,
      );
    }

    const baseUrl = input.baseUrl.trim();
    const normalizedBaseUrl = parseNormalizedHttpUrl(baseUrl);
    if (!normalizedBaseUrl) {
      throw new HttpError(
        400,
        `Registry base URL '${baseUrl}' must be a valid absolute http(s) URL.`,
      );
    }

    const now = new Date().toISOString();
    try {
      const [row] = await db
        .insert(registries)
        .values({
          id,
          baseUrl: normalizedBaseUrl,
          lastSyncedAt: null,
          createdAt: now,
          updatedAt: now,
        })
        .returning();
      return row;
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        if (getUniqueConstraintColumn(error)?.endsWith(".base_url")) {
          throw new HttpError(
            409,
            `A registry with base URL '${normalizedBaseUrl}' is already registered.`,
          );
        }
        throw new HttpError(409, `Registry '${id}' already exists.`);
      }
      throw new HttpError(500, `Failed to create registry '${id}'.`);
    }
  }

  async listRegistries(
    input?: ListRegistriesInput,
  ): Promise<PaginatedResult<RegistryListRecord>> {
    const limit = input?.limit ?? PAGINATION_DEFAULT_LIMIT;

    const conditions: Array<SQL | undefined> = [];
    if (input?.cursor !== undefined) {
      const cursor = decodeCursor(input.cursor, 2);
      const [createdAt, id] = cursor.sortKey;
      if (typeof createdAt !== "string" || typeof id !== "string") {
        throw invalidCursorError();
      }
      conditions.push(
        keysetConditions(
          [
            [registries.createdAt, createdAt],
            [registries.id, id],
          ],
          "before",
        ),
      );
    }

    const rows = await db
      .select({
        id: registries.id,
        baseUrl: registries.baseUrl,
        lastSyncedAt: registries.lastSyncedAt,
        createdAt: registries.createdAt,
        updatedAt: registries.updatedAt,
        authType: registryAuth.authType,
        tokenExpiresAt: registryAuth.tokenExpiresAt,
      })
      .from(registries)
      .leftJoin(registryAuth, eq(registryAuth.registryId, registries.id))
      .where(and(...conditions))
      .orderBy(desc(registries.createdAt), desc(registries.id))
      .limit(limit + 1)
      .catch(() => {
        throw new HttpError(500, "Failed to list registries.");
      });

    return paginatePage(rows, limit, (item) => [item.createdAt, item.id]);
  }

  async getRegistry(id: string): Promise<RegistryRecord> {
    const [row] = await db
      .select()
      .from(registries)
      .where(eq(registries.id, id))
      .limit(1)
      .catch(() => {
        throw new HttpError(500, `Failed to load registry '${id}'.`);
      });

    if (!row) throw new HttpError(404, `Registry '${id}' not found.`);
    return row;
  }

  async getAuthState(id: string): Promise<AuthStateRecord> {
    const [row] = await db
      .select({
        authType: registryAuth.authType,
        tokenEndpoint: registryAuth.tokenEndpoint,
        headerName: registryAuth.headerName,
        tokenExpiresAt: registryAuth.tokenExpiresAt,
      })
      .from(registryAuth)
      .where(eq(registryAuth.registryId, id))
      .limit(1)
      .catch(() => {
        throw new HttpError(500, `Failed to load registry '${id}' auth.`);
      });

    if (!row) {
      return {
        authType: null,
        tokenEndpoint: null,
        headerName: null,
        tokenExpiresAt: null,
      };
    }
    return row;
  }

  async deleteRegistry(id: string): Promise<void> {
    const [deleted] = await db
      .delete(registries)
      .where(eq(registries.id, id))
      .returning({ id: registries.id })
      .catch(() => {
        throw new HttpError(500, `Failed to delete registry '${id}'.`);
      });

    if (!deleted) throw new HttpError(404, `Registry '${id}' not found.`);
    invalidateRegistryAuthCache();
  }

  async addRegistry(
    baseUrl: string,
    id?: string,
    auth?: RegistryAuthSetupInputUnion,
  ): Promise<RegistryRecord & { auth: RegistryAuthSetupResult | null }> {
    const index = await fetchRegistryIndex(baseUrl);

    if (!index.definitions && !index.modules) {
      throw new HttpError(
        400,
        `Registry at '${baseUrl}' does not advertise a supported 'definitions' or 'modules' capability.`,
      );
    }

    const resolvedId = id?.trim() || index.id;

    let authResult: RegistryAuthSetupResult | null = null;
    let tokenState: Awaited<
      ReturnType<typeof exchangeClientCredentials>
    > | null = null;

    if (auth) {
      const resolved = await this.resolveAuthDeclaration(
        index.auth,
        auth,
        baseUrl,
      );
      if (!resolved.ok) {
        authResult = {
          type: auth.type,
          status: "error",
          message: resolved.message,
        };
      } else {
        if (resolved.type === "oauth2") {
          try {
            tokenState = await exchangeClientCredentials({
              type: "oauth2",
              clientId: resolved.material.clientId,
              clientSecret: resolved.material.clientSecret,
              tokenEndpoint: resolved.declaration.tokenEndpoint,
              scopes: resolved.material.scopes ?? resolved.declaration.scopes,
            });
          } catch (error) {
            if (error instanceof HttpError && error.statusCode === 400) {
              throw error;
            }
            authResult = {
              type: auth.type,
              status: "error",
              message: authFailureMessage(error),
            };
            tokenState = null;
          }
        }
      }
    }

    const record = await this.createRegistry({ id: resolvedId, baseUrl });

    if (auth && authResult === null) {
      authResult = await this.persistAuth(
        record.id,
        auth,
        index.auth,
        tokenState,
      );
    }

    invalidateRegistryAuthCache();
    return { ...record, auth: authResult };
  }

  async refreshRegistry(id: string): Promise<RegistryRecord> {
    const existing = await this.getRegistry(id);

    const index = await fetchRegistryIndex(existing.baseUrl);

    if (!index.definitions && !index.modules) {
      throw new HttpError(
        502,
        `Registry '${id}' no longer advertises a supported capability.`,
      );
    }

    await this.warnOnAuthDrift(id, index.auth);

    const now = new Date().toISOString();
    const [row] = await db
      .update(registries)
      .set({ lastSyncedAt: now, updatedAt: now })
      .where(eq(registries.id, id))
      .returning()
      .catch(() => {
        throw new HttpError(500, `Failed to refresh registry '${id}'.`);
      });

    return row;
  }

  async setRegistryAuth(
    id: string,
    auth: RegistryAuthSetupInputUnion,
  ): Promise<{ auth: RegistryAuthSetupResult }> {
    const registry = await this.getRegistry(id);

    const index = await fetchRegistryIndex(registry.baseUrl);

    const resolved = await this.resolveAuthDeclaration(
      index.auth,
      auth,
      registry.baseUrl,
    );
    if (!resolved.ok) {
      throw new HttpError(400, resolved.message);
    }

    let tokenState: Awaited<
      ReturnType<typeof exchangeClientCredentials>
    > | null = null;
    if (resolved.type === "oauth2") {
      try {
        tokenState = await exchangeClientCredentials({
          type: "oauth2",
          clientId: resolved.material.clientId,
          clientSecret: resolved.material.clientSecret,
          tokenEndpoint: resolved.declaration.tokenEndpoint,
          scopes: resolved.material.scopes ?? resolved.declaration.scopes,
        });
      } catch (error) {
        if (error instanceof HttpError && error.statusCode === 400) {
          throw error;
        }
        await this.persistAuth(id, auth, index.auth, null);
        invalidateRegistryAuthCache();
        return {
          auth: {
            type: auth.type,
            status: "error",
            message: authFailureMessage(error),
          },
        };
      }
    }

    const result = await this.persistAuth(id, auth, index.auth, tokenState);
    invalidateRegistryAuthCache();
    return { auth: result };
  }

  async deleteRegistryAuth(id: string): Promise<void> {
    await this.getRegistry(id);

    const [deleted] = await db
      .delete(registryAuth)
      .where(eq(registryAuth.registryId, id))
      .returning({ registryId: registryAuth.registryId })
      .catch(() => {
        throw new HttpError(500, `Failed to remove registry '${id}' auth.`);
      });

    if (!deleted)
      throw new HttpError(404, `Registry '${id}' has no auth configured.`);
    invalidateRegistryAuthCache();
  }

  async browseDefinitions(
    id: string,
    params: {
      query?: string;
      kind?: string;
      cursor?: string;
      limit?: number;
    },
  ): Promise<RegistryPage> {
    const registry = await this.getRegistry(id);
    const index = await fetchRegistryIndex(registry.baseUrl);

    if (!index.definitions) {
      throw new HttpError(
        404,
        `Registry '${id}' does not support definitions.`,
      );
    }

    return fetchRegistryCapabilityPage(
      index.definitions.url,
      "definitions",
      params,
    );
  }

  async browseModules(
    id: string,
    params: {
      query?: string;
      type?: "adapter" | "environment";
      cursor?: string;
      limit?: number;
    },
  ): Promise<RegistryPage> {
    const registry = await this.getRegistry(id);
    const index = await fetchRegistryIndex(registry.baseUrl);

    if (!index.modules) {
      throw new HttpError(404, `Registry '${id}' does not support modules.`);
    }

    return fetchRegistryCapabilityPage(index.modules.url, "modules", params);
  }

  async seedDefault(): Promise<void> {
    const seedUrl = process.env.CYRNEL_DEFAULT_REGISTRY_URL?.trim();
    if (!seedUrl) return;

    try {
      const existing = await this.listRegistries();
      if (existing.items.length > 0) return;

      await this.addRegistry(seedUrl);
    } catch (err) {
      logger.warn({ err, seedUrl }, "Failed to seed default registry");
    }
  }

  private async resolveAuthDeclaration(
    declaration: RegistryAuthDeclaration | null,
    material: RegistryAuthSetupInputUnion,
    baseUrl: string,
  ): Promise<ResolvedAuthDeclaration> {
    if (material.type === "apiKey") {
      if (declaration === null) {
        return {
          ok: false,
          message: "The registry does not advertise an 'auth' method.",
        };
      }
      if (declaration.type === "unsupported") {
        return {
          ok: false,
          message: `The registry advertises unsupported auth '${declaration.declaredType}'${declaration.reason ? ` (${declaration.reason})` : ""}.`,
        };
      }
      if (declaration.type === "oauth2") {
        return {
          ok: false,
          message: "The registry advertises oauth2; an api key cannot be used.",
        };
      }
      if (!(await isCredentialTransportAllowed(baseUrl))) {
        throw new HttpError(
          400,
          "Registry authentication requires https; refusing to store credentials for a plaintext http registry.",
        );
      }
      return { ok: true, type: "apiKey" as const, declaration, material };
    }

    if (declaration === null) {
      return {
        ok: false,
        message: "The registry does not advertise an 'auth' method.",
      };
    }
    if (declaration.type === "unsupported") {
      return {
        ok: false,
        message: `The registry advertises unsupported auth '${declaration.declaredType}'${declaration.reason ? ` (${declaration.reason})` : ""}.`,
      };
    }
    if (declaration.type === "apiKey") {
      return {
        ok: false,
        message: "The registry advertises an api key; oauth2 cannot be used.",
      };
    }
    if (!(await isCredentialTransportAllowed(declaration.tokenEndpoint))) {
      throw new HttpError(
        400,
        "Registry oauth2 token endpoint must be https; refusing to store client credentials.",
      );
    }
    return { ok: true, type: "oauth2" as const, declaration, material };
  }

  private async persistAuth(
    registryId: string,
    material: RegistryAuthSetupInputUnion,
    declaration: RegistryAuthDeclaration | null,
    tokenState: Awaited<ReturnType<typeof exchangeClientCredentials>> | null,
  ): Promise<RegistryAuthSetupResult> {
    const now = Date.now();

    let config: EncryptedSecretsPayload;
    let token: EncryptedSecretsPayload | null = null;
    let tokenExpiresAt: number | null = null;
    let headerName: string | null = null;
    let tokenEndpoint: string | null = null;
    let authType: "apiKey" | "oauth2";

    if (material.type === "apiKey") {
      authType = "apiKey";
      config = encryptSecrets({ apiKey: material.apiKey });
      headerName = declaration?.type === "apiKey" ? declaration.name : null;
    } else {
      authType = "oauth2";
      config = encryptSecrets({
        clientId: material.clientId,
        clientSecret: material.clientSecret,
        ...(material.scopes ? { scopes: material.scopes } : {}),
      });
      tokenEndpoint =
        declaration?.type === "oauth2" ? declaration.tokenEndpoint : null;
      if (tokenState) {
        token = encryptSecrets({
          accessToken: tokenState.accessToken,
          ...(tokenState.refreshToken
            ? { refreshToken: tokenState.refreshToken }
            : {}),
          expiresAt: tokenState.expiresAt,
        });
        tokenExpiresAt = tokenState.expiresAt;
      }
    }

    await db
      .insert(registryAuth)
      .values({
        registryId,
        authType,
        config,
        token,
        tokenEndpoint,
        headerName,
        tokenExpiresAt,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: registryAuth.registryId,
        set: {
          authType,
          config,
          token,
          tokenEndpoint,
          headerName,
          tokenExpiresAt,
          updatedAt: now,
        },
      })
      .catch(() => {
        throw new HttpError(
          500,
          `Failed to store registry '${registryId}' auth.`,
        );
      });

    logger.debug(
      { event: "registry-auth-configured", registryId, authType },
      "Stored registry auth configuration",
    );

    return { type: authType, status: "configured", tokenExpiresAt };
  }

  private async warnOnAuthDrift(
    id: string,
    declaration: RegistryAuthDeclaration | null,
  ): Promise<void> {
    if (!declaration) return;

    if (declaration.type === "unsupported") {
      logger.warn(
        {
          event: "registry-auth-unsupported",
          registryId: id,
          declaredType: declaration.declaredType,
        },
        "Registry advertises an unsupported auth method",
      );
      return;
    }

    const stored = await this.getAuthState(id);

    if (!stored.authType) {
      logger.warn(
        { event: "registry-auth-unconfigured", registryId: id },
        "Registry advertises auth but none is configured",
      );
      return;
    }

    if (stored.authType !== declaration.type) {
      logger.warn(
        {
          event: "registry-auth-type-drift",
          registryId: id,
          configuredType: stored.authType,
          declaredType: declaration.type,
        },
        "Registry auth type differs from the configured type; retaining configuration",
      );
      return;
    }

    if (declaration.type === "oauth2") {
      if (
        stored.tokenEndpoint &&
        declaration.tokenEndpoint !== stored.tokenEndpoint
      ) {
        logger.warn(
          {
            event: "registry-auth-token-endpoint-drift",
            registryId: id,
            pinned: stored.tokenEndpoint,
            declared: declaration.tokenEndpoint,
          },
          "Registry oauth2 token endpoint changed; pinned endpoint retained (reconfigure to adopt)",
        );
      }
      return;
    }

    if (declaration.type === "apiKey") {
      if (stored.headerName && declaration.name !== stored.headerName) {
        logger.warn(
          {
            event: "registry-auth-header-drift",
            registryId: id,
            pinned: stored.headerName,
            declared: declaration.name,
          },
          "Registry api key header changed; pinned header retained (reconfigure to adopt)",
        );
      }
    }
  }
}

function parseNormalizedHttpUrl(raw: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  return parsed.toString();
}

function authFailureMessage(error: unknown): string {
  if (error instanceof HttpError) return error.message;
  return "Failed to exchange registry oauth2 credentials.";
}
