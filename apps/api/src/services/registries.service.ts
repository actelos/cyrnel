import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray, type SQL } from "drizzle-orm";

import { db } from "@/db/client";
import {
  type RegistryCredentialRecord,
  type RegistryRecord,
  registries,
  registryCredentialAuth,
  registryCredentials,
} from "@/db/schema";
import { logger } from "@/infra/logging";
import { HttpError } from "@/models/error.model";
import {
  CredentialService,
  type CredentialSummary,
} from "@/services/credential.service";
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
  invalidateRegistryIndexCache,
  type RegistryAuthDeclaration,
  type RegistryIndexInfo,
  type RegistryPage,
} from "@/utils/registry.util";
import {
  invalidateRegistryAuthCache,
  isCredentialTransportAllowed,
} from "@/utils/registry-auth.util";
import { encryptSecrets } from "@/utils/secrets.util";

const REGISTRY_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

export interface CreateRegistryInput {
  id: string;
  baseUrl: string;
}

export interface ListRegistriesInput {
  limit?: number;
  cursor?: string;
}

export type RegistryMachineAuthMaterial =
  | { schemeName: string; type: "apiKey"; apiKey: string }
  | {
      schemeName: string;
      type: "basic";
      username: string;
      password: string;
    }
  | { schemeName: string; type: "bearer"; token: string }
  | {
      schemeName: string;
      type: "oauth2";
      grant: "client_credentials";
      clientId: string;
      clientSecret: string;
      scopes?: string[];
    };

export interface RegistryAuthSetupResult {
  credential: CredentialSummary;
  status: "configured" | "error";
  message?: string;
  tokenExpiresAt?: number | null;
}

export type RegistryListRecord = RegistryRecord & {
  configuredSchemes: string[];
};

export interface RegistryAuthState {
  schemes: RegistryAuthDeclaration["schemes"];
  security: RegistryAuthDeclaration["security"];
  credentials: CredentialSummary[];
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

function schemeTypeLabel(scheme: { type?: string; scheme?: string }): string {
  if (scheme.type === "http" && typeof scheme.scheme === "string") {
    return `http/${scheme.scheme}`;
  }
  return (scheme.type ?? "unknown") as string;
}

export class RegistriesService {
  private readonly credentials = new CredentialService();

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
      .select()
      .from(registries)
      .where(and(...conditions))
      .orderBy(desc(registries.createdAt), desc(registries.id))
      .limit(limit + 1)
      .catch(() => {
        throw new HttpError(500, "Failed to list registries.");
      });

    const page = paginatePage(rows, limit, (item) => [item.createdAt, item.id]);
    const configured = await this.configuredSchemesFor(
      page.items.map((item) => item.id),
    );
    return {
      ...page,
      items: page.items.map((item) => ({
        ...item,
        configuredSchemes: configured.get(item.id) ?? [],
      })),
    };
  }

