import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {
  AdapterModule,
  EnvironmentBindings,
  EnvironmentModule,
  EnvironmentSetupContext,
  ExecutionExitState,
  ExecutionInput,
  InvokeInput,
  ServiceDefinition,
  ServiceState,
  ToolDocsInput,
} from "@cyrnel/sdk";
import { eq, sql } from "drizzle-orm";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

const SECRETS_KEY = crypto.randomBytes(32).toString("base64");
const ORIGINAL_SECRETS_KEY = process.env.CYRNEL_SECRETS_KEY;
const ORIGINAL_PREVIOUS_KEYS = process.env.CYRNEL_SECRETS_PREVIOUS_KEYS;

const { adapterInstances, envInstances, FakeAdapter, FakeEnvironment } =
  vi.hoisted(() => {
    class FakeAdapter implements AdapterModule {
      static setupImpl: (ctx: object) => Promise<void> = async () => {};

      readonly setupCalls: object[] = [];
      readonly teardownCalls: number[] = [];
      readonly hydrateCalls: ServiceState[] = [];
      readonly dehydrateCalls: string[] = [];
      readonly invokeCalls: InvokeInput[] = [];
      generateDefinitionImpl: (input: string) => Promise<ServiceDefinition> =
        async () => ({
          name: "fake",
          description: "fake",
          configSchema: {},
          secretsSchema: {},
          tools: [],
          adapterDomain: {},
        });
      invokeImpl: (input: InvokeInput) => Promise<unknown> = async () => ({});

      async setup(ctx: object): Promise<void> {
        this.setupCalls.push(ctx);
        await FakeAdapter.setupImpl(ctx);
      }
      async teardown(): Promise<void> {
        this.teardownCalls.push(Date.now());
      }
      async generateDefinition(input: string): Promise<ServiceDefinition> {
        return this.generateDefinitionImpl(input);
      }
      async hydrateService(state: ServiceState): Promise<void> {
        this.hydrateCalls.push(state);
      }
      async dehydrateService(id: string): Promise<void> {
        this.dehydrateCalls.push(id);
      }
      async invoke(input: InvokeInput): Promise<unknown> {
        this.invokeCalls.push(input);
        return this.invokeImpl(input);
      }
    }

    class FakeEnvironment implements EnvironmentModule {
      readonly setupCalls: EnvironmentSetupContext[] = [];
      readonly teardownCalls: number[] = [];
      readonly executeCalls: ExecutionInput[] = [];
      readonly killCalls: number[] = [];
      executeImpl: (input: ExecutionInput) => Promise<ExecutionExitState> =
        async () => "success";
      killImpl: (eid: number) => Promise<void> = async () => {};
      docs = "# env docs";
      toolDocs = "# tool docs";

      async setup(ctx: EnvironmentSetupContext): Promise<void> {
        this.setupCalls.push(ctx);
      }
      async teardown(): Promise<void> {
        this.teardownCalls.push(Date.now());
      }
      async execute(input: ExecutionInput): Promise<ExecutionExitState> {
        this.executeCalls.push(input);
        return this.executeImpl(input);
      }
      async kill(eid: number): Promise<void> {
        this.killCalls.push(eid);
        return this.killImpl(eid);
      }
      async generateDocs(): Promise<string> {
        return this.docs;
      }
      async generateToolDocs(_input: ToolDocsInput): Promise<string> {
        return this.toolDocs;
      }
    }

    return {
      adapterInstances: [] as InstanceType<typeof FakeAdapter>[],
      envInstances: [] as InstanceType<typeof FakeEnvironment>[],
      FakeAdapter,
      FakeEnvironment,
    };
  });

const { downloadBinaryMock, decompressMock } = vi.hoisted(() => ({
  downloadBinaryMock: vi.fn(),
  decompressMock: vi.fn(),
}));

vi.mock("@cyrnel/openapi", () => ({
  default: {
    configSchema: {
      type: "object",
      properties: {
        baseUrl: { type: "string" },
        timeout: { type: "number", default: 30 },
      },
      additionalProperties: false,
    },
    secretsSchema: {
      type: "object",
      properties: { apiKey: { type: "string" } },
      additionalProperties: false,
    },
    instantiate: () => {
      const instance = new FakeAdapter();
      adapterInstances.push(instance);
      return instance;
    },
  },
}));

vi.mock("@/utils/download.util", () => ({
  downloadBinary: downloadBinaryMock,
  MODULE_DOWNLOAD_MAX_BYTES: 10 * 1024 * 1024,
  downloadText: vi.fn(),
  DEFINITION_DOWNLOAD_MAX_BYTES: 2 * 1024 * 1024,
  assertRegistryAddressAllowed: vi.fn(),
}));

vi.mock("fzstd", () => ({
  decompress: decompressMock,
}));

vi.mock("@cyrnel/typescript-ivm", () => ({
  default: {
    configSchema: {
      type: "object",
      properties: {
        poolSize: { type: "integer", minimum: 1 },
        maxQueueSize: { type: "integer", minimum: 1 },
        timeoutMs: { type: "integer", minimum: 1 },
        memoryLimitMb: { type: "integer", minimum: 16 },
      },
      additionalProperties: false,
    },
    secretsSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    instantiate: () => {
      const instance = new FakeEnvironment();
      envInstances.push(instance);
      return instance;
    },
  },
}));

const { db } = await import("@/db/client");
const { ModuleService } = await import("@/services/modules.service");
const { HttpError } = await import("@/models/error.model");

const MIGRATIONS_DIR = path.resolve(import.meta.dirname, "../../drizzle");

async function createTestTar(
  dir: string,
  files: Record<string, string>,
): Promise<Buffer> {
  const { c: tarCreate } = await import("tar");
  const tarPath = path.join(dir, "test.tar");

  for (const [filePath, content] of Object.entries(files)) {
    const fullPath = path.join(dir, filePath);
    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.writeFile(fullPath, content);
  }

  await tarCreate({ cwd: dir, file: tarPath }, ["."]);
  return fs.readFile(tarPath);
}

