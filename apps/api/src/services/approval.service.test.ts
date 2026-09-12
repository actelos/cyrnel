import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { sql } from "drizzle-orm";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

vi.mock("@/services/process.holder", () => ({
  getProcessService: vi.fn(),
}));

import { db } from "@/db/client";
import { approvalRequests, modules, processes, services } from "@/db/schema";
import {
  getApproval,
  listApprovals,
  resolveApproval,
  sweepExpiredApprovals,
  sweepRetention,
} from "@/services/approval.service";
import { encryptSecrets } from "@/utils/secrets.util";

const MIGRATIONS_DIR = path.resolve(import.meta.dirname, "../../drizzle");

const SECRETS_KEY = crypto.randomBytes(32).toString("base64");
const originalSecretsKey = process.env.CYRNEL_SECRETS_KEY;
const originalPreviousKeys = process.env.CYRNEL_SECRETS_PREVIOUS_KEYS;

async function applyMigrations(only?: {
  upto?: string;
  only?: string;
  dropFirst?: boolean;
}): Promise<void> {
  if (only?.dropFirst !== false) {
    await db.run(sql.raw("PRAGMA foreign_keys = OFF"));
    try {
      for (const name of [
        "approval_requests",
        "tool_policies",
        "tools",
        "service_secrets",
        "service_configurations",
        "service_credential_auth",
        "service_credentials",
        "module_credential_auth",
        "module_credentials",
        "registry_credential_auth",
        "registry_credentials",
        "oauth_pendings",
        "pending_authorizations",
        "module_connection_schemes",
        "connection_schemes",
        "oauth_clients",
        "connection_auth",
        "connections",
        "services",
        "module_secrets",
        "module_configurations",
        "modules",
        "registry_auth",
        "registries",
        "process_data",
        "process_logs",
        "processes",
        "sqlite_vec_chunks",
        "tool_embeddings",
        "tools_fts",
        "_drizzle_migrations",
      ]) {
        await db.run(sql.raw(`DROP TABLE IF EXISTS ${name}`));
      }
    } finally {
      await db.run(sql.raw("PRAGMA foreign_keys = ON"));
    }
  }

  let entries = (await fs.readdir(MIGRATIONS_DIR))
    .filter((name) => name.endsWith(".sql"))
    .sort();
  if (only?.upto !== undefined) {
    entries = entries.filter((name) => name < "0018");
  }
  const onlyFilter = only?.only;
  if (onlyFilter !== undefined) {
    entries = entries.filter((name) => name === onlyFilter);
  }
  for (const name of entries) {
    const file = await fs.readFile(path.join(MIGRATIONS_DIR, name), "utf8");
    const statements = file
      .split("--> statement-breakpoint")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    for (const stmt of statements) {
      await db.run(sql.raw(stmt));
    }
  }
}

async function resetDb(): Promise<void> {
  await db.run(sql.raw("PRAGMA foreign_keys = OFF"));
  for (const name of [
    "approval_requests",
    "tool_policies",
    "tools",
    "service_credential_auth",
    "service_credentials",
    "module_credential_auth",
    "module_credentials",
    "registry_credential_auth",
    "registry_credentials",
    "oauth_pendings",
    "oauth_clients",
    "services",
    "modules",
    "registries",
    "processes",
  ]) {
    await db.run(sql.raw(`DELETE FROM ${name}`));
  }
  await db.run(sql.raw("PRAGMA foreign_keys = ON"));
}

const SERVICE_SCHEMES = {
  apiKey: { type: "apiKey", in: "header", paramName: "X-API-Key" },
  basic: { type: "http", scheme: "basic" },
  bearer: { type: "http", scheme: "bearer" },
  oauth2: {
    type: "oauth2",
    grantTypes: ["authorizationCode"],
    authorizationUrl: "https://provider.example.com/authorize",
    tokenUrl: "https://provider.example.com/token",
    scopes: { read: "Read access", write: "Write access", admin: "Admin" },
    tokenPlacement: {
      in: "header",
      paramName: "Authorization",
      prefix: "Bearer",
    },
  },
};