  private async configuredSchemesFor(
    ids: string[],
  ): Promise<Map<string, string[]>> {
    const map = new Map<string, string[]>();
    if (ids.length === 0) return map;
    const rows = await db
      .select({
        registryId: registryCredentials.registryId,
        schemeName: registryCredentials.schemeName,
      })
      .from(registryCredentials)
      .where(inArray(registryCredentials.registryId, ids))
      .catch(() => [] as Array<{ registryId: string; schemeName: string }>);
    for (const row of rows) {
      const list = map.get(row.registryId) ?? [];
      list.push(row.schemeName);
      map.set(row.registryId, list);
    }
    return map;
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

  async getRegistryAuthState(id: string): Promise<RegistryAuthState> {
    const registry = await this.getRegistry(id);
    let index: RegistryIndexInfo;
    try {
      index = await fetchRegistryIndex(registry.baseUrl);
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw new HttpError(
        502,
        `Failed to fetch registry '${id}' well-known document.`,
      );
    }
    const credentials = await this.credentials
      .forRegistry(id)
      .listCredentials();
    return {
      schemes: index.auth?.schemes ?? {},
      security: index.auth?.security ?? [],
      credentials,
    };
  }

  async deleteRegistry(id: string): Promise<void> {
    const deleted = await db
      .delete(registries)
      .where(eq(registries.id, id))
      .returning({ id: registries.id })
      .catch(() => {
        throw new HttpError(500, `Failed to delete registry '${id}'.`);
      });

    if (deleted.length === 0) {
      throw new HttpError(404, `Registry '${id}' not found.`);
    }
    invalidateRegistryAuthCache();
    invalidateRegistryIndexCache();
  }

  async addRegistry(
    baseUrl: string,
    id?: string,
  ): Promise<
    RegistryRecord & {
      auth: {
        schemes: RegistryAuthDeclaration["schemes"];
        security: RegistryAuthDeclaration["security"];
      };
      resolvedClients: Record<
        string,
        Awaited<ReturnType<CredentialService["resolveOAuthClients"]>>
      >;
    }
  > {
    const index = await fetchRegistryIndex(baseUrl);

    if (!index.definitions && !index.modules) {
      throw new HttpError(
        400,
        `Registry at '${baseUrl}' does not advertise a supported 'definitions' or 'modules' capability.`,
      );
    }

    const resolvedId = id?.trim() || index.id;
    const record = await this.createRegistry({
      id: resolvedId,
      baseUrl,
    });

    const resolvedClients: Record<
      string,
      Awaited<ReturnType<CredentialService["resolveOAuthClients"]>>
    > = {};
    if (index.auth) {
      for (const [schemeName, scheme] of Object.entries(index.auth.schemes)) {
        if (
          scheme.type === "oauth2" &&
          scheme.grantTypes.includes("authorization_code") &&
          scheme.authorizationUrl
        ) {
          resolvedClients[schemeName] =
            await this.credentials.resolveOAuthClients({
              authorizationUrl: scheme.authorizationUrl,
            });
        }
      }
    }

    invalidateRegistryAuthCache();
    return {
      ...record,
      auth: {
        schemes: index.auth?.schemes ?? {},
        security: index.auth?.security ?? [],
      },
      resolvedClients,
    };
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

    await this.warnOnAuthDrift(id, index);

    const now = new Date().toISOString();
    const [row] = await db
      .update(registries)
      .set({ lastSyncedAt: now, updatedAt: now })
      .where(eq(registries.id, id))
      .returning()
      .catch(() => {
        throw new HttpError(500, `Failed to refresh registry '${id}'.`);
      });

    invalidateRegistryIndexCache(existing.baseUrl);
    return row;
  }

  async setRegistryAuth(
    id: string,
    material: RegistryMachineAuthMaterial,
  ): Promise<{ auth: RegistryAuthSetupResult }> {
    const registry = await this.getRegistry(id);
    const index = await fetchRegistryIndex(registry.baseUrl);
    if (!index.auth) {
      throw new HttpError(
        400,
        `Registry '${id}' does not advertise authentication.`,
      );
    }
    const declared = index.auth.schemes[material.schemeName];
    if (!declared) {
      throw new HttpError(
        400,
        `Scheme '${material.schemeName}' is not declared by registry '${id}'.`,
      );
    }

    const store = this.credentials.forRegistry(id);
    const expected = material.type === "oauth2" ? "oauth2" : material.type;
    if (
      (expected === "apiKey" && declared.type !== "apiKey") ||
      (expected === "basic" && declared.type !== "basic") ||
      (expected === "bearer" &&
        !(declared.type === "http" && declared.scheme === "bearer")) ||
      (expected === "oauth2" && declared.type !== "oauth2")
    ) {
      throw new HttpError(
        400,
        `Scheme '${material.schemeName}' requires '${schemeTypeLabel(declared)}' but the material is '${material.type}'.`,
      );
    }

    if (material.type === "apiKey") {
      if (!(await isCredentialTransportAllowed(registry.baseUrl))) {
        throw plaintextRefusal();
      }
      const { credential } = await store.upsertApiKey(
        material.schemeName,
        material.apiKey,
      );
      invalidateRegistryAuthCache();
      return {
        auth: {
          credential: await this.credentials.toSummary(credential),
          status: "configured",
        },
      };
    }
    if (material.type === "basic") {
      if (!(await isCredentialTransportAllowed(registry.baseUrl))) {
        throw plaintextRefusal();
      }
      const { credential } = await store.upsertBasic(
        material.schemeName,
        material.username,
        material.password,
      );
      invalidateRegistryAuthCache();
      return {
        auth: {
          credential: await this.credentials.toSummary(credential),
          status: "configured",
        },
      };
    }
    if (material.type === "bearer") {
      if (!(await isCredentialTransportAllowed(registry.baseUrl))) {
        throw plaintextRefusal();
      }
      const { credential } = await store.upsertBearer(
        material.schemeName,
        material.token,
      );
      invalidateRegistryAuthCache();
      return {
        auth: {
          credential: await this.credentials.toSummary(credential),
          status: "configured",
        },
      };
    }

    if (declared.type !== "oauth2") {
      throw new HttpError(
        500,
        "Unreachable: oauth2 material with non-oauth2 scheme.",
      );
    }
    if (!declared.grantTypes.includes("client_credentials")) {
      throw new HttpError(
        400,
        `Scheme '${material.schemeName}' does not support the 'client_credentials' grant. Use the OAuth authorize flow for 'authorization_code'.`,
      );
    }
    if (!(await isCredentialTransportAllowed(declared.tokenUrl))) {
      throw new HttpError(
        400,
        "Registry oauth2 token endpoint must be https; refusing to store client credentials.",
      );
    }
    const declaredScopeIds = Object.keys(declared.scopes);
    if (material.scopes) {
      const unknown = material.scopes.filter(
        (scope) => !declaredScopeIds.includes(scope),
      );
      if (unknown.length > 0) {
        throw new HttpError(
          400,
          `Requested scope(s) not advertised by the registry: ${unknown.join(", ")}.`,
        );
      }
    }

    const { exchangeClientCredentials } = await import(
      "@/utils/registry-auth.util"
    );
    let token: {
      accessToken: string;
      refreshToken?: string;
      expiresAt: number;
    } | null = null;
    let failure: string | null = null;
    try {
      token = await exchangeClientCredentials({
        tokenEndpoint: declared.tokenUrl,
        clientId: material.clientId,
        clientSecret: material.clientSecret,
        scopes: material.scopes ?? declaredScopeIds,
      });
    } catch (error) {
      if (error instanceof HttpError && error.statusCode === 400) {
        throw error;
      }
      failure = authFailureMessage(error);
    }

    const now = new Date().toISOString();
    const existing = await store.getForScheme(material.schemeName);
    const credentialId = existing?.id ?? randomUUID();
    const payload = encryptSecrets({
      clientId: material.clientId,
      clientSecret: material.clientSecret,
      ...(token
        ? { accessToken: token.accessToken, expiresAt: token.expiresAt }
        : {}),
    });
    if (existing) {
      await db
        .update(registryCredentials)
        .set({
          schemeType: "oauth2",
          status: failure ? "error" : "active",
          requestedScopes: material.scopes ?? declaredScopeIds,
          grantedScopes: token ? (material.scopes ?? declaredScopeIds) : null,
          grantedSource: token ? ("provider" as const) : null,
          updatedAt: now,
        })
        .where(eq(registryCredentials.id, existing.id));
      await db
        .update(registryCredentialAuth)
        .set({ schemeType: "oauth2", payload, updatedAt: Date.now() })
        .where(eq(registryCredentialAuth.credentialId, existing.id));
      await this.credentials.deletePendingsFor(existing.id);
    } else {
      await db.insert(registryCredentials).values({
        id: credentialId,
        registryId: id,
        schemeName: material.schemeName,
        schemeType: "oauth2",
        status: failure ? "error" : "active",
        requestedScopes: material.scopes ?? declaredScopeIds,
        grantedScopes: token ? (material.scopes ?? declaredScopeIds) : null,
        grantedSource: token ? ("provider" as const) : null,
        createdAt: now,
        updatedAt: now,
      });
      await db.insert(registryCredentialAuth).values({
        credentialId,
        schemeType: "oauth2",
        payload,
        updatedAt: Date.now(),
      });
    }
    const created = await store.getCredential(credentialId);
    if (!created) throw new HttpError(500, "Failed to store registry auth.");
    invalidateRegistryAuthCache();
    return {
      auth: {
        credential: await this.credentials.toSummary(created),
        status: failure ? "error" : "configured",
        ...(failure ? { message: failure } : {}),
        ...(token ? { tokenExpiresAt: token.expiresAt } : {}),
      },
    };
  }

  async deleteRegistryAuth(id: string, schemeName?: string): Promise<void> {
    await this.getRegistry(id);
    const store = this.credentials.forRegistry(id);
    if (schemeName !== undefined) {
      const removed = await store.disconnectScheme(schemeName);
      if (!removed) {
        throw new HttpError(
          404,
          `Registry '${id}' has no credential for scheme '${schemeName}'.`,
        );
      }
    } else {
      for (const cred of await store.listCredentials()) {
        await this.credentials.deleteCredential("registry", cred.id);
      }
    }
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

  private async warnOnAuthDrift(
    id: string,
    index: RegistryIndexInfo,
  ): Promise<void> {
    const configured = await this.credentials.forRegistry(id).listCredentials();
    if (!index.auth) {
      if (configured.length > 0) {
        logger.warn(
          { event: "registry-auth-unadvertised", registryId: id },
          "Registry no longer advertises auth but credentials remain configured",
        );
      }
      return;
    }
    for (const cred of configured) {
      if (!index.auth.schemes[cred.schemeName]) {
        logger.warn(
          {
            event: "registry-auth-scheme-removed",
            registryId: id,
            schemeName: cred.schemeName,
          },
          "Configured credential scheme is no longer advertised; retaining configuration",
        );
      }
    }
    if (index.auth.security.length > 0) {
      const satisfiable = await this.satisfiableGroup(index, configured);
      if (!satisfiable) {
        logger.warn(
          { event: "registry-auth-unconfigured", registryId: id },
          "Registry requires auth but no configured credential satisfies its security",
        );
      }
    }
  }

  private async satisfiableGroup(
    index: RegistryIndexInfo,
    configured: Array<
      Pick<
        RegistryCredentialRecord,
        "schemeName" | "schemeType" | "status" | "grantedScopes"
      >
    >,
  ): Promise<boolean> {
    if (!index.auth || index.auth.security.length === 0) return true;
    const byScheme = new Map(configured.map((c) => [c.schemeName, c]));
    for (const group of index.auth.security) {
      let ok = true;
      for (const [schemeName, required] of Object.entries(group)) {
        const cred = byScheme.get(schemeName);
        if (!cred || cred.status === "revoked") {
          ok = false;
          break;
        }
        const granted = new Set(cred.grantedScopes ?? []);
        if ((required as string[]).some((s) => !granted.has(s))) {
          ok = false;
          break;
        }
      }
      if (ok) return true;
    }
    return false;
  }
}

function plaintextRefusal(): HttpError {
  return new HttpError(
    400,
    "Registry authentication requires https; refusing to store credentials for a plaintext http registry.",
  );
}

function authFailureMessage(error: unknown): string {
  if (error instanceof HttpError) return error.message;
  return "Failed to exchange registry oauth2 credentials.";
}