async function applyMigrations(): Promise<void> {
  const entries = (await fs.readdir(MIGRATIONS_DIR))
    .filter((name) => name.endsWith(".sql"))
    .sort();
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

function unwrap<T>(value: T | undefined | null, label = "value"): T {
  if (value === undefined || value === null) {
    throw new Error(`Expected ${label} to be defined.`);
  }
  return value;
}

async function resetDb(): Promise<void> {
  await db.run(sql.raw("PRAGMA foreign_keys = OFF"));
  await db.run(sql.raw("DELETE FROM tools"));
  await db.run(sql.raw("DELETE FROM service_secrets"));
  await db.run(sql.raw("DELETE FROM service_configurations"));
  await db.run(sql.raw("DELETE FROM services"));
  await db.run(sql.raw("DELETE FROM module_secrets"));
  await db.run(sql.raw("DELETE FROM module_configurations"));
  await db.run(sql.raw("DELETE FROM modules"));
  await db.run(sql.raw("PRAGMA foreign_keys = ON"));
}

function makeBindings(): EnvironmentBindings {
  return {
    invokeTool: vi.fn(async () => null),
    setState: vi.fn(),
    setError: vi.fn(),
    emitStdout: vi.fn(),
    emitStderr: vi.fn(),
    emitOutput: vi.fn(),
  };
}

function makeLifecycle() {
  return {
    hydrateAdapter: vi.fn(async (_id: string) => {}),
  };
}

const MISSING_PATH = path.join(os.tmpdir(), "cyrnel-no-such-modules-dir");

describe("ModuleService", () => {
  beforeAll(async () => {
    process.env.CYRNEL_SECRETS_KEY = SECRETS_KEY;
    delete process.env.CYRNEL_SECRETS_PREVIOUS_KEYS;
    await applyMigrations();
  });

  afterAll(() => {
    if (ORIGINAL_SECRETS_KEY === undefined) {
      delete process.env.CYRNEL_SECRETS_KEY;
    } else {
      process.env.CYRNEL_SECRETS_KEY = ORIGINAL_SECRETS_KEY;
    }
    if (ORIGINAL_PREVIOUS_KEYS === undefined) {
      delete process.env.CYRNEL_SECRETS_PREVIOUS_KEYS;
    } else {
      process.env.CYRNEL_SECRETS_PREVIOUS_KEYS = ORIGINAL_PREVIOUS_KEYS;
    }
  });

  beforeEach(async () => {
    await resetDb();
    adapterInstances.length = 0;
    envInstances.length = 0;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    downloadBinaryMock.mockReset();
    decompressMock.mockReset();
  });

  describe("initialize()", () => {
    it("inserts manifest rows for built-in modules on a clean DB", async () => {
      const service = new ModuleService(makeBindings(), makeLifecycle());
      await service.initialize(MISSING_PATH);

      const rows = await db
        .select()
        .from((await import("@/db/schema")).modules);

      expect(rows.map((r) => r.id).sort()).toEqual([
        "openapi",
        "typescript-ivm",
      ]);
      for (const row of rows) {
        expect(row.enabled).toBe(true);
        expect(row.missing).toBe(false);
      }

      const byId = new Map(rows.map((row) => [row.id, row]));
      expect(byId.get("openapi")).toMatchObject({
        name: "OpenAPI Adapter",
      });
      expect(byId.get("typescript-ivm")).toMatchObject({
        name: "Typescript Isolated VM",
      });
    });

    it("activates the adapter and environment on first run", async () => {
      const lifecycle = makeLifecycle();
      const service = new ModuleService(makeBindings(), lifecycle);
      await service.initialize(MISSING_PATH);

      expect(adapterInstances).toHaveLength(1);
      expect(adapterInstances[0]?.setupCalls).toHaveLength(1);
      expect(lifecycle.hydrateAdapter).toHaveBeenCalledWith("openapi");

      expect(envInstances).toHaveLength(1);
      expect(envInstances[0]?.setupCalls).toHaveLength(1);
    });

    it("does NOT activate modules whose DB row says enabled=false", async () => {
      await db.run(
        sql`INSERT INTO modules (id, name, type, description, enabled, missing)
            VALUES ('openapi', 'openapi', 'adapter', '', 0, 0),
                   ('typescript-ivm', 'typescript-ivm', 'environment', '', 0, 0)`,
      );

      const lifecycle = makeLifecycle();
      const service = new ModuleService(makeBindings(), lifecycle);
      await service.initialize(MISSING_PATH);

      expect(adapterInstances).toHaveLength(0);
      expect(envInstances).toHaveLength(0);
      expect(lifecycle.hydrateAdapter).not.toHaveBeenCalled();
    });

    it("registers custom modules with separate id and display name", async () => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cyrnel-mod-"));
      try {
        const moduleDir = path.join(dir, "custom");
        await fs.mkdir(moduleDir);
        await fs.writeFile(
          path.join(moduleDir, "module.json"),
          JSON.stringify({
            id: "customMod",
            name: "Custom Module",
            description: "custom",
            type: "adapter",
            version: "1.0.0",
            main: "index.mjs",
          }),
        );
        await fs.writeFile(
          path.join(moduleDir, "index.mjs"),
          `export default {
            configSchema: { type: "object", properties: {}, additionalProperties: false },
            secretsSchema: { type: "null" },
            instantiate() {
              return {
                async setup() {},
                async teardown() {},
                async generateDefinition() { return { name: "x", description: "", configSchema: {}, secretsSchema: {}, tools: [], adapterDomain: {} }; },
                async hydrateService() {},
                async dehydrateService() {},
                async invoke() { return null; },
              };
            },
          }`,
        );

        const service = new ModuleService(makeBindings(), makeLifecycle());
        await service.initialize(dir);

        const record = unwrap(
          await service.get("customMod"),
          "module 'customMod'",
        );
        expect(record).toMatchObject({
          id: "customMod",
          name: "Custom Module",
          isBuiltin: false,
          type: "adapter",
        });
      } finally {
        await fs.rm(dir, { recursive: true, force: true });
      }
    });

    it("registers custom modules from a directory", async () => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cyrnel-mod-"));
      try {
        const moduleDir = path.join(dir, "custom");
        await fs.mkdir(moduleDir);
        await fs.writeFile(
          path.join(moduleDir, "module.json"),
          JSON.stringify({
            id: "customMod",
            name: "Custom Module",
            description: "custom",
            type: "adapter",
            version: "1.0.0",
            main: "index.mjs",
          }),
        );
        await fs.writeFile(
          path.join(moduleDir, "index.mjs"),
          `export default {
            configSchema: { type: "object", properties: {}, additionalProperties: false },
            secretsSchema: { type: "null" },
            instantiate() {
              return {
                async setup() {},
                async teardown() {},
                async generateDefinition() { return { name: "x", description: "", configSchema: {}, secretsSchema: {}, tools: [], adapterDomain: {} }; },
                async hydrateService() {},
                async dehydrateService() {},
                async invoke() { return null; },
              };
            },
          }`,
        );

        const service = new ModuleService(makeBindings(), makeLifecycle());
        await service.initialize(dir);

        const records = await service.list();
        const map = new Map(records.map((r) => [r.id, r]));
        expect(map.get("customMod")).toMatchObject({
          isBuiltin: false,
          type: "adapter",
        });
      } finally {
        await fs.rm(dir, { recursive: true, force: true });
      }
    });

    it("silently ignores a missing customModules path", async () => {
      const service = new ModuleService(makeBindings(), makeLifecycle());
      await expect(service.initialize(MISSING_PATH)).resolves.toBeUndefined();
    });

    it("throws on modules whose module.json omits a required id", async () => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cyrnel-mod-"));
      try {
        const moduleDir = path.join(dir, "no-id");
        await fs.mkdir(moduleDir);
        await fs.writeFile(
          path.join(moduleDir, "module.json"),
          JSON.stringify({
            name: "No Id Module",
            description: "missing id",
            type: "adapter",
            main: "index.mjs",
          }),
        );

        const service = new ModuleService(makeBindings(), makeLifecycle());
        await expect(service.initialize(dir)).rejects.toBeInstanceOf(HttpError);
      } finally {
        await fs.rm(dir, { recursive: true, force: true });
      }
    });

    it("throws on modules whose manifest 'main' escapes the module directory", async () => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cyrnel-mod-"));
      try {
        const moduleDir = path.join(dir, "evil");
        await fs.mkdir(moduleDir);
        await fs.writeFile(
          path.join(moduleDir, "module.json"),
          JSON.stringify({
            id: "evilMod",
            name: "Evil Module",
            description: "tries to escape",
            type: "adapter",
            version: "1.0.0",
            main: "../../../../../../etc/passwd",
          }),
        );

        const service = new ModuleService(makeBindings(), makeLifecycle());
        await expect(service.initialize(dir)).rejects.toBeInstanceOf(HttpError);
      } finally {
        await fs.rm(dir, { recursive: true, force: true });
      }
    });

    it("throws on modules with a malformed module.json", async () => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cyrnel-mod-"));
      try {
        const moduleDir = path.join(dir, "broken");
        await fs.mkdir(moduleDir);
        await fs.writeFile(
          path.join(moduleDir, "module.json"),
          "{ this is not valid json",
        );

        const service = new ModuleService(makeBindings(), makeLifecycle());
        await expect(service.initialize(dir)).rejects.toBeInstanceOf(HttpError);
      } finally {
        await fs.rm(dir, { recursive: true, force: true });
      }
    });

    it("skips module directories with no module.json", async () => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cyrnel-mod-"));
      try {
        await fs.mkdir(path.join(dir, "empty"));

        const service = new ModuleService(makeBindings(), makeLifecycle());
        await expect(service.initialize(dir)).resolves.toBeUndefined();
      } finally {
        await fs.rm(dir, { recursive: true, force: true });
      }
    });
  });

  describe("shutdown()", () => {
    it("tears down adapters and drains the active environment", async () => {
      const service = new ModuleService(makeBindings(), makeLifecycle());
      await service.initialize(MISSING_PATH);

      const adapter = unwrap(adapterInstances[0], "adapter");
      const env = unwrap(envInstances[0], "environment");

      await service.shutdown();

      expect(adapter.teardownCalls.length).toBeGreaterThan(0);
      expect(env.teardownCalls.length).toBeGreaterThan(0);
    });

    it("kills in-flight executions during shutdown", async () => {
      const service = new ModuleService(makeBindings(), makeLifecycle());
      await service.initialize(MISSING_PATH);

      const env = unwrap(envInstances[0], "environment");
      let release!: () => void;
      env.executeImpl = () =>
        new Promise<ExecutionExitState>((resolve) => {
          release = () => resolve("canceled");
        });
      env.killImpl = async (_eid) => {
        release?.();
      };

      const exec = service.execute({ eid: 42, code: "x" });
      await service.shutdown();
      await exec;

      expect(env.killCalls).toContain(42);
    });

    it("swallows teardown errors", async () => {
      const service = new ModuleService(makeBindings(), makeLifecycle());
      await service.initialize(MISSING_PATH);

      const adapter = unwrap(adapterInstances[0], "adapter");
      adapter.teardown = vi.fn(async () => {
        throw new Error("boom");
      });

      await expect(service.shutdown()).resolves.toBeUndefined();
    });
  });

  describe("execute()", () => {
    it("throws 503 when no environment is active", async () => {
      const service = new ModuleService(makeBindings(), makeLifecycle());
      await db.run(
        sql`INSERT INTO modules (id, name, type, description, enabled, missing)
            VALUES ('typescript-ivm', 'typescript-ivm', 'environment', '', 0, 0)`,
      );
      await service.initialize(MISSING_PATH);

      try {
        await service.execute({ eid: 1, code: "x" });
        throw new Error("should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(HttpError);
        expect((err as InstanceType<typeof HttpError>).statusCode).toBe(503);
      }
    });

    it("routes execute through the active environment", async () => {
      const service = new ModuleService(makeBindings(), makeLifecycle());
      await service.initialize(MISSING_PATH);

      const env = unwrap(envInstances[0], "environment");
      env.executeImpl = async () => "success";

      const result = await service.execute({ eid: 5, code: "x" });
      expect(result).toBe("success");
      expect(env.executeCalls.map((c) => c.eid)).toEqual([5]);
    });

    it("removes the execution from tracking once it resolves", async () => {
      const service = new ModuleService(makeBindings(), makeLifecycle());
      await service.initialize(MISSING_PATH);

      await service.execute({ eid: 7, code: "x" });
      await expect(service.kill(7)).resolves.toBeUndefined();
    });
  });

  describe("kill()", () => {
    it("forwards to the environment that ran the execution", async () => {
      const service = new ModuleService(makeBindings(), makeLifecycle());
      await service.initialize(MISSING_PATH);

      const env = unwrap(envInstances[0], "environment");
      let release!: () => void;
      env.executeImpl = () =>
        new Promise<ExecutionExitState>((resolve) => {
          release = () => resolve("canceled");
        });
      env.killImpl = async () => {
        release();
      };

      const exec = service.execute({ eid: 9, code: "x" });
      await service.kill(9);
      await exec;

      expect(env.killCalls).toContain(9);
    });

    it("is a no-op for unknown executions", async () => {
      const service = new ModuleService(makeBindings(), makeLifecycle());
      await service.initialize(MISSING_PATH);
      await expect(service.kill(9999)).resolves.toBeUndefined();
    });
  });

  describe("generateEnvironmentDocs / generateToolDocs", () => {
    it("delegates to the active environment", async () => {
      const service = new ModuleService(makeBindings(), makeLifecycle());
      await service.initialize(MISSING_PATH);

      expect(await service.generateEnvironmentDocs()).toBe("# env docs");
      expect(
        await service.generateToolDocs({
          serviceId: "s",
          toolId: "t",
          description: "",
          inputSchema: {},
          outputSchema: {},
        }),
      ).toBe("# tool docs");
    });

    it("throws 503 when no environment is active", async () => {
      const service = new ModuleService(makeBindings(), makeLifecycle());
      await db.run(
        sql`INSERT INTO modules (id, name, type, description, enabled, missing)
            VALUES ('typescript-ivm', 'typescript-ivm', 'environment', '', 0, 0)`,
      );
      await service.initialize(MISSING_PATH);

      await expect(service.generateEnvironmentDocs()).rejects.toMatchObject({
        statusCode: 503,
      });
    });
  });

  describe("generateDefinition", () => {
    it("delegates to the named adapter", async () => {
      const service = new ModuleService(makeBindings(), makeLifecycle());
      await service.initialize(MISSING_PATH);

      const adapter = unwrap(adapterInstances[0], "adapter");
      const def: ServiceDefinition = {
        name: "x",
        description: "",
        configSchema: {},
        secretsSchema: {},
        tools: [],
        adapterDomain: {},
      };
      adapter.generateDefinitionImpl = async () => def;

      const result = await service.generateDefinition({
        adapter: "openapi",
        definition: "payload",
      });
      expect(result).toBe(def);
    });

    it("throws 503 when the adapter is not active", async () => {
      const service = new ModuleService(makeBindings(), makeLifecycle());
      await db.run(
        sql`INSERT INTO modules (id, name, type, description, enabled, missing)
            VALUES ('openapi', 'openapi', 'adapter', '', 0, 0)`,
      );
      await service.initialize(MISSING_PATH);

      try {
        service.generateDefinition({
          adapter: "openapi",
          definition: "x",
        });
        throw new Error("should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(HttpError);
        expect((err as InstanceType<typeof HttpError>).statusCode).toBe(503);
      }
    });
  });

  describe("hydrateService / dehydrateService", () => {
    it("hydrate forwards the state to the named adapter", async () => {
      const service = new ModuleService(makeBindings(), makeLifecycle());
      await service.initialize(MISSING_PATH);

      const adapter = unwrap(adapterInstances[0], "adapter");
      const state: ServiceState = {
        id: "alpha",
        adapterDomain: {},
        tools: {},
        config: {},
        secrets: {},
      };
      await service.hydrateService("openapi", state);
      expect(adapter.hydrateCalls).toContainEqual(state);
    });

    it("dehydrate is silent for adapters that are not active", async () => {
      const service = new ModuleService(makeBindings(), makeLifecycle());
      await service.initialize(MISSING_PATH);

      await expect(
        service.dehydrateService("ghost-adapter", "alpha"),
      ).resolves.toBeUndefined();
    });

    it("dehydrate forwards to the named adapter when active", async () => {
      const service = new ModuleService(makeBindings(), makeLifecycle());
      await service.initialize(MISSING_PATH);

      await service.dehydrateService("openapi", "alpha");
      expect(adapterInstances[0]?.dehydrateCalls).toContain("alpha");
    });
  });

  describe("invoke()", () => {
    it("throws 404 when the service is unknown", async () => {
      const service = new ModuleService(makeBindings(), makeLifecycle());
      await service.initialize(MISSING_PATH);

      await expect(
        service.invoke({
          serviceId: "ghost",
          toolId: "t",
          parameters: {},
        }),
      ).rejects.toMatchObject({ statusCode: 404 });
    });

    it("throws 404 when the tool is unknown for the service", async () => {
      const service = new ModuleService(makeBindings(), makeLifecycle());
      await service.initialize(MISSING_PATH);

      await db.run(
        sql`INSERT INTO services (id, name, description, hash, source, adapter, enabled, config_schema, secrets_schema, adapter_domain)
            VALUES ('alpha', 'alpha', '', 'h', '', 'openapi', 1, '{}', '{}', '{}')`,
      );

      await expect(
        service.invoke({
          serviceId: "alpha",
          toolId: "ghost",
          parameters: {},
        }),
      ).rejects.toMatchObject({ statusCode: 404 });
    });

    it("throws 409 when the service is disabled", async () => {
      const service = new ModuleService(makeBindings(), makeLifecycle());
      await service.initialize(MISSING_PATH);

      await db.run(
        sql`INSERT INTO services (id, name, description, hash, source, adapter, enabled, config_schema, secrets_schema, adapter_domain)
            VALUES ('alpha', 'alpha', '', 'h', '', 'openapi', 0, '{}', '{}', '{}')`,
      );
      await db.run(
        sql`INSERT INTO tools (service_id, id, name, description, enabled, input_schema, output_schema, adapter_domain)
            VALUES ('alpha', 't', 't', '', 1, '{}', '{}', '{}')`,
      );

      await expect(
        service.invoke({
          serviceId: "alpha",
          toolId: "t",
          parameters: {},
        }),
      ).rejects.toMatchObject({ statusCode: 409 });
    });

    it("throws 409 when the tool is disabled", async () => {
      const service = new ModuleService(makeBindings(), makeLifecycle());
      await service.initialize(MISSING_PATH);

      await db.run(
        sql`INSERT INTO services (id, name, description, hash, source, adapter, enabled, config_schema, secrets_schema, adapter_domain)
            VALUES ('alpha', 'alpha', '', 'h', '', 'openapi', 1, '{}', '{}', '{}')`,
      );
      await db.run(
        sql`INSERT INTO tools (service_id, id, name, description, enabled, input_schema, output_schema, adapter_domain)
            VALUES ('alpha', 't', 't', '', 0, '{}', '{}', '{}')`,
      );

      await expect(
        service.invoke({
          serviceId: "alpha",
          toolId: "t",
          parameters: {},
        }),
      ).rejects.toMatchObject({ statusCode: 409 });
    });

    it("forwards a valid invocation to the adapter", async () => {
      const service = new ModuleService(makeBindings(), makeLifecycle());
      await service.initialize(MISSING_PATH);

      await db.run(
        sql`INSERT INTO services (id, name, description, hash, source, adapter, enabled, config_schema, secrets_schema, adapter_domain)
            VALUES ('alpha', 'alpha', '', 'h', '', 'openapi', 1, '{}', '{}', '{}')`,
      );
      await db.run(
        sql`INSERT INTO tools (service_id, id, name, description, enabled, input_schema, output_schema, adapter_domain)
            VALUES ('alpha', 't', 't', '', 1, '{}', '{}', '{}')`,
      );

      unwrap(adapterInstances[0], "adapter").invokeImpl = async () => ({
        ok: true,
      });
      const result = await service.invoke({
        serviceId: "alpha",
        toolId: "t",
        parameters: { x: 1 },
      });
      expect(result).toEqual({ ok: true });
      expect(adapterInstances[0]?.invokeCalls[0]?.parameters).toEqual({ x: 1 });
    });

    it("returns 504 when adapter invocation exceeds the configured timeout", async () => {
      const originalTimeoutMs = process.env.CYRNEL_INVOKE_TIMEOUT_MS;
      process.env.CYRNEL_INVOKE_TIMEOUT_MS = "1";

      try {
        const service = new ModuleService(makeBindings(), makeLifecycle());
        await service.initialize(MISSING_PATH);

        await db.run(
          sql`INSERT INTO services (id, name, description, hash, source, adapter, enabled, config_schema, secrets_schema, adapter_domain)
            VALUES ('alpha', 'alpha', '', 'h', '', 'openapi', 1, '{}', '{}', '{}')`,
        );
        await db.run(
          sql`INSERT INTO tools (service_id, id, name, description, enabled, input_schema, output_schema, adapter_domain)
            VALUES ('alpha', 't', 't', '', 1, '{}', '{}', '{}')`,
        );

        unwrap(adapterInstances[0], "adapter").invokeImpl = () =>
          new Promise(() => {});

        await expect(
          service.invoke({
            serviceId: "alpha",
            toolId: "t",
            parameters: {},
          }),
        ).rejects.toMatchObject({ statusCode: 504 });
      } finally {
        if (originalTimeoutMs === undefined) {
          delete process.env.CYRNEL_INVOKE_TIMEOUT_MS;
        } else {
          process.env.CYRNEL_INVOKE_TIMEOUT_MS = originalTimeoutMs;
        }
      }
    });
  });

  describe("list() / get()", () => {
    it("returns the registered manifests after initialize", async () => {
      const service = new ModuleService(makeBindings(), makeLifecycle());
      await service.initialize(MISSING_PATH);

      const rows = await service.list();
      expect(rows.map((r) => r.id).sort()).toEqual([
        "openapi",
        "typescript-ivm",
      ]);
      for (const row of rows) expect(row.isBuiltin).toBe(true);
    });

    it("filters by type, enabled, isBuiltin, and query", async () => {
      const service = new ModuleService(makeBindings(), makeLifecycle());
      await service.initialize(MISSING_PATH);

      expect(
        (await service.list({ type: "adapter" })).map((r) => r.id),
      ).toEqual(["openapi"]);
      expect(
        (await service.list({ type: "environment" })).map((r) => r.id),
      ).toEqual(["typescript-ivm"]);
      expect(
        (await service.list({ query: "openapi" })).map((r) => r.id),
      ).toEqual(["openapi"]);
      expect(
        (await service.list({ query: "openapi adapter" })).map((r) => r.id),
      ).toEqual(["openapi"]);
      expect(await service.list({ isBuiltin: false })).toHaveLength(0);
    });

    it("get() returns undefined for unknown ids", async () => {
      const service = new ModuleService(makeBindings(), makeLifecycle());
      await service.initialize(MISSING_PATH);
      expect(await service.get("ghost")).toBeUndefined();
    });

    it("get() includes config and secrets schemas", async () => {
      const service = new ModuleService(makeBindings(), makeLifecycle());
      await service.initialize(MISSING_PATH);

      const record = unwrap(await service.get("openapi"), "module 'openapi'");
      expect(record.configSchema).toMatchObject({
        type: "object",
        properties: { baseUrl: { type: "string" } },
      });
      expect(record.secretsSchema).toMatchObject({
        type: "object",
        properties: { apiKey: { type: "string" } },
      });
    });

    it("list() omits config and secrets schemas", async () => {
      const service = new ModuleService(makeBindings(), makeLifecycle());
      await service.initialize(MISSING_PATH);

      for (const row of await service.list()) {
        expect(row).not.toHaveProperty("configSchema");
        expect(row).not.toHaveProperty("secretsSchema");
      }
    });
  });

  describe("setEnabled()", () => {
    it("throws 404 when the module is unknown", async () => {
      const service = new ModuleService(makeBindings(), makeLifecycle());
      await service.initialize(MISSING_PATH);

      await expect(
        service.setEnabled({ id: "ghost", enabled: true }),
      ).rejects.toMatchObject({ statusCode: 404 });
    });

    it("throws 409 when trying to enable a missing module", async () => {
      const service = new ModuleService(makeBindings(), makeLifecycle());
      await service.initialize(MISSING_PATH);

      await db.run(sql`UPDATE modules SET missing = 1 WHERE id = 'openapi'`);

      await expect(
        service.setEnabled({ id: "openapi", enabled: true }),
      ).rejects.toMatchObject({ statusCode: 409 });
    });

    it("is a no-op when the target state matches the current state", async () => {
      const service = new ModuleService(makeBindings(), makeLifecycle());
      await service.initialize(MISSING_PATH);

      const beforeAdapterCount = adapterInstances.length;
      await service.setEnabled({ id: "openapi", enabled: true });
      expect(adapterInstances.length).toBe(beforeAdapterCount);
    });

    it("activates an adapter on enable and deactivates on disable", async () => {
      const service = new ModuleService(makeBindings(), makeLifecycle());
      await db.run(
        sql`INSERT INTO modules (id, name, type, description, enabled, missing)
            VALUES ('openapi', 'openapi', 'adapter', '', 0, 0),
                   ('typescript-ivm', 'typescript-ivm', 'environment', '', 0, 0)`,
      );
      await service.initialize(MISSING_PATH);
      expect(adapterInstances).toHaveLength(0);

      await service.setEnabled({ id: "openapi", enabled: true });
      expect(adapterInstances).toHaveLength(1);
      expect(adapterInstances[0]?.setupCalls).toHaveLength(1);

      await service.setEnabled({ id: "openapi", enabled: false });
      expect(adapterInstances[0]?.teardownCalls.length).toBeGreaterThan(0);
    });

    it("activates an environment on enable and disables it cleanly", async () => {
      const service = new ModuleService(makeBindings(), makeLifecycle());
      await db.run(
        sql`INSERT INTO modules (id, name, type, description, enabled, missing)
            VALUES ('typescript-ivm', 'typescript-ivm', 'environment', '', 0, 0)`,
      );
      await service.initialize(MISSING_PATH);

      expect(envInstances).toHaveLength(0);
      await service.setEnabled({ id: "typescript-ivm", enabled: true });
      expect(envInstances).toHaveLength(1);

      await service.setEnabled({ id: "typescript-ivm", enabled: false });
      await new Promise((resolve) => setImmediate(resolve));
      expect(envInstances[0]?.teardownCalls.length).toBeGreaterThan(0);
    });
  });

  describe("reconcile + reload", () => {
    it("marks rows for unregistered modules as missing (preserving enabled state)", async () => {
      const service = new ModuleService(makeBindings(), makeLifecycle());
      await db.run(
        sql`INSERT INTO modules (id, name, type, description, enabled, missing)
            VALUES ('legacy', 'legacy', 'adapter', '', 1, 0)`,
      );
      await service.initialize(MISSING_PATH);

      const row = unwrap(await service.get("legacy"), "module 'legacy'");
      expect(row.missing).toBe(true);
      expect(row.enabled).toBe(true);
    });

    it("syncs human-readable names from manifests on reconcile", async () => {
      await db.run(
        sql`INSERT INTO modules (id, name, type, description, enabled, missing)
            VALUES ('openapi', 'openapi', 'adapter', 'old description', 1, 0),
                   ('typescript-ivm', 'typescript-ivm', 'environment', '', 1, 0)`,
      );

      const service = new ModuleService(makeBindings(), makeLifecycle());
      await service.initialize(MISSING_PATH);

      expect(await service.get("openapi")).toMatchObject({
        id: "openapi",
        name: "OpenAPI Adapter",
        description: "Adapter for interacting with OpenAPI services",
      });
      expect(await service.get("typescript-ivm")).toMatchObject({
        id: "typescript-ivm",
        name: "Typescript Isolated VM",
      });
    });

    it("clears the missing flag when a previously missing module reappears", async () => {
      const first = new ModuleService(makeBindings(), makeLifecycle());
      await db.run(
        sql`INSERT INTO modules (id, name, type, description, enabled, missing)
            VALUES ('openapi', 'openapi', 'adapter', '', 0, 1)`,
      );
      await first.initialize(MISSING_PATH);

      const row = unwrap(await first.get("openapi"), "module 'openapi'");
      expect(row.missing).toBe(false);
    });

    it("reload() re-runs reconcile and respects new manifests", async () => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cyrnel-mod-"));
      try {
        const service = new ModuleService(makeBindings(), makeLifecycle());
        await service.initialize(dir);
        let rows = await service.list();
        expect(rows.map((r) => r.id).sort()).toEqual([
          "openapi",
          "typescript-ivm",
        ]);

        const modDir = path.join(dir, "fresh");
        await fs.mkdir(modDir);
        await fs.writeFile(
          path.join(modDir, "module.json"),
          JSON.stringify({
            id: "freshMod",
            name: "Fresh Module",
            description: "x",
            type: "adapter",
            version: "1.0.0",
            main: "index.mjs",
          }),
        );
        await fs.writeFile(
          path.join(modDir, "index.mjs"),
          `export default {
            configSchema: { type: "object", properties: {}, additionalProperties: false },
            secretsSchema: { type: "null" },
            instantiate() {
              return {
                async setup() {},
                async teardown() {},
                async generateDefinition() { return { name: "x", description: "", configSchema: {}, secretsSchema: {}, tools: [], adapterDomain: {} }; },
                async hydrateService() {},
                async dehydrateService() {},
                async invoke() { return null; },
              };
            },
          }`,
        );

        await service.reload();

        rows = await service.list();
        expect(rows.map((r) => r.id).sort()).toEqual(
          ["freshMod", "openapi", "typescript-ivm"].sort(),
        );
      } finally {
        await fs.rm(dir, { recursive: true, force: true });
      }
    });

    it("throws 503 when reload() is called before initialize()", async () => {
      const service = new ModuleService(makeBindings(), makeLifecycle());
      await expect(service.reload()).rejects.toMatchObject({ statusCode: 503 });
    });

    it("reload() does not deactivate in-memory state for now-missing modules", async () => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cyrnel-mod-"));
      try {
        const modDir = path.join(dir, "transient");
        await fs.mkdir(modDir);
        await fs.writeFile(
          path.join(modDir, "module.json"),
          JSON.stringify({
            id: "transientMod",
            name: "Transient Module",
            description: "x",
            type: "adapter",
            version: "1.0.0",
            main: "index.mjs",
          }),
        );
        await fs.writeFile(
          path.join(modDir, "index.mjs"),
          `export default {
            configSchema: { type: "object", properties: {}, additionalProperties: false },
            secretsSchema: { type: "null" },
            instantiate() {
              return {
                async setup() {},
                async teardown() {},
                async generateDefinition() { return { name: "x", description: "", configSchema: {}, secretsSchema: {}, tools: [], adapterDomain: {} }; },
                async hydrateService() {},
                async dehydrateService() {},
                async invoke() { return { stale: true }; },
              };
            },
          }`,
        );

        const service = new ModuleService(makeBindings(), makeLifecycle());
        await service.initialize(dir);
        await db.run(
          sql`INSERT INTO services (id, name, description, hash, source, adapter, enabled, config_schema, secrets_schema, adapter_domain)
              VALUES ('alpha', 'alpha', '', 'h', '', 'transientMod', 1, '{}', '{}', '{}')`,
        );
        await db.run(
          sql`INSERT INTO tools (service_id, id, name, description, enabled, input_schema, output_schema, adapter_domain)
              VALUES ('alpha', 't', 't', '', 1, '{}', '{}', '{}')`,
        );

        await fs.rm(modDir, { recursive: true, force: true });
        await service.reload();

        const row = unwrap(
          await service.get("transientMod"),
          "module 'transientMod'",
        );
        expect(row.missing).toBe(true);
        expect(row.enabled).toBe(true);

        await expect(
          service.invoke({
            serviceId: "alpha",
            toolId: "t",
            parameters: {},
          }),
        ).rejects.toMatchObject({ statusCode: 503 });
      } finally {
        await fs.rm(dir, { recursive: true, force: true });
      }
    });
  });

  describe("environment draining", () => {
    it("waits for in-flight executions before tearing down a deactivated environment", async () => {
      const service = new ModuleService(makeBindings(), makeLifecycle());
      await service.initialize(MISSING_PATH);

      const env = unwrap(envInstances[0], "environment");
      let release!: () => void;
      env.executeImpl = () =>
        new Promise<ExecutionExitState>((resolve) => {
          release = () => resolve("success");
        });

      const exec = service.execute({ eid: 100, code: "x" });
      await service.setEnabled({ id: "typescript-ivm", enabled: false });

      expect(env.teardownCalls.length).toBe(0);

      release();
      await exec;
      await new Promise((resolve) => setImmediate(resolve));
      expect(env.teardownCalls.length).toBeGreaterThan(0);
    });
  });

  describe("config & secrets", () => {
    it("passes config and secrets to setup by default", async () => {
      const service = new ModuleService(makeBindings(), makeLifecycle());
      await service.initialize(MISSING_PATH);

      const adapter = unwrap(adapterInstances[0], "adapter");
      const env = unwrap(envInstances[0], "environment");

      expect(adapter.setupCalls[0]).toMatchObject({
        config: {},
        secrets: {},
      });
      expect(env.setupCalls[0]).toMatchObject({
        config: {},
        secrets: {},
        bindings: expect.any(Object),
      });
    });

    it("passes schema-defaulted config to adapter setup", async () => {
      const service = new ModuleService(makeBindings(), makeLifecycle());
      await service.initialize(MISSING_PATH);

      const adapter = unwrap(adapterInstances[0], "adapter");
      expect(adapter.setupCalls[0]).toMatchObject({
        config: { timeout: 30 },
      });
    });

    it("exposes config and secrets schemas from manifests", async () => {
      const service = new ModuleService(makeBindings(), makeLifecycle());
      await service.initialize(MISSING_PATH);

      expect(service.getConfigSchema("openapi")).toMatchObject({
        type: "object",
        properties: { baseUrl: { type: "string" } },
      });
      expect(service.getSecretsSchema("openapi")).toMatchObject({
        type: "object",
        properties: { apiKey: { type: "string" } },
      });
    });

    it("throws 404 for schemas of unknown modules", async () => {
      const service = new ModuleService(makeBindings(), makeLifecycle());
      await service.initialize(MISSING_PATH);

      expect(() => service.getConfigSchema("ghost")).toThrow(HttpError);
      expect(() => service.getSecretsSchema("ghost")).toThrow(HttpError);
    });

    it("getConfig returns empty by default", async () => {
      const service = new ModuleService(makeBindings(), makeLifecycle());
      await service.initialize(MISSING_PATH);

      expect(await service.getConfig("openapi")).toEqual({});
    });

    it("patchConfig persists JSON Patch results", async () => {
      const service = new ModuleService(makeBindings(), makeLifecycle());
      await service.initialize(MISSING_PATH);

      await service.patchConfig({
        id: "openapi",
        patch: [{ op: "add", path: "/baseUrl", value: "https://api.example" }],
      });

      expect(await service.getConfig("openapi")).toEqual({
        baseUrl: "https://api.example",
        timeout: 30,
      });
    });

    it("patchConfig rejects values that violate the schema", async () => {
      const service = new ModuleService(makeBindings(), makeLifecycle());
      await service.initialize(MISSING_PATH);

      await expect(
        service.patchConfig({
          id: "openapi",
          patch: [{ op: "add", path: "/unknown", value: "x" }],
        }),
      ).rejects.toBeInstanceOf(HttpError);
    });

    it("patchConfig rejects non-object resulting payloads", async () => {
      const service = new ModuleService(makeBindings(), makeLifecycle());
      await service.initialize(MISSING_PATH);

      await expect(
        service.patchConfig({
          id: "openapi",
          patch: [{ op: "replace", path: "", value: [1, 2, 3] }],
        }),
      ).rejects.toBeInstanceOf(HttpError);
    });

    it("patchConfig persists root null for null-only config schemas", async () => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cyrnel-mod-"));
      try {
        const moduleDir = path.join(dir, "nullConfig");
        await fs.mkdir(moduleDir);
        await fs.writeFile(
          path.join(moduleDir, "module.json"),
          JSON.stringify({
            id: "nullConfig",
            name: "Null Config Module",
            description: "null config",
            type: "adapter",
            version: "1.0.0",
            main: "index.mjs",
          }),
        );
        await fs.writeFile(
          path.join(moduleDir, "index.mjs"),
          `export default {
            configSchema: { type: "null" },
            secretsSchema: { type: "null" },
            instantiate() {
              return {
                async setup() {},
                async teardown() {},
                async generateDefinition() { return { name: "x", description: "", configSchema: {}, secretsSchema: {}, tools: [], adapterDomain: {} }; },
                async hydrateService() {},
                async dehydrateService() {},
                async invoke() { return null; },
              };
            },
          }`,
        );

        const service = new ModuleService(makeBindings(), makeLifecycle());
        await service.initialize(dir);

        await expect(
          service.patchConfig({
            id: "nullConfig",
            patch: [{ op: "replace", path: "", value: null }],
          }),
        ).resolves.toEqual({ config: null, outdated: [] });

        const stored = await db.run(
          sql`SELECT payload FROM module_configurations WHERE module_id = 'nullConfig'`,
        );
        expect(stored.rows?.[0]?.[0]).toBe("null");
      } finally {
        await fs.rm(dir, { recursive: true, force: true });
      }
    });

    it("patchConfig reloads an active adapter (teardown + new setup with new context)", async () => {
      const state: ServiceState = {
        id: "alpha",
        adapterDomain: {},
        tools: {},
        config: {},
        secrets: {},
      };
      let service!: InstanceType<typeof ModuleService>;
      const lifecycle = {
        hydrateAdapter: vi.fn(async (id: string) => {
          await service.hydrateService(id, state);
        }),
      };
      service = new ModuleService(makeBindings(), lifecycle);
      await service.initialize(MISSING_PATH);

      const firstAdapter = unwrap(adapterInstances[0], "adapter");
      await service.patchConfig({
        id: "openapi",
        patch: [{ op: "add", path: "/baseUrl", value: "https://x" }],
      });

      expect(firstAdapter.teardownCalls.length).toBeGreaterThan(0);
      expect(firstAdapter.hydrateCalls).toHaveLength(1);
      expect(adapterInstances).toHaveLength(2);
      const secondAdapter = unwrap(
        adapterInstances[1],
        "adapter (post-reload)",
      );
      expect(secondAdapter.setupCalls[0]).toMatchObject({
        config: { baseUrl: "https://x", timeout: 30 },
        secrets: {},
      });
      expect(secondAdapter.hydrateCalls).toContainEqual(state);
    });

    it("patchConfig keeps the old adapter active when replacement setup fails", async () => {
      const service = new ModuleService(makeBindings(), makeLifecycle());
      await service.initialize(MISSING_PATH);

      const firstAdapter = unwrap(adapterInstances[0], "adapter");
      const originalSetupImpl = FakeAdapter.setupImpl;
      FakeAdapter.setupImpl = async () => {
        throw new Error("replacement setup failed");
      };

      try {
        await expect(
          service.patchConfig({
            id: "openapi",
            patch: [{ op: "add", path: "/baseUrl", value: "https://x" }],
          }),
        ).rejects.toThrow("replacement setup failed");
      } finally {
        FakeAdapter.setupImpl = originalSetupImpl;
      }

      expect(firstAdapter.teardownCalls).toHaveLength(0);
      await expect(
        service.generateDefinition({
          adapter: "openapi",
          definition: "{}",
        }),
      ).resolves.toMatchObject({ name: "fake" });
    });

    it("patchConfig does NOT reload when adapter is disabled", async () => {
      const service = new ModuleService(makeBindings(), makeLifecycle());
      await db.run(
        sql`INSERT INTO modules (id, name, type, description, enabled, missing)
            VALUES ('openapi', 'openapi', 'adapter', '', 0, 0),
                   ('typescript-ivm', 'typescript-ivm', 'environment', '', 0, 0)`,
      );
      await service.initialize(MISSING_PATH);

      expect(adapterInstances).toHaveLength(0);

      await service.patchConfig({
        id: "openapi",
        patch: [{ op: "add", path: "/baseUrl", value: "https://x" }],
      });

      expect(adapterInstances).toHaveLength(0);
      expect(await service.getConfig("openapi")).toEqual({
        baseUrl: "https://x",
        timeout: 30,
      });
    });

    it("patchConfig reloads the active environment swap-style", async () => {
      const service = new ModuleService(makeBindings(), makeLifecycle());
      await service.initialize(MISSING_PATH);

      const firstEnv = unwrap(envInstances[0], "environment");

      await service.patchConfig({
        id: "typescript-ivm",
        patch: [{ op: "add", path: "/poolSize", value: 4 }],
      });

      expect(envInstances).toHaveLength(2);
      const secondEnv = unwrap(envInstances[1], "environment (post-reload)");
      expect(secondEnv.setupCalls[0]).toMatchObject({
        config: { poolSize: 4 },
        secrets: {},
      });

      await new Promise((resolve) => setImmediate(resolve));
      expect(firstEnv.teardownCalls.length).toBeGreaterThan(0);
    });

    it("patchSecrets persists encrypted secrets and reloads", async () => {
      const service = new ModuleService(makeBindings(), makeLifecycle());
      await service.initialize(MISSING_PATH);

      await service.patchSecrets({
        id: "openapi",
        patch: [{ op: "add", path: "/apiKey", value: "sekret" }],
      });

      const stored = await db.run(
        sql`SELECT payload FROM module_secrets WHERE module_id = 'openapi'`,
      );
      const payload = String(stored.rows?.[0]?.[0] ?? "");
      expect(payload).not.toContain("sekret");

      const reloaded = unwrap(
        adapterInstances[1],
        "adapter (post-secrets-reload)",
      );
      expect(reloaded.setupCalls[0]).toMatchObject({
        secrets: { apiKey: "sekret" },
      });
    });

    it("patchSecrets rejects payloads that violate the schema", async () => {
      const service = new ModuleService(makeBindings(), makeLifecycle());
      await service.initialize(MISSING_PATH);

      await expect(
        service.patchSecrets({
          id: "openapi",
          patch: [{ op: "add", path: "/ghost", value: "x" }],
        }),
      ).rejects.toBeInstanceOf(HttpError);
    });

    it("setEnabled tolerates schema-outdated keys in stored config", async () => {
      const service = new ModuleService(makeBindings(), makeLifecycle());
      await db.run(
        sql`INSERT INTO modules (id, name, type, description, enabled, missing)
            VALUES ('openapi', 'openapi', 'adapter', '', 0, 0)`,
      );
      await service.initialize(MISSING_PATH);

      // stored under a looser schema: 'unknown' is now schema-disallowed
      await db.run(
        sql`INSERT INTO module_configurations (module_id, payload, updated_at)
            VALUES ('openapi', '{"unknown":1}', 0)`,
      );

      await expect(
        service.setEnabled({ id: "openapi", enabled: true }),
      ).resolves.toBeUndefined();

      const adapter = unwrap(adapterInstances[0], "adapter");
      expect(adapter.setupCalls[0]).toMatchObject({ config: { timeout: 30 } });
    });

    it("config/secrets survive reload() and are still applied on next enable", async () => {
      const service = new ModuleService(makeBindings(), makeLifecycle());
      await service.initialize(MISSING_PATH);

      await service.patchConfig({
        id: "openapi",
        patch: [{ op: "add", path: "/baseUrl", value: "https://kept" }],
      });

      await service.setEnabled({ id: "openapi", enabled: false });
      adapterInstances.length = 0;
      await service.setEnabled({ id: "openapi", enabled: true });

      const adapter = unwrap(adapterInstances[0], "adapter");
      expect(adapter.setupCalls[0]).toMatchObject({
        config: { baseUrl: "https://kept" },
      });
    });

    it("getSecretsPresence returns empty array when no secrets stored", async () => {
      const service = new ModuleService(makeBindings(), makeLifecycle());
      await service.initialize(MISSING_PATH);

      const result = await service.getSecretsPresence("openapi");
      expect(result).toEqual({ present: [], outdated: [] });
    });

    it("getSecretsPresence returns paths after secrets are set", async () => {
      const service = new ModuleService(makeBindings(), makeLifecycle());
      await service.initialize(MISSING_PATH);

      await service.patchSecrets({
        id: "openapi",
        patch: [{ op: "add", path: "/apiKey", value: "sekret" }],
      });

      const result = await service.getSecretsPresence("openapi");
      expect(result).toEqual({ present: ["/apiKey"], outdated: [] });
    });

    it("getConfigView filters outdated keys and reports them", async () => {
      const service = new ModuleService(makeBindings(), makeLifecycle());
      await service.initialize(MISSING_PATH);

      await db.run(
        sql`INSERT INTO module_configurations (module_id, payload, updated_at)
            VALUES ('openapi', '{"stale":1}', 0)`,
      );

      const view = await service.getConfigView("openapi");
      expect(view).toEqual({ config: {}, outdated: ["/stale"] });
    });

    it("patchConfig tolerates pre-existing outdated keys and preserves them", async () => {
      const service = new ModuleService(makeBindings(), makeLifecycle());
      await service.initialize(MISSING_PATH);

      await db.run(
        sql`INSERT INTO module_configurations (module_id, payload, updated_at)
            VALUES ('openapi', '{"stale":1}', 0)`,
      );

      const view = await service.patchConfig({
        id: "openapi",
        patch: [{ op: "add", path: "/baseUrl", value: "https://x" }],
      });

      expect(view).toEqual({
        config: { baseUrl: "https://x", timeout: 30 },
        outdated: ["/stale"],
      });
      expect(await service.getConfig("openapi")).toEqual({
        baseUrl: "https://x",
        timeout: 30,
        stale: 1,
      });
    });

    it("patchConfig rejects adding new schema-disallowed keys", async () => {
      const service = new ModuleService(makeBindings(), makeLifecycle());
      await service.initialize(MISSING_PATH);

      await expect(
        service.patchConfig({
          id: "openapi",
          patch: [{ op: "add", path: "/freshStale", value: 1 }],
        }),
      ).rejects.toBeInstanceOf(HttpError);
    });

    it("patchConfig treats removes of missing paths as no-ops", async () => {
      const service = new ModuleService(makeBindings(), makeLifecycle());
      await service.initialize(MISSING_PATH);

      await db.run(
        sql`INSERT INTO module_configurations (module_id, payload, updated_at)
            VALUES ('openapi', '{"baseUrl":"https://x","stale":1}', 0)`,
      );

      const view = await service.patchConfig({
        id: "openapi",
        patch: [
          { op: "remove", path: "/baseUrl" },
          { op: "remove", path: "/missing" },
        ],
      });

      expect(view).toEqual({ config: { timeout: 30 }, outdated: ["/stale"] });
      expect(await service.getConfig("openapi")).toEqual({
        timeout: 30,
        stale: 1,
      });
    });

    it("setEnabled delivers permissive secrets keys to module setup", async () => {
      const customSetupCalls: Record<string, unknown>[] = [];
      (globalThis as Record<string, unknown>).__cyrnelTestSetupCalls =
        customSetupCalls;
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cyrnel-mod-"));
      try {
        const moduleDir = path.join(dir, "permissiveSecrets");
        await fs.mkdir(moduleDir);
        await fs.writeFile(
          path.join(moduleDir, "module.json"),
          JSON.stringify({
            id: "permissiveSecrets",
            name: "Permissive Secrets Module",
            description: "permissive secrets",
            type: "adapter",
            version: "1.0.0",
            main: "index.mjs",
          }),
        );
        await fs.writeFile(
          path.join(moduleDir, "index.mjs"),
          `export default {
            configSchema: { type: "object", additionalProperties: true },
            secretsSchema: { type: "object", additionalProperties: true },
            instantiate() {
              return {
                async setup(ctx) { globalThis.__cyrnelTestSetupCalls.push(ctx); },
                async teardown() {},
                async generateDefinition() { return { name: "x", description: "", configSchema: {}, secretsSchema: {}, tools: [], adapterDomain: {} }; },
                async hydrateService() {},
                async dehydrateService() {},
                async invoke() { return null; },
              };
            },
          }`,
        );

        const service = new ModuleService(makeBindings(), makeLifecycle());
        await service.initialize(dir);
        await service.setEnabled({ id: "permissiveSecrets", enabled: false });
        customSetupCalls.length = 0;

        await service.patchSecrets({
          id: "permissiveSecrets",
          patch: [{ op: "add", path: "/anyKey", value: "x" }],
        });
        await service.setEnabled({ id: "permissiveSecrets", enabled: true });

        expect(customSetupCalls[0]).toMatchObject({
          secrets: { anyKey: "x" },
        });
      } finally {
        await fs.rm(dir, { recursive: true, force: true });
      }
    });
  });

  describe("installModule()", () => {
    it("installs a module from a valid archive and returns its manifest", async () => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cyrnel-install-"));
      try {
        const tarData = await createTestTar(dir, {
          "module.json": JSON.stringify({
            id: "installedMod",
            version: "1.0.0",
            name: "Installed Module",
            description: "test module",
            type: "adapter",
            main: "index.mjs",
          }),
          "index.mjs": `export default {
            configSchema: { type: "object", properties: {}, additionalProperties: false },
            secretsSchema: { type: "null" },
            instantiate() {
              return {
                async setup() {},
                async teardown() {},
                async generateDefinition() { return { name: "x", description: "", configSchema: {}, secretsSchema: {}, tools: [], adapterDomain: {} }; },
                async hydrateService() {},
                async dehydrateService() {},
                async invoke() { return null; },
              };
            },
          }`,
        });

        const tarUint8 = new Uint8Array(tarData);
        downloadBinaryMock.mockResolvedValue(Buffer.from("mocked"));
        decompressMock.mockReturnValue(tarUint8);

        const service = new ModuleService(makeBindings(), makeLifecycle());
        await service.initialize(dir);

        const manifest = await service.installModuleDirect(
          "https://example.com/mod.tar.zst",
        );

        expect(manifest.id).toBe("installedMod");
        expect(manifest.name).toBe("Installed Module");
        expect(manifest.type).toBe("adapter");
        expect(manifest.enabled).toBe(false);
        expect(manifest.missing).toBe(false);
        expect(manifest.isBuiltin).toBe(false);

        const record = unwrap(
          await service.get("installedMod"),
          "module 'installedMod'",
        );
        expect(record.enabled).toBe(false);
        expect(record.missing).toBe(false);
        expect(record.isBuiltin).toBe(false);

        const modDir = path.join(dir, "installedMod");
        await expect(
          fs.access(path.join(modDir, "module.json")),
        ).resolves.toBeUndefined();
        await expect(
          fs.access(path.join(modDir, "index.mjs")),
        ).resolves.toBeUndefined();
      } finally {
        await fs.rm(dir, { recursive: true, force: true });
      }
    });

    it("rejects a duplicate module id", async () => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cyrnel-install-"));
      try {
        const tarData = await createTestTar(dir, {
          "module.json": JSON.stringify({
            id: "dupeMod",
            version: "1.0.0",
            name: "Dupe Module",
            description: "duplicate",
            type: "adapter",
            main: "index.mjs",
          }),
          "index.mjs": `export default {
            configSchema: { type: "object", properties: {}, additionalProperties: false },
            secretsSchema: { type: "null" },
            instantiate() {
              return {
                async setup() {},
                async teardown() {},
                async generateDefinition() { return { name: "x", description: "", configSchema: {}, secretsSchema: {}, tools: [], adapterDomain: {} }; },
                async hydrateService() {},
                async dehydrateService() {},
                async invoke() { return null; },
              };
},
          }`,
        });

        const tarUint8 = new Uint8Array(tarData);
        downloadBinaryMock.mockResolvedValue(Buffer.from("mocked"));
        decompressMock.mockReturnValue(tarUint8);

        const service = new ModuleService(makeBindings(), makeLifecycle());
        await service.initialize(dir);

        await service.installModuleDirect("https://example.com/first.tar.zst");

        downloadBinaryMock.mockResolvedValue(Buffer.from("mocked"));
        decompressMock.mockReturnValue(tarUint8);

        await expect(
          service.installModuleDirect("https://example.com/dupe.tar.zst"),
        ).rejects.toMatchObject({
          statusCode: 409,
          message: "Module 'dupeMod' is already registered.",
        });
      } finally {
        await fs.rm(dir, { recursive: true, force: true });
      }
    });

    it("rejects an archive missing module.json", async () => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cyrnel-install-"));
      try {
        const tarData = await createTestTar(dir, {
          "index.mjs": `export default { configSchema: {}, secretsSchema: {}, instantiate() { return {}; } }`,
        });

        const tarUint8 = new Uint8Array(tarData);
        downloadBinaryMock.mockResolvedValue(Buffer.from("mocked"));
        decompressMock.mockReturnValue(tarUint8);

        const service = new ModuleService(makeBindings(), makeLifecycle());
        await service.initialize(dir);

        await expect(
          service.installModuleDirect("https://example.com/bad.tar.zst"),
        ).rejects.toMatchObject({
          statusCode: 400,
          message: "Archive must contain a 'module.json' at its root.",
        });
      } finally {
        await fs.rm(dir, { recursive: true, force: true });
      }
    });

    it("rejects an archive with invalid module.json content", async () => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cyrnel-install-"));
      try {
        const tarData = await createTestTar(dir, {
          "module.json": `{ this is not json }`,
        });

        const tarUint8 = new Uint8Array(tarData);
        downloadBinaryMock.mockResolvedValue(Buffer.from("mocked"));
        decompressMock.mockReturnValue(tarUint8);

        const service = new ModuleService(makeBindings(), makeLifecycle());
        await service.initialize(dir);

        await expect(
          service.installModuleDirect("https://example.com/bad.tar.zst"),
        ).rejects.toMatchObject({
          statusCode: 400,
          message: "module.json contains invalid JSON.",
        });
      } finally {
        await fs.rm(dir, { recursive: true, force: true });
      }
    });

    it("rejects an archive whose main points outside the archive", async () => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cyrnel-install-"));
      try {
        const tarData = await createTestTar(dir, {
          "module.json": JSON.stringify({
            id: "escapeMod",
            version: "1.0.0",
            name: "Escape",
            description: "escapes",
            type: "adapter",
            main: "../../../../etc/passwd",
          }),
        });

        const tarUint8 = new Uint8Array(tarData);
        downloadBinaryMock.mockResolvedValue(Buffer.from("mocked"));
        decompressMock.mockReturnValue(tarUint8);

        const service = new ModuleService(makeBindings(), makeLifecycle());
        await service.initialize(dir);

        await expect(
          service.installModuleDirect("https://example.com/escape.tar.zst"),
        ).rejects.toMatchObject({
          statusCode: 400,
          message: "Manifest 'main' must point to a file inside the archive.",
        });
      } finally {
        await fs.rm(dir, { recursive: true, force: true });
      }
    });
  });

  describe("deleteModule()", () => {
    it("deletes a module and its filesystem directory", async () => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cyrnel-del-"));
      try {
        const modDir = path.join(dir, "toBeDeleted");
        await fs.mkdir(modDir);
        await fs.writeFile(
          path.join(modDir, "module.json"),
          JSON.stringify({
            id: "toBeDeleted",
            version: "1.0.0",
            name: "Delete Me",
            description: "will be deleted",
            type: "adapter",
            main: "index.mjs",
          }),
        );
        await fs.writeFile(
          path.join(modDir, "index.mjs"),
          `export default {
            configSchema: { type: "object", properties: {}, additionalProperties: false },
            secretsSchema: { type: "null" },
            instantiate() {
              return {
                async setup() {},
                async teardown() {},
                async generateDefinition() { return { name: "x", description: "", configSchema: {}, secretsSchema: {}, tools: [], adapterDomain: {} }; },
                async hydrateService() {},
                async dehydrateService() {},
                async invoke() { return null; },
              };
            },
          }`,
        );

        const service = new ModuleService(makeBindings(), makeLifecycle());
        await service.initialize(dir);

        const record = unwrap(
          await service.get("toBeDeleted"),
          "module 'toBeDeleted'",
        );
        expect(record).toBeDefined();

        await service.deleteModule("toBeDeleted");

        const after = await service.get("toBeDeleted");
        expect(after).toBeUndefined();

        await expect(
          fs.access(path.join(modDir, "module.json")),
        ).rejects.toThrow();
      } finally {
        await fs.rm(dir, { recursive: true, force: true });
      }
    });

    it("deletes all services belonging to the module", async () => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cyrnel-del-"));
      try {
        const modDir = path.join(dir, "adapterMod");
        await fs.mkdir(modDir);
        await fs.writeFile(
          path.join(modDir, "module.json"),
          JSON.stringify({
            id: "adapterMod",
            version: "1.0.0",
            name: "Adapter",
            description: "adapter",
            type: "adapter",
            main: "index.mjs",
          }),
        );
        await fs.writeFile(
          path.join(modDir, "index.mjs"),
          `export default {
            configSchema: { type: "object", properties: {}, additionalProperties: false },
            secretsSchema: { type: "null" },
            instantiate() {
              return {
                async setup() {},
                async teardown() {},
                async generateDefinition() { return { name: "x", description: "", configSchema: {}, secretsSchema: {}, tools: [], adapterDomain: {} }; },
                async hydrateService() {},
                async dehydrateService() {},
                async invoke() { return null; },
              };
            },
          }`,
        );

        const service = new ModuleService(makeBindings(), makeLifecycle());
        await service.initialize(dir);

        await db.run(
          sql`INSERT INTO services (id, name, description, hash, source, adapter, enabled, config_schema, secrets_schema, adapter_domain)
              VALUES ('svc1', 'svc1', '', 'h', '', 'adapterMod', 1, '{}', '{}', '{}')`,
        );
        await db.run(
          sql`INSERT INTO tools (service_id, id, name, description, enabled, input_schema, output_schema, adapter_domain)
              VALUES ('svc1', 't1', 't1', '', 1, '{}', '{}', '{}')`,
        );

        await service.deleteModule("adapterMod");

        const services = await db
          .select({ id: (await import("@/db/schema")).services.id })
          .from((await import("@/db/schema")).services)
          .where(
            eq((await import("@/db/schema")).services.adapter, "adapterMod"),
          );
        expect(services).toHaveLength(0);

        const module = await service.get("adapterMod");
        expect(module).toBeUndefined();
      } finally {
        await fs.rm(dir, { recursive: true, force: true });
      }
    });

    it("throws 404 for a non-existent module", async () => {
      const service = new ModuleService(makeBindings(), makeLifecycle());
      await service.initialize(MISSING_PATH);

      await expect(service.deleteModule("nonExistent")).rejects.toMatchObject({
        statusCode: 404,
        message: "Module 'nonExistent' not found.",
      });
    });
  });

  describe("installModule hash/source", () => {
    it("stores hash and source in the database but omits them from the return value", async () => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cyrnel-hash-"));
      try {
        const tarData = await createTestTar(dir, {
          "module.json": JSON.stringify({
            id: "hashTestMod",
            version: "1.0.0",
            name: "Hash Test",
            description: "testing",
            type: "adapter",
            main: "index.mjs",
          }),
          "index.mjs": `export default {
            configSchema: { type: "object", properties: {}, additionalProperties: false },
            secretsSchema: { type: "null" },
            instantiate() {
              return {
                async setup() {},
                async teardown() {},
                async generateDefinition() { return { name: "x", description: "", configSchema: {}, secretsSchema: {}, tools: [], adapterDomain: {} }; },
                async hydrateService() {},
                async dehydrateService() {},
                async invoke() { return null; },
              };
            },
          }`,
        });

        const tarUint8 = new Uint8Array(tarData);
        const downloadPayload = Buffer.from("test-download-bytes");
        downloadBinaryMock.mockResolvedValue(downloadPayload);
        decompressMock.mockReturnValue(tarUint8);

        const service = new ModuleService(makeBindings(), makeLifecycle());
        await service.initialize(dir);

        const result = await service.installModuleDirect(
          "https://example.com/hash-test.tar.zst",
        );

        expect(result.hash).toBeDefined();
        expect(result.source).toBe("");

        const [row] = await db
          .select({
            hash: (await import("@/db/schema")).modules.hash,
            source: (await import("@/db/schema")).modules.source,
          })
          .from((await import("@/db/schema")).modules)
          .where(eq((await import("@/db/schema")).modules.id, "hashTestMod"))
          .limit(1);
        expect(row).toBeDefined();
        expect(row?.source).toBe("");

        const { computeBinaryHash } = await import("@/utils/hash.util");
        expect(row?.hash).toBe(computeBinaryHash(downloadPayload));
      } finally {
        await fs.rm(dir, { recursive: true, force: true });
      }
    });
  });

  describe("installModuleFromRegistry() (icon)", () => {
    const ICON_URL = "https://icons.example.com/m.png";
    const PNG_ICON = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.alloc(16),
    ]);

    function stubRegistryWithIcon(icon?: { url: string; hash: string }) {
      const registryResponse = {
        latestVersion: "1.0.0",
        versions: {
          "1.0.0": {
            downloadUrl: "https://example.com/download/mod.tar.zst",
            ...(icon ? { icon } : {}),
          },
        },
      };
      vi.stubGlobal(
        "fetch",
        vi.fn(
          async () =>
            new Response(JSON.stringify(registryResponse), {
              status: 200,
              headers: { "content-type": "application/json" },
            }),
        ),
      );
    }

    function mockDownloads(png: Buffer) {
      downloadBinaryMock.mockImplementation((url: string) =>
        Promise.resolve(url === ICON_URL ? png : Buffer.from("mocked")),
      );
    }

    it("stores the registry icon on install", async () => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cyrnel-icn-"));
      try {
        const tarData = await createTestTar(dir, {
          "module.json": JSON.stringify({
            id: "iconMod",
            version: "1.0.0",
            name: "Icon Module",
            description: "icon",
            type: "adapter",
            main: "index.mjs",
          }),
          "index.mjs": `export default {
            configSchema: { type: "object", properties: {}, additionalProperties: false },
            secretsSchema: { type: "null" },
            instantiate() {
              return {
                async setup() {},
                async teardown() {},
                async generateDefinition() { return { name: "x", description: "", configSchema: {}, secretsSchema: {}, tools: [], adapterDomain: {} }; },
                async hydrateService() {},
                async dehydrateService() {},
                async invoke() { return null; },
              };
            },
          }`,
        });

        const { computeBinaryHash } = await import("@/utils/hash.util");
        const iconHash = computeBinaryHash(PNG_ICON);
        const tarUint8 = new Uint8Array(tarData);
        mockDownloads(PNG_ICON);
        decompressMock.mockReturnValue(tarUint8);
        stubRegistryWithIcon({ url: ICON_URL, hash: iconHash });

        const service = new ModuleService(makeBindings(), makeLifecycle());
        await service.initialize(dir);

        const result = await service.installModuleFromRegistry(
          "https://registry.example.com/icon",
        );
        expect(result.hasIcon).toBe(true);

        const icon = await service.getIcon("iconMod");
        expect(icon).not.toBeNull();
        expect(icon?.data.equals(PNG_ICON)).toBe(true);
        expect(icon?.mime).toBe("image/png");
        expect(icon?.hash).toBe(iconHash);
      } finally {
        await fs.rm(dir, { recursive: true, force: true });
      }
    });

    it("installs without an icon when the icon hash does not match", async () => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cyrnel-icn-"));
      try {
        const tarData = await createTestTar(dir, {
          "module.json": JSON.stringify({
            id: "iconBadMod",
            version: "1.0.0",
            name: "Bad Icon",
            description: "bad icon",
            type: "adapter",
            main: "index.mjs",
          }),
          "index.mjs": `export default {
            configSchema: { type: "object", properties: {}, additionalProperties: false },
            secretsSchema: { type: "null" },
            instantiate() {
              return {
                async setup() {},
                async teardown() {},
                async generateDefinition() { return { name: "x", description: "", configSchema: {}, secretsSchema: {}, tools: [], adapterDomain: {} }; },
                async hydrateService() {},
                async dehydrateService() {},
                async invoke() { return null; },
              };
            },
          }`,
        });

        const tarUint8 = new Uint8Array(tarData);
        mockDownloads(PNG_ICON);
        decompressMock.mockReturnValue(tarUint8);
        stubRegistryWithIcon({ url: ICON_URL, hash: "wrong-hash" });

        const service = new ModuleService(makeBindings(), makeLifecycle());
        await service.initialize(dir);

        const result = await service.installModuleFromRegistry(
          "https://registry.example.com/badicon",
        );
        expect(result.hasIcon).toBe(false);
        expect(await service.getIcon("iconBadMod")).toBeNull();
      } finally {
        await fs.rm(dir, { recursive: true, force: true });
      }
    });

    it("installs without an icon when the icon download fails", async () => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cyrnel-icn-"));
      try {
        const tarData = await createTestTar(dir, {
          "module.json": JSON.stringify({
            id: "iconNetMod",
            version: "1.0.0",
            name: "Net Fail",
            description: "net fail",
            type: "adapter",
            main: "index.mjs",
          }),
          "index.mjs": `export default {
            configSchema: { type: "object", properties: {}, additionalProperties: false },
            secretsSchema: { type: "null" },
            instantiate() {
              return {
                async setup() {},
                async teardown() {},
                async generateDefinition() { return { name: "x", description: "", configSchema: {}, secretsSchema: {}, tools: [], adapterDomain: {} }; },
                async hydrateService() {},
                async dehydrateService() {},
                async invoke() { return null; },
              };
            },
          }`,
        });

        const { computeBinaryHash } = await import("@/utils/hash.util");
        const iconHash = computeBinaryHash(PNG_ICON);
        const tarUint8 = new Uint8Array(tarData);
        downloadBinaryMock.mockImplementation((url: string) => {
          if (url === ICON_URL) return Promise.reject(new Error("down"));
          return Promise.resolve(Buffer.from("mocked"));
        });
        decompressMock.mockReturnValue(tarUint8);
        stubRegistryWithIcon({ url: ICON_URL, hash: iconHash });

        const service = new ModuleService(makeBindings(), makeLifecycle());
        await service.initialize(dir);

        const result = await service.installModuleFromRegistry(
          "https://registry.example.com/netfail",
        );
        expect(result.hasIcon).toBe(false);
        expect(await service.getIcon("iconNetMod")).toBeNull();
      } finally {
        await fs.rm(dir, { recursive: true, force: true });
      }
    });

    it("reports no icon for direct installs", async () => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cyrnel-icn-"));
      try {
        const tarData = await createTestTar(dir, {
          "module.json": JSON.stringify({
            id: "directIconMod",
            version: "1.0.0",
            name: "Direct",
            description: "direct",
            type: "adapter",
            main: "index.mjs",
          }),
          "index.mjs": `export default {
            configSchema: { type: "object", properties: {}, additionalProperties: false },
            secretsSchema: { type: "null" },
            instantiate() {
              return {
                async setup() {},
                async teardown() {},
                async generateDefinition() { return { name: "x", description: "", configSchema: {}, secretsSchema: {}, tools: [], adapterDomain: {} }; },
                async hydrateService() {},
                async dehydrateService() {},
                async invoke() { return null; },
              };
            },
          }`,
        });

        const tarUint8 = new Uint8Array(tarData);
        downloadBinaryMock.mockResolvedValue(Buffer.from("mocked"));
        decompressMock.mockReturnValue(tarUint8);

        const service = new ModuleService(makeBindings(), makeLifecycle());
        await service.initialize(dir);

        const result = await service.installModuleDirect(
          "https://example.com/direct.tar.zst",
        );
        expect(result.hasIcon).toBe(false);
        expect(await service.getIcon("directIconMod")).toBeNull();
      } finally {
        await fs.rm(dir, { recursive: true, force: true });
      }
    });
  });

  describe("updateModule()", () => {
    it("throws 404 when the module does not exist", async () => {
      const service = new ModuleService(makeBindings(), makeLifecycle());
      await service.initialize(MISSING_PATH);

      await expect(service.updateModule("nonExistent")).rejects.toMatchObject({
        statusCode: 404,
        message: "Module 'nonExistent' not found.",
      });
    });

    it("throws 409 when the module has no stored install source", async () => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cyrnel-upd-"));
      try {
        const modDir = path.join(dir, "noSourceMod");
        await fs.mkdir(modDir);
        await fs.writeFile(
          path.join(modDir, "module.json"),
          JSON.stringify({
            id: "noSourceMod",
            version: "1.0.0",
            name: "No Source",
            description: "no source",
            type: "adapter",
            main: "index.mjs",
          }),
        );
        await fs.writeFile(
          path.join(modDir, "index.mjs"),
          `export default {
            configSchema: { type: "object", properties: {}, additionalProperties: false },
            secretsSchema: { type: "null" },
            instantiate() {
              return {
                async setup() {},
                async teardown() {},
                async generateDefinition() { return { name: "x", description: "", configSchema: {}, secretsSchema: {}, tools: [], adapterDomain: {} }; },
                async hydrateService() {},
                async dehydrateService() {},
                async invoke() { return null; },
              };
            },
          }`,
        );

        const service = new ModuleService(makeBindings(), makeLifecycle());
        await service.initialize(dir);

        await expect(service.updateModule("noSourceMod")).rejects.toMatchObject(
          {
            statusCode: 409,
            message:
              "Module 'noSourceMod' has no stored install source and cannot be updated automatically. Only registry-installed modules can be updated.",
          },
        );
      } finally {
        await fs.rm(dir, { recursive: true, force: true });
      }
    });

    it("skips the update when the archive hash has not changed", async () => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cyrnel-upd-"));
      try {
        const tarData = await createTestTar(dir, {
          "module.json": JSON.stringify({
            id: "stableMod",
            version: "1.0.0",
            name: "Stable Module",
            description: "stable",
            type: "adapter",
            main: "index.mjs",
          }),
          "index.mjs": `export default {
            configSchema: { type: "object", properties: {}, additionalProperties: false },
            secretsSchema: { type: "null" },
            instantiate() {
              return {
                async setup() {},
                async teardown() {},
                async generateDefinition() { return { name: "x", description: "", configSchema: {}, secretsSchema: {}, tools: [], adapterDomain: {} }; },
                async hydrateService() {},
                async dehydrateService() {},
                async invoke() { return null; },
              };
            },
          }`,
        });

        const tarUint8 = new Uint8Array(tarData);
        const downloadPayload = Buffer.from("stable-download");
        downloadBinaryMock.mockResolvedValue(downloadPayload);
        decompressMock.mockReturnValue(tarUint8);

        const registryResponse = {
          latestVersion: "1.0.0",
          versions: {
            "1.0.0": {
              downloadUrl: "https://example.com/download/stable.tar.zst",
            },
          },
        };
        vi.stubGlobal(
          "fetch",
          vi.fn(
            async () =>
              new Response(JSON.stringify(registryResponse), {
                status: 200,
                headers: { "content-type": "application/json" },
              }),
          ),
        );

        const service = new ModuleService(makeBindings(), makeLifecycle());
        await service.initialize(dir);
        await service.installModuleFromRegistry(
          "https://registry.example.com/stable",
        );

        downloadBinaryMock.mockResolvedValue(downloadPayload);

        const result = await service.updateModule("stableMod");
        expect(result).toEqual({ updated: false });
      } finally {
        await fs.rm(dir, { recursive: true, force: true });
      }
    });

    it("re-installs when the archive hash has changed", async () => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cyrnel-upd-"));
      try {
        const tarData = await createTestTar(dir, {
          "module.json": JSON.stringify({
            id: "changedMod",
            version: "1.0.0",
            name: "Changed Module",
            description: "original",
            type: "adapter",
            main: "index.mjs",
          }),
          "index.mjs": `export default {
            configSchema: { type: "object", properties: {}, additionalProperties: false },
            secretsSchema: { type: "null" },
            instantiate() {
              return {
                async setup() {},
                async teardown() {},
                async generateDefinition() { return { name: "x", description: "", configSchema: {}, secretsSchema: {}, tools: [], adapterDomain: {} }; },
                async hydrateService() {},
                async dehydrateService() {},
                async invoke() { return null; },
              };
            },
          }`,
        });

        const tarUint8 = new Uint8Array(tarData);
        downloadBinaryMock.mockResolvedValue(Buffer.from("original-download"));
        decompressMock.mockReturnValue(tarUint8);

        const registryResponse = {
          latestVersion: "1.0.0",
          versions: {
            "1.0.0": {
              downloadUrl: "https://example.com/download/changed.tar.zst",
            },
          },
        };
        vi.stubGlobal(
          "fetch",
          vi.fn(
            async () =>
              new Response(JSON.stringify(registryResponse), {
                status: 200,
                headers: { "content-type": "application/json" },
              }),
          ),
        );

        const service = new ModuleService(makeBindings(), makeLifecycle());
        await service.initialize(dir);
        await service.installModuleFromRegistry(
          "https://registry.example.com/changed",
        );

        const newTarData = await createTestTar(dir, {
          "module.json": JSON.stringify({
            id: "changedMod",
            version: "1.0.0",
            name: "Changed Module Updated",
            description: "updated",
            type: "adapter",
            main: "index.mjs",
          }),
          "index.mjs": `export default {
            configSchema: { type: "object", properties: {}, additionalProperties: false },
            secretsSchema: { type: "null" },
            instantiate() {
              return {
                async setup() {},
                async teardown() {},
                async generateDefinition() { return { name: "x", description: "", configSchema: {}, secretsSchema: {}, tools: [], adapterDomain: {} }; },
                async hydrateService() {},
                async dehydrateService() {},
                async invoke() { return null; },
              };
            },
          }`,
        });

        const newTarUint8 = new Uint8Array(newTarData);
        downloadBinaryMock.mockResolvedValue(Buffer.from("updated-download"));
        decompressMock.mockReturnValue(newTarUint8);

        const result = await service.updateModule("changedMod");
        expect(result).toEqual({ updated: true });

        const record = unwrap(
          await service.get("changedMod"),
          "module 'changedMod'",
        );
        expect(record.description).toBe("updated");

        const [row] = await db
          .select({
            description: (await import("@/db/schema")).modules.description,
            hash: (await import("@/db/schema")).modules.hash,
          })
          .from((await import("@/db/schema")).modules)
          .where(eq((await import("@/db/schema")).modules.id, "changedMod"))
          .limit(1);
        expect(row).toBeDefined();
        expect(row?.description).toBe("updated");
        const { computeBinaryHash } = await import("@/utils/hash.util");
        expect(row?.hash).toBe(
          computeBinaryHash(Buffer.from("updated-download")),
        );
      } finally {
        await fs.rm(dir, { recursive: true, force: true });
      }
    });

    it("rejects update when downloaded manifest.id differs from requested id", async () => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cyrnel-upd-"));
      try {
        const tarData = await createTestTar(dir, {
          "module.json": JSON.stringify({
            id: "mismatchMod",
            version: "1.0.0",
            name: "Mismatch Module",
            description: "original",
            type: "adapter",
            main: "index.mjs",
          }),
          "index.mjs": `export default {
            configSchema: { type: "object", properties: {}, additionalProperties: false },
            secretsSchema: { type: "null" },
            instantiate() {
              return {
                async setup() {},
                async teardown() {},
                async generateDefinition() { return { name: "x", description: "", configSchema: {}, secretsSchema: {}, tools: [], adapterDomain: {} }; },
                async hydrateService() {},
                async dehydrateService() {},
                async invoke() { return null; },
              };
            },
          }`,
        });

        const tarUint8 = new Uint8Array(tarData);
        downloadBinaryMock.mockResolvedValue(Buffer.from("mismatch-download"));
        decompressMock.mockReturnValue(tarUint8);

        const registryResponse = {
          latestVersion: "1.0.0",
          versions: {
            "1.0.0": {
              downloadUrl: "https://example.com/download/mismatch.tar.zst",
            },
          },
        };
        vi.stubGlobal(
          "fetch",
          vi.fn(
            async () =>
              new Response(JSON.stringify(registryResponse), {
                status: 200,
                headers: { "content-type": "application/json" },
              }),
          ),
        );

        const service = new ModuleService(makeBindings(), makeLifecycle());
        await service.initialize(dir);
        await service.installModuleFromRegistry(
          "https://registry.example.com/mismatch",
        );

        const mismatchedTarData = await createTestTar(dir, {
          "module.json": JSON.stringify({
            id: "mismatchedId",
            version: "1.0.0",
            name: "Wrong Identity",
            description: "should not apply",
            type: "adapter",
            main: "index.mjs",
          }),
          "index.mjs": `export default { configSchema: {}, secretsSchema: {}, instantiate() { return {}; } }`,
        });

        const mismatchedTarUint8 = new Uint8Array(mismatchedTarData);
        downloadBinaryMock.mockResolvedValue(Buffer.from("wrong-identity"));
        decompressMock.mockReturnValue(mismatchedTarUint8);

        await expect(service.updateModule("mismatchMod")).rejects.toThrow(
          HttpError,
        );

        const record = unwrap(
          await service.get("mismatchMod"),
          "module 'mismatchMod'",
        );
        expect(record.description).toBe("original");

        const [row] = await db
          .select({
            description: (await import("@/db/schema")).modules.description,
            hash: (await import("@/db/schema")).modules.hash,
          })
          .from((await import("@/db/schema")).modules)
          .where(eq((await import("@/db/schema")).modules.id, "mismatchMod"))
          .limit(1);
        expect(row).toBeDefined();
        expect(row?.description).toBe("original");

        await expect(
          fs.access(path.join(dir, "mismatchedId")),
        ).rejects.toThrow();
      } finally {
        await fs.rm(dir, { recursive: true, force: true });
      }
    });

    it("updates the icon when the registry icon hash changes", async () => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cyrnel-upd-"));
      const ICON_URL = "https://icons.example.com/m.png";
      const PNG_ICON = Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        Buffer.alloc(16),
      ]);
      try {
        const tarData = await createTestTar(dir, {
          "module.json": JSON.stringify({
            id: "iconUpdateMod",
            version: "1.0.0",
            name: "Icon Update",
            description: "update",
            type: "adapter",
            main: "index.mjs",
          }),
          "index.mjs": `export default {
            configSchema: { type: "object", properties: {}, additionalProperties: false },
            secretsSchema: { type: "null" },
            instantiate() {
              return {
                async setup() {},
                async teardown() {},
                async generateDefinition() { return { name: "x", description: "", configSchema: {}, secretsSchema: {}, tools: [], adapterDomain: {} }; },
                async hydrateService() {},
                async dehydrateService() {},
                async invoke() { return null; },
              };
            },
          }`,
        });

        const { computeBinaryHash } = await import("@/utils/hash.util");
        const newHash = computeBinaryHash(PNG_ICON);
        const tarUint8 = new Uint8Array(tarData);
        downloadBinaryMock.mockResolvedValue(Buffer.from("mocked"));
        decompressMock.mockReturnValue(tarUint8);
        vi.stubGlobal(
          "fetch",
          vi.fn(
            async () =>
              new Response(
                JSON.stringify({
                  latestVersion: "1.0.0",
                  versions: {
                    "1.0.0": {
                      downloadUrl: "https://example.com/download/mod.tar.zst",
                    },
                  },
                }),
                {
                  status: 200,
                  headers: { "content-type": "application/json" },
                },
              ),
          ),
        );

        const service = new ModuleService(makeBindings(), makeLifecycle());
        await service.initialize(dir);
        await service.installModuleFromRegistry(
          "https://registry.example.com/iconupdate",
        );
        await db.run(
          sql`UPDATE modules SET icon_hash = 'old-hash' WHERE id = 'iconUpdateMod'`,
        );

        downloadBinaryMock.mockImplementation((url: string) =>
          Promise.resolve(url === ICON_URL ? PNG_ICON : Buffer.from("mocked")),
        );
        decompressMock.mockReturnValue(tarUint8);
        vi.stubGlobal(
          "fetch",
          vi.fn(
            async () =>
              new Response(
                JSON.stringify({
                  latestVersion: "1.0.0",
                  versions: {
                    "1.0.0": {
                      downloadUrl: "https://example.com/download/mod.tar.zst",
                      icon: { url: ICON_URL, hash: newHash },
                    },
                  },
                }),
                {
                  status: 200,
                  headers: { "content-type": "application/json" },
                },
              ),
          ),
        );

        const result = await service.updateModule("iconUpdateMod");
        expect(result).toEqual({ updated: false });

        const icon = await service.getIcon("iconUpdateMod");
        expect(icon).not.toBeNull();
        expect(icon?.data.equals(PNG_ICON)).toBe(true);
        expect(icon?.mime).toBe("image/png");
        expect(icon?.hash).toBe(newHash);
        expect(await service.get("iconUpdateMod")).toMatchObject({
          hasIcon: true,
        });
      } finally {
        await fs.rm(dir, { recursive: true, force: true });
      }
    });

    it("keeps the stored icon when the icon re-fetch fails", async () => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cyrnel-upd-"));
      const ICON_URL = "https://icons.example.com/m.png";
      const PNG_ICON = Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        Buffer.alloc(16),
      ]);
      try {
        const tarData = await createTestTar(dir, {
          "module.json": JSON.stringify({
            id: "iconKeepMod",
            version: "1.0.0",
            name: "Icon Keep",
            description: "keep",
            type: "adapter",
            main: "index.mjs",
          }),
          "index.mjs": `export default {
            configSchema: { type: "object", properties: {}, additionalProperties: false },
            secretsSchema: { type: "null" },
            instantiate() {
              return {
                async setup() {},
                async teardown() {},
                async generateDefinition() { return { name: "x", description: "", configSchema: {}, secretsSchema: {}, tools: [], adapterDomain: {} }; },
                async hydrateService() {},
                async dehydrateService() {},
                async invoke() { return null; },
              };
            },
          }`,
        });

        const { computeBinaryHash } = await import("@/utils/hash.util");
        const storedHash = computeBinaryHash(PNG_ICON);
        const tarUint8 = new Uint8Array(tarData);
        downloadBinaryMock.mockResolvedValue(Buffer.from("mocked"));
        decompressMock.mockReturnValue(tarUint8);
        vi.stubGlobal(
          "fetch",
          vi.fn(
            async () =>
              new Response(
                JSON.stringify({
                  latestVersion: "1.0.0",
                  versions: {
                    "1.0.0": {
                      downloadUrl: "https://example.com/download/mod.tar.zst",
                    },
                  },
                }),
                {
                  status: 200,
                  headers: { "content-type": "application/json" },
                },
              ),
          ),
        );

        const service = new ModuleService(makeBindings(), makeLifecycle());
        await service.initialize(dir);
        await service.installModuleFromRegistry(
          "https://registry.example.com/iconkeep",
        );
        await db.run(
          sql`UPDATE modules SET icon_hash = ${storedHash}, icon_data = ${PNG_ICON}, icon_mime = 'image/png' WHERE id = 'iconKeepMod'`,
        );

        downloadBinaryMock.mockImplementation((url: string) =>
          url === ICON_URL
            ? Promise.reject(new Error("icon network failure"))
            : Promise.resolve(Buffer.from("mocked")),
        );
        decompressMock.mockReturnValue(tarUint8);
        vi.stubGlobal(
          "fetch",
          vi.fn(
            async () =>
              new Response(
                JSON.stringify({
                  latestVersion: "1.0.0",
                  versions: {
                    "1.0.0": {
                      downloadUrl: "https://example.com/download/mod.tar.zst",
                      icon: { url: ICON_URL, hash: "new-hash" },
                    },
                  },
                }),
                {
                  status: 200,
                  headers: { "content-type": "application/json" },
                },
              ),
          ),
        );

        const result = await service.updateModule("iconKeepMod");
        expect(result).toEqual({ updated: false });

        const icon = await service.getIcon("iconKeepMod");
        expect(icon).not.toBeNull();
        expect(icon?.data.equals(PNG_ICON)).toBe(true);
        expect(icon?.mime).toBe("image/png");
        expect(icon?.hash).toBe(storedHash);
        expect(await service.get("iconKeepMod")).toMatchObject({
          hasIcon: true,
        });
      } finally {
        await fs.rm(dir, { recursive: true, force: true });
      }
    });

    it("clears the stored icon when the registry no longer declares one", async () => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cyrnel-upd-"));
      const PNG_ICON = Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        Buffer.alloc(16),
      ]);
      try {
        const tarData = await createTestTar(dir, {
          "module.json": JSON.stringify({
            id: "iconClearMod",
            version: "1.0.0",
            name: "Icon Clear",
            description: "clear",
            type: "adapter",
            main: "index.mjs",
          }),
          "index.mjs": `export default {
            configSchema: { type: "object", properties: {}, additionalProperties: false },
            secretsSchema: { type: "null" },
            instantiate() {
              return {
                async setup() {},
                async teardown() {},
                async generateDefinition() { return { name: "x", description: "", configSchema: {}, secretsSchema: {}, tools: [], adapterDomain: {} }; },
                async hydrateService() {},
                async dehydrateService() {},
                async invoke() { return null; },
              };
            },
          }`,
        });

        const { computeBinaryHash } = await import("@/utils/hash.util");
        const oldHash = computeBinaryHash(PNG_ICON);
        const tarUint8 = new Uint8Array(tarData);
        downloadBinaryMock.mockResolvedValue(Buffer.from("mocked"));
        decompressMock.mockReturnValue(tarUint8);
        vi.stubGlobal(
          "fetch",
          vi.fn(
            async () =>
              new Response(
                JSON.stringify({
                  latestVersion: "1.0.0",
                  versions: {
                    "1.0.0": {
                      downloadUrl: "https://example.com/download/mod.tar.zst",
                    },
                  },
                }),
                {
                  status: 200,
                  headers: { "content-type": "application/json" },
                },
              ),
          ),
        );

        const service = new ModuleService(makeBindings(), makeLifecycle());
        await service.initialize(dir);
        await service.installModuleFromRegistry(
          "https://registry.example.com/iconclear",
        );
        await db.run(
          sql`UPDATE modules SET icon_hash = ${oldHash}, icon_data = ${PNG_ICON}, icon_mime = 'image/png' WHERE id = 'iconClearMod'`,
        );

        downloadBinaryMock.mockResolvedValue(Buffer.from("mocked"));
        decompressMock.mockReturnValue(tarUint8);
        vi.stubGlobal(
          "fetch",
          vi.fn(
            async () =>
              new Response(
                JSON.stringify({
                  latestVersion: "1.0.0",
                  versions: {
                    "1.0.0": {
                      downloadUrl: "https://example.com/download/mod.tar.zst",
                    },
                  },
                }),
                {
                  status: 200,
                  headers: { "content-type": "application/json" },
                },
              ),
          ),
        );

        const result = await service.updateModule("iconClearMod");
        expect(result).toEqual({ updated: false });

        expect(await service.getIcon("iconClearMod")).toBeNull();
        expect(await service.get("iconClearMod")).toMatchObject({
          hasIcon: false,
        });
      } finally {
        await fs.rm(dir, { recursive: true, force: true });
      }
    });
  });
});