async function ensureService(id: string): Promise<void> {
  await db
    .insert(modules)
    .values({
      id: "test-adapter",
      name: "test-adapter",
      type: "adapter",
      description: "",
      hash: "h",
      version: "0.0.0",
      source: "",
    })
    .onConflictDoNothing();
  await db
    .insert(services)
    .values({
      id,
      name: id,
      hash: "h",
      adapter: "test-adapter",
      configSchema: { type: "object" },
      secretsSchema: { type: "object" },
      adapterDomain: {},
      schemes: SERVICE_SCHEMES,
    })
    .onConflictDoNothing();
}

async function ensureProcess(id: number): Promise<void> {
  await db
    .insert(processes)
    .values({
      id,
      code: `proc-${id}`,
      envConfig: {},
      createdAt: new Date().toISOString(),
      state: "running",
    })
    .onConflictDoNothing();
}

function makeApprovalId(): string {
  return `apr_${crypto.randomUUID().replace(/-/g, "")}`;
}

function makeParameters(data: Record<string, unknown>): string {
  return JSON.stringify(encryptSecrets(data));
}

describe("approval.service", () => {
  beforeAll(async () => {
    process.env.CYRNEL_SECRETS_KEY = SECRETS_KEY;
    delete process.env.CYRNEL_SECRETS_PREVIOUS_KEYS;
    await applyMigrations();
  });

  afterAll(() => {
    if (originalSecretsKey === undefined) {
      delete process.env.CYRNEL_SECRETS_KEY;
    } else {
      process.env.CYRNEL_SECRETS_KEY = originalSecretsKey;
    }
    if (originalPreviousKeys === undefined) {
      delete process.env.CYRNEL_SECRETS_PREVIOUS_KEYS;
    } else {
      process.env.CYRNEL_SECRETS_PREVIOUS_KEYS = originalPreviousKeys;
    }
  });

  beforeEach(async () => {
    await resetDb();
    vi.unstubAllGlobals();
  });

  describe("listApprovals", () => {
    it("returns empty list when no approvals exist", async () => {
      const result = await listApprovals({});
      expect(result.items).toEqual([]);
      expect(result.nextCursor).toBeNull();
      expect(result.hasMore).toBe(false);
    });

    it("lists approvals with all fields", async () => {
      await ensureService("svc-1");
      await ensureProcess(1);

      const id1 = makeApprovalId();
      const id2 = makeApprovalId();
      const now = Date.now();

      await db.insert(approvalRequests).values([
        {
          id: id1,
          serviceId: "svc-1",
          toolId: "tool-1",
          processId: 1,
          parameters: makeParameters({ key: "value1" }),
          state: "pending",
          createdAt: new Date(now).toISOString(),
          expiresAt: now + 60000,
          decidedAt: null,
        },
        {
          id: id2,
          serviceId: "svc-1",
          toolId: "tool-2",
          processId: 1,
          parameters: makeParameters({ key: "value2" }),
          state: "approved",
          createdAt: new Date(now + 1000).toISOString(),
          expiresAt: now + 61000,
          decidedAt: now + 5000,
        },
      ]);

      const result = await listApprovals({});

      expect(result.items).toHaveLength(2);
      expect(result.items[0].id).toBe(id2);
      expect(result.items[1].id).toBe(id1);
      expect(result.items[0].parameters).toEqual({ key: "value2" });
      expect(result.items[1].parameters).toEqual({ key: "value1" });
    });

    it("filters by state", async () => {
      await ensureService("svc-1");
      await ensureProcess(1);

      const now = Date.now();
      await db.insert(approvalRequests).values([
        {
          id: makeApprovalId(),
          serviceId: "svc-1",
          toolId: "tool-1",
          processId: 1,
          parameters: makeParameters({}),
          state: "pending",
          createdAt: new Date(now).toISOString(),
          expiresAt: now + 60000,
          decidedAt: null,
        },
        {
          id: makeApprovalId(),
          serviceId: "svc-1",
          toolId: "tool-2",
          processId: 1,
          parameters: makeParameters({}),
          state: "approved",
          createdAt: new Date(now + 1000).toISOString(),
          expiresAt: now + 61000,
          decidedAt: now + 5000,
        },
        {
          id: makeApprovalId(),
          serviceId: "svc-1",
          toolId: "tool-3",
          processId: 1,
          parameters: makeParameters({}),
          state: "denied",
          createdAt: new Date(now + 2000).toISOString(),
          expiresAt: now + 62000,
          decidedAt: now + 6000,
        },
      ]);

      const pending = await listApprovals({ state: "pending" });
      expect(pending.items).toHaveLength(1);
      expect(pending.items[0].state).toBe("pending");

      const approved = await listApprovals({ state: "approved" });
      expect(approved.items).toHaveLength(1);
      expect(approved.items[0].state).toBe("approved");
    });

    it("filters by serviceId", async () => {
      await ensureService("svc-1");
      await ensureService("svc-2");
      await ensureProcess(1);

      const now = Date.now();
      await db.insert(approvalRequests).values([
        {
          id: makeApprovalId(),
          serviceId: "svc-1",
          toolId: "tool-1",
          processId: 1,
          parameters: makeParameters({}),
          state: "pending",
          createdAt: new Date(now).toISOString(),
          expiresAt: now + 60000,
          decidedAt: null,
        },
        {
          id: makeApprovalId(),
          serviceId: "svc-2",
          toolId: "tool-1",
          processId: 1,
          parameters: makeParameters({}),
          state: "pending",
          createdAt: new Date(now + 1000).toISOString(),
          expiresAt: now + 61000,
          decidedAt: null,
        },
      ]);

      const result = await listApprovals({ serviceId: "svc-1" });
      expect(result.items).toHaveLength(1);
      expect(result.items[0].serviceId).toBe("svc-1");
    });

    it("filters by toolId", async () => {
      await ensureService("svc-1");
      await ensureProcess(1);

      const now = Date.now();
      await db.insert(approvalRequests).values([
        {
          id: makeApprovalId(),
          serviceId: "svc-1",
          toolId: "tool-a",
          processId: 1,
          parameters: makeParameters({}),
          state: "pending",
          createdAt: new Date(now).toISOString(),
          expiresAt: now + 60000,
          decidedAt: null,
        },
        {
          id: makeApprovalId(),
          serviceId: "svc-1",
          toolId: "tool-b",
          processId: 1,
          parameters: makeParameters({}),
          state: "pending",
          createdAt: new Date(now + 1000).toISOString(),
          expiresAt: now + 61000,
          decidedAt: null,
        },
      ]);

      const result = await listApprovals({ toolId: "tool-a" });
      expect(result.items).toHaveLength(1);
      expect(result.items[0].toolId).toBe("tool-a");
    });

    it("filters by processId", async () => {
      await ensureService("svc-1");
      await ensureProcess(1);
      await ensureProcess(2);

      const now = Date.now();
      await db.insert(approvalRequests).values([
        {
          id: makeApprovalId(),
          serviceId: "svc-1",
          toolId: "tool-1",
          processId: 1,
          parameters: makeParameters({}),
          state: "pending",
          createdAt: new Date(now).toISOString(),
          expiresAt: now + 60000,
          decidedAt: null,
        },
        {
          id: makeApprovalId(),
          serviceId: "svc-1",
          toolId: "tool-2",
          processId: 2,
          parameters: makeParameters({}),
          state: "pending",
          createdAt: new Date(now + 1000).toISOString(),
          expiresAt: now + 61000,
          decidedAt: null,
        },
      ]);

      const result = await listApprovals({ processId: 1 });
      expect(result.items).toHaveLength(1);
      expect(result.items[0].processId).toBe(1);
    });

    it("paginates with limit", async () => {
      await ensureService("svc-1");
      await ensureProcess(1);

      const now = Date.now();
      const ids = Array.from({ length: 5 }, () => makeApprovalId());
      await db.insert(approvalRequests).values(
        ids.map((id, i) => ({
          id,
          serviceId: "svc-1",
          toolId: `tool-${i}`,
          processId: 1,
          parameters: makeParameters({}),
          state: "pending",
          createdAt: new Date(now + i * 1000).toISOString(),
          expiresAt: now + 60000,
          decidedAt: null,
        })),
      );

      const result = await listApprovals({ limit: 2 });
      expect(result.items).toHaveLength(2);
      expect(result.hasMore).toBe(true);
      expect(result.nextCursor).not.toBeNull();
    });

    it("paginates with cursor", async () => {
      await ensureService("svc-1");
      await ensureProcess(1);

      const now = Date.now();
      const ids = Array.from({ length: 3 }, () => makeApprovalId());
      await db.insert(approvalRequests).values(
        ids.map((id, i) => ({
          id,
          serviceId: "svc-1",
          toolId: `tool-${i}`,
          processId: 1,
          parameters: makeParameters({}),
          state: "pending",
          createdAt: new Date(now + i * 1000).toISOString(),
          expiresAt: now + 60000,
          decidedAt: null,
        })),
      );

      const first = await listApprovals({ limit: 2 });
      expect(first.items).toHaveLength(2);

      const second = await listApprovals({
        limit: 2,
        cursor: first.nextCursor!,
      });
      expect(second.items).toHaveLength(1);
      expect(second.hasMore).toBe(false);
    });
  });

  describe("getApproval", () => {
    it("returns approval by id", async () => {
      await ensureService("svc-1");
      await ensureProcess(1);

      const id = makeApprovalId();
      const now = Date.now();
      await db.insert(approvalRequests).values({
        id,
        serviceId: "svc-1",
        toolId: "tool-1",
        processId: 1,
        parameters: makeParameters({ secret: "value" }),
        state: "pending",
        createdAt: new Date(now).toISOString(),
        expiresAt: now + 60000,
        decidedAt: null,
      });

      const result = await getApproval(id);

      expect(result.id).toBe(id);
      expect(result.serviceId).toBe("svc-1");
      expect(result.toolId).toBe("tool-1");
      expect(result.processId).toBe(1);
      expect(result.parameters).toEqual({ secret: "value" });
      expect(result.state).toBe("pending");
    });

    it("throws 404 for non-existent approval", async () => {
      await expect(getApproval("nonexistent")).rejects.toMatchObject({
        statusCode: 404,
      });
    });

    it("decrypts encrypted parameters", async () => {
      await ensureService("svc-1");

      const id = makeApprovalId();
      const now = Date.now();
      await db.insert(approvalRequests).values({
        id,
        serviceId: "svc-1",
        toolId: "tool-1",
        processId: null,
        parameters: makeParameters({ apiKey: "sk-123" }),
        state: "pending",
        createdAt: new Date(now).toISOString(),
        expiresAt: now + 60000,
        decidedAt: null,
      });

      const result = await getApproval(id);
      expect(result.parameters).toEqual({ apiKey: "sk-123" });
    });

    it("handles non-encrypted parameters", async () => {
      await ensureService("svc-1");

      const id = makeApprovalId();
      const now = Date.now();
      await db.insert(approvalRequests).values({
        id,
        serviceId: "svc-1",
        toolId: "tool-1",
        processId: null,
        parameters: JSON.stringify({ plain: "text" }),
        state: "pending",
        createdAt: new Date(now).toISOString(),
        expiresAt: now + 60000,
        decidedAt: null,
      });

      const result = await getApproval(id);
      expect(result.parameters).toEqual({ plain: "text" });
    });

    it("handles malformed parameters gracefully", async () => {
      await ensureService("svc-1");

      const id = makeApprovalId();
      const now = Date.now();
      await db.insert(approvalRequests).values({
        id,
        serviceId: "svc-1",
        toolId: "tool-1",
        processId: null,
        parameters: "not json",
        state: "pending",
        createdAt: new Date(now).toISOString(),
        expiresAt: now + 60000,
        decidedAt: null,
      });

      const result = await getApproval(id);
      expect(result.parameters).toEqual({});
    });
  });

  describe("resolveApproval", () => {
    it("resolves pending approval to approved", async () => {
      await ensureService("svc-1");
      await ensureProcess(1);

      const id = makeApprovalId();
      const now = Date.now();
      await db.insert(approvalRequests).values({
        id,
        serviceId: "svc-1",
        toolId: "tool-1",
        processId: 1,
        parameters: makeParameters({}),
        state: "pending",
        createdAt: new Date(now).toISOString(),
        expiresAt: now + 60000,
        decidedAt: null,
      });

      const result = await resolveApproval(id, "approved");

      expect(result.resolved).toBe(true);
      expect(result.processId).toBe(1);
      expect(result.pendingCount).toBe(0);

      const row = await db
        .select()
        .from(approvalRequests)
        .where(sql`id = ${id}`)
        .limit(1);
      expect(row[0].state).toBe("approved");
      expect(row[0].decidedAt).not.toBeNull();
    });

    it("resolves pending approval to denied", async () => {
      await ensureService("svc-1");
      await ensureProcess(1);

      const id = makeApprovalId();
      const now = Date.now();
      await db.insert(approvalRequests).values({
        id,
        serviceId: "svc-1",
        toolId: "tool-1",
        processId: 1,
        parameters: makeParameters({}),
        state: "pending",
        createdAt: new Date(now).toISOString(),
        expiresAt: now + 60000,
        decidedAt: null,
      });

      const result = await resolveApproval(id, "denied");

      expect(result.resolved).toBe(true);
      expect(result.processId).toBe(1);

      const row = await db
        .select()
        .from(approvalRequests)
        .where(sql`id = ${id}`)
        .limit(1);
      expect(row[0].state).toBe("denied");
    });

    it("resolves pending approval to expired", async () => {
      await ensureService("svc-1");
      await ensureProcess(1);

      const id = makeApprovalId();
      const now = Date.now();
      await db.insert(approvalRequests).values({
        id,
        serviceId: "svc-1",
        toolId: "tool-1",
        processId: 1,
        parameters: makeParameters({}),
        state: "pending",
        createdAt: new Date(now).toISOString(),
        expiresAt: now - 1000, // already expired
        decidedAt: null,
      });

      const result = await resolveApproval(id, "expired");

      expect(result.resolved).toBe(true);

      const row = await db
        .select()
        .from(approvalRequests)
        .where(sql`id = ${id}`)
        .limit(1);
      expect(row[0].state).toBe("expired");
    });

    it("returns resolved: false for already resolved approval", async () => {
      await ensureService("svc-1");
      await ensureProcess(1);

      const id = makeApprovalId();
      const now = Date.now();
      await db.insert(approvalRequests).values({
        id,
        serviceId: "svc-1",
        toolId: "tool-1",
        processId: 1,
        parameters: makeParameters({}),
        state: "approved",
        createdAt: new Date(now).toISOString(),
        expiresAt: now + 60000,
        decidedAt: now - 1000,
      });

      const result = await resolveApproval(id, "approved");

      expect(result.resolved).toBe(false);
      expect(result.shouldExpireStale).toBe(false);
    });

    it("returns resolved: false for non-existent approval", async () => {
      const result = await resolveApproval("nonexistent", "approved");
      expect(result.resolved).toBe(false);
    });

    it("expires stale approval when resolving to approved but already expired", async () => {
      await ensureService("svc-1");
      await ensureProcess(1);

      const id = makeApprovalId();
      const now = Date.now();
      await db.insert(approvalRequests).values({
        id,
        serviceId: "svc-1",
        toolId: "tool-1",
        processId: 1,
        parameters: makeParameters({}),
        state: "pending",
        createdAt: new Date(now - 10000).toISOString(),
        expiresAt: now - 1000,
        decidedAt: null,
      });

      const result = await resolveApproval(id, "approved");

      expect(result.resolved).toBe(false);
      expect(result.shouldExpireStale).toBe(true);

      const row = await db
        .select()
        .from(approvalRequests)
        .where(sql`id = ${id}`)
        .limit(1);
      expect(row[0].state).toBe("expired");
    });

    it("does not expire stale when target is expired", async () => {
      await ensureService("svc-1");
      await ensureProcess(1);

      const id = makeApprovalId();
      const now = Date.now();
      await db.insert(approvalRequests).values({
        id,
        serviceId: "svc-1",
        toolId: "tool-1",
        processId: 1,
        parameters: makeParameters({}),
        state: "pending",
        createdAt: new Date(now - 10000).toISOString(),
        expiresAt: now - 1000,
        decidedAt: null,
      });

      const result = await resolveApproval(id, "expired");

      expect(result.resolved).toBe(true);
      expect(result.shouldExpireStale).toBeUndefined();
    });

    it("returns pendingCount for process with multiple pending approvals", async () => {
      await ensureService("svc-1");
      await ensureProcess(1);

      const now = Date.now();
      const id1 = makeApprovalId();
      const id2 = makeApprovalId();
      const id3 = makeApprovalId();

      await db.insert(approvalRequests).values([
        {
          id: id1,
          serviceId: "svc-1",
          toolId: "tool-1",
          processId: 1,
          parameters: makeParameters({}),
          state: "pending",
          createdAt: new Date(now).toISOString(),
          expiresAt: now + 60000,
          decidedAt: null,
        },
        {
          id: id2,
          serviceId: "svc-1",
          toolId: "tool-2",
          processId: 1,
          parameters: makeParameters({}),
          state: "pending",
          createdAt: new Date(now + 1000).toISOString(),
          expiresAt: now + 61000,
          decidedAt: null,
        },
        {
          id: id3,
          serviceId: "svc-1",
          toolId: "tool-3",
          processId: 1,
          parameters: makeParameters({}),
          state: "approved",
          createdAt: new Date(now + 2000).toISOString(),
          expiresAt: now + 62000,
          decidedAt: now + 5000,
        },
      ]);

      const result = await resolveApproval(id1, "approved");

      expect(result.resolved).toBe(true);
      expect(result.pendingCount).toBe(1);
    });

    it("returns pendingCount 0 when processId is null", async () => {
      await ensureService("svc-1");

      const id = makeApprovalId();
      const now = Date.now();
      await db.insert(approvalRequests).values({
        id,
        serviceId: "svc-1",
        toolId: "tool-1",
        processId: null,
        parameters: makeParameters({}),
        state: "pending",
        createdAt: new Date(now).toISOString(),
        expiresAt: now + 60000,
        decidedAt: null,
      });

      const result = await resolveApproval(id, "approved");

      expect(result.resolved).toBe(true);
      expect(result.processId).toBeNull();
      expect(result.pendingCount).toBe(0);
    });
  });

  describe("sweepExpiredApprovals", () => {
    it("expires pending approvals past their expiry time", async () => {
      await ensureService("svc-1");
      await ensureProcess(1);

      const now = Date.now();
      const id1 = makeApprovalId();
      const id2 = makeApprovalId();
      const id3 = makeApprovalId();

      await db.insert(approvalRequests).values([
        {
          id: id1,
          serviceId: "svc-1",
          toolId: "tool-1",
          processId: 1,
          parameters: makeParameters({}),
          state: "pending",
          createdAt: new Date(now - 10000).toISOString(),
          expiresAt: now - 1000,
          decidedAt: null,
        },
        {
          id: id2,
          serviceId: "svc-1",
          toolId: "tool-2",
          processId: 1,
          parameters: makeParameters({}),
          state: "pending",
          createdAt: new Date(now).toISOString(),
          expiresAt: now + 60000,
          decidedAt: null,
        },
        {
          id: id3,
          serviceId: "svc-1",
          toolId: "tool-3",
          processId: 1,
          parameters: makeParameters({}),
          state: "approved",
          createdAt: new Date(now - 10000).toISOString(),
          expiresAt: now - 1000,
          decidedAt: now - 5000,
        },
      ]);

      const count = await sweepExpiredApprovals();

      expect(count).toBe(1);

      const rows = await db.select().from(approvalRequests).all();
      const expired = rows.find((r) => r.id === id1);
      expect(expired?.state).toBe("expired");
      expect(expired?.decidedAt).not.toBeNull();

      const stillPending = rows.find((r) => r.id === id2);
      expect(stillPending?.state).toBe("pending");
    });

    it("returns 0 when no expired approvals", async () => {
      await ensureService("svc-1");
      await ensureProcess(1);

      const now = Date.now();
      await db.insert(approvalRequests).values({
        id: makeApprovalId(),
        serviceId: "svc-1",
        toolId: "tool-1",
        processId: 1,
        parameters: makeParameters({}),
        state: "pending",
        createdAt: new Date(now).toISOString(),
        expiresAt: now + 60000,
        decidedAt: null,
      });

      const count = await sweepExpiredApprovals();
      expect(count).toBe(0);
    });

    it("notifies process holder for expired approvals", async () => {
      await ensureService("svc-1");
      await ensureProcess(1);

      const now = Date.now();
      const id = makeApprovalId();
      await db.insert(approvalRequests).values({
        id,
        serviceId: "svc-1",
        toolId: "tool-1",
        processId: 1,
        parameters: makeParameters({}),
        state: "pending",
        createdAt: new Date(now - 10000).toISOString(),
        expiresAt: now - 1000,
        decidedAt: null,
      });

      const notifyMock = vi.fn();
      const { getProcessService } = await import("@/services/process.holder");
      vi.mocked(getProcessService).mockReturnValue({
        notifyApprovalResolved: notifyMock,
      } as any);

      await sweepExpiredApprovals();

      expect(notifyMock).toHaveBeenCalledWith(1, 0, "expired");
    });
  });

  describe("sweepRetention", () => {
    it("deletes resolved approvals older than retention period", async () => {
      await ensureService("svc-1");
      await ensureProcess(1);

      const now = Date.now();
      const retentionMs = 24 * 60 * 60 * 1000;
      const oldDecidedAt = now - retentionMs - 1000;
      const recentDecidedAt = now - 1000;

      const idOld = makeApprovalId();
      const idRecent = makeApprovalId();
      const idPending = makeApprovalId();

      await db.insert(approvalRequests).values([
        {
          id: idOld,
          serviceId: "svc-1",
          toolId: "tool-1",
          processId: 1,
          parameters: makeParameters({}),
          state: "approved",
          createdAt: new Date(oldDecidedAt - 1000).toISOString(),
          expiresAt: oldDecidedAt + 60000,
          decidedAt: oldDecidedAt,
        },
        {
          id: idRecent,
          serviceId: "svc-1",
          toolId: "tool-2",
          processId: 1,
          parameters: makeParameters({}),
          state: "denied",
          createdAt: new Date(recentDecidedAt - 1000).toISOString(),
          expiresAt: recentDecidedAt + 60000,
          decidedAt: recentDecidedAt,
        },
        {
          id: idPending,
          serviceId: "svc-1",
          toolId: "tool-3",
          processId: 1,
          parameters: makeParameters({}),
          state: "pending",
          createdAt: new Date(now - 10000).toISOString(),
          expiresAt: now + 60000,
          decidedAt: null,
        },
      ]);

      const count = await sweepRetention(retentionMs);

      expect(count).toBe(1);

      const rows = await db.select().from(approvalRequests).all();
      const ids = rows.map((r) => r.id);
      expect(ids).toContain(idRecent);
      expect(ids).toContain(idPending);
      expect(ids).not.toContain(idOld);
    });

    it("returns 0 when retentionMs is 0", async () => {
      const count = await sweepRetention(0);
      expect(count).toBe(0);
    });

    it("deletes all resolved states: approved, denied, expired", async () => {
      await ensureService("svc-1");
      await ensureProcess(1);

      const now = Date.now();
      const oldDecidedAt = now - 86400000 - 1000;

      const idApproved = makeApprovalId();
      const idDenied = makeApprovalId();
      const idExpired = makeApprovalId();

      await db.insert(approvalRequests).values([
        {
          id: idApproved,
          serviceId: "svc-1",
          toolId: "tool-1",
          processId: 1,
          parameters: makeParameters({}),
          state: "approved",
          createdAt: new Date(oldDecidedAt - 1000).toISOString(),
          expiresAt: oldDecidedAt + 60000,
          decidedAt: oldDecidedAt,
        },
        {
          id: idDenied,
          serviceId: "svc-1",
          toolId: "tool-2",
          processId: 1,
          parameters: makeParameters({}),
          state: "denied",
          createdAt: new Date(oldDecidedAt - 1000).toISOString(),
          expiresAt: oldDecidedAt + 60000,
          decidedAt: oldDecidedAt,
        },
        {
          id: idExpired,
          serviceId: "svc-1",
          toolId: "tool-3",
          processId: 1,
          parameters: makeParameters({}),
          state: "expired",
          createdAt: new Date(oldDecidedAt - 1000).toISOString(),
          expiresAt: oldDecidedAt + 60000,
          decidedAt: oldDecidedAt,
        },
      ]);

      const count = await sweepRetention(86400000);

      expect(count).toBe(3);

      const rows = await db.select().from(approvalRequests).all();
      expect(rows).toHaveLength(0);
    });
  });
});
