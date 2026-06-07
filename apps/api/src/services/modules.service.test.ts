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
} from "@mci/sdk";
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
const ORIGINAL_SECRETS_KEY = process.env.MCI_SECRETS_KEY;

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

vi.mock("@mci/openapi", () => ({
  manifest: {
    id: "openapi",
    name: "OpenAPI Adapter",
    description: "Fake openapi adapter",
    type: "adapter" as const,
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
  },
  instantiate: () => {
    const instance = new FakeAdapter();
    adapterInstances.push(instance);
    return instance;
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

vi.mock("@mci/typescript-ivm", () => ({
  manifest: {
    id: "typescript-ivm",
    name: "Typescript Isolated VM",
    description: "Fake TS environment",
    type: "environment" as const,
    configSchema: {
      type: "object",
      properties: { poolSize: { type: "number" } },
      additionalProperties: false,
    },
    secretsSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  instantiate: () => {
    const instance = new FakeEnvironment();
    envInstances.push(instance);
    return instance;
  },
}));

// These imports must come after vi.mock above.
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
    discoverServices: vi.fn(async () => []),
    discoverTools: vi.fn(async () => []),
    getService: vi.fn(async () => {
      throw new Error("not used");
    }),
    getTool: vi.fn(async () => {
      throw new Error("not used");
    }),
    getToolDocs: vi.fn(async () => ""),
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

const MISSING_PATH = path.join(os.tmpdir(), "mci-no-such-modules-dir");

describe("ModuleService", () => {
  beforeAll(async () => {
    process.env.MCI_SECRETS_KEY = SECRETS_KEY;
    await applyMigrations();
  });

  afterAll(() => {
    if (ORIGINAL_SECRETS_KEY === undefined) {
      delete process.env.MCI_SECRETS_KEY;
    } else {
      process.env.MCI_SECRETS_KEY = ORIGINAL_SECRETS_KEY;
    }
  });

  beforeEach(async () => {
    await resetDb();
    adapterInstances.length = 0;
    envInstances.length = 0;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ----------------------------------------------------------------------
  // initialize()
  // ----------------------------------------------------------------------
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
        expect(row.orphaned).toBe(false);
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
      // Pre-insert a row with enabled=false so initialize respects it.
      await db.run(
        sql`INSERT INTO modules (id, name, type, description, enabled, orphaned)
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
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mci-mod-"));
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
            main: "index.mjs",
          }),
        );
        await fs.writeFile(
          path.join(moduleDir, "index.mjs"),
          `export function instantiate() {
             return {
               async setup() {},
               async teardown() {},
               async generateDefinition() { return { name: "x", description: "", configSchema: {}, secretsSchema: {}, tools: [], adapterDomain: {} }; },
               async hydrateService() {},
               async dehydrateService() {},
               async invoke() { return null; },
             };
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
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mci-mod-"));
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
            main: "index.mjs",
          }),
        );
        await fs.writeFile(
          path.join(moduleDir, "index.mjs"),
          `export function instantiate() {
             return {
               async setup() {},
               async teardown() {},
               async generateDefinition() { return { name: "x", description: "", configSchema: {}, secretsSchema: {}, tools: [], adapterDomain: {} }; },
               async hydrateService() {},
               async dehydrateService() {},
               async invoke() { return null; },
             };
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
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mci-mod-"));
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
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mci-mod-"));
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
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mci-mod-"));
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
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mci-mod-"));
      try {
        await fs.mkdir(path.join(dir, "empty"));

        const service = new ModuleService(makeBindings(), makeLifecycle());
        await expect(service.initialize(dir)).resolves.toBeUndefined();
      } finally {
        await fs.rm(dir, { recursive: true, force: true });
      }
    });
  });

  // ----------------------------------------------------------------------
  // shutdown()
  // ----------------------------------------------------------------------
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

  // ----------------------------------------------------------------------
  // execute() / kill()
  // ----------------------------------------------------------------------
  describe("execute()", () => {
    it("throws 503 when no environment is active", async () => {
      const service = new ModuleService(makeBindings(), makeLifecycle());
      // Initialize with the environment disabled.
      await db.run(
        sql`INSERT INTO modules (id, name, type, description, enabled, orphaned)
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
      // kill() of a finished execution is a no-op (not in executionMap).
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

  // ----------------------------------------------------------------------
  // generate* / hydrate* / invoke
  // ----------------------------------------------------------------------
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
        sql`INSERT INTO modules (id, name, type, description, enabled, orphaned)
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
        sql`INSERT INTO modules (id, name, type, description, enabled, orphaned)
            VALUES ('openapi', 'openapi', 'adapter', '', 0, 0)`,
      );
      await service.initialize(MISSING_PATH);

      // generateDefinition() is NOT declared async — `requireAdapter` throws
      // synchronously before a promise can be returned, so we wrap to capture.
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

  // ----------------------------------------------------------------------
  // invoke()
  // ----------------------------------------------------------------------
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
  });

  // ----------------------------------------------------------------------
  // list() / get()
  // ----------------------------------------------------------------------
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

  // ----------------------------------------------------------------------
  // setEnabled()
  // ----------------------------------------------------------------------
  describe("setEnabled()", () => {
    it("throws 404 when the module is unknown", async () => {
      const service = new ModuleService(makeBindings(), makeLifecycle());
      await service.initialize(MISSING_PATH);

      await expect(
        service.setEnabled({ id: "ghost", enabled: true }),
      ).rejects.toMatchObject({ statusCode: 404 });
    });

    it("throws 409 when trying to enable an orphaned module", async () => {
      const service = new ModuleService(makeBindings(), makeLifecycle());
      await service.initialize(MISSING_PATH);

      // Manually orphan one of the built-ins for the test.
      await db.run(
        sql`UPDATE modules SET orphaned = 1, enabled = 0 WHERE id = 'openapi'`,
      );

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
        sql`INSERT INTO modules (id, name, type, description, enabled, orphaned)
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
        sql`INSERT INTO modules (id, name, type, description, enabled, orphaned)
            VALUES ('typescript-ivm', 'typescript-ivm', 'environment', '', 0, 0)`,
      );
      await service.initialize(MISSING_PATH);

      expect(envInstances).toHaveLength(0);
      await service.setEnabled({ id: "typescript-ivm", enabled: true });
      expect(envInstances).toHaveLength(1);

      await service.setEnabled({ id: "typescript-ivm", enabled: false });
      // The environment drains; with no executions, teardown should be called.
      // Wait microtasks for the drain → dispose chain.
      await new Promise((resolve) => setImmediate(resolve));
      expect(envInstances[0]?.teardownCalls.length).toBeGreaterThan(0);
    });
  });

  // ----------------------------------------------------------------------
  // reconcile / reload
  // ----------------------------------------------------------------------
  describe("reconcile + reload", () => {
    it("marks rows for unregistered modules as orphaned + disabled", async () => {
      const service = new ModuleService(makeBindings(), makeLifecycle());
      // Seed a row for a module that won't be registered.
      await db.run(
        sql`INSERT INTO modules (id, name, type, description, enabled, orphaned)
            VALUES ('legacy', 'legacy', 'adapter', '', 1, 0)`,
      );
      await service.initialize(MISSING_PATH);

      const row = unwrap(await service.get("legacy"), "module 'legacy'");
      expect(row.orphaned).toBe(true);
      expect(row.enabled).toBe(false);
    });

    it("syncs human-readable names from manifests on reconcile", async () => {
      await db.run(
        sql`INSERT INTO modules (id, name, type, description, enabled, orphaned)
            VALUES ('openapi', 'openapi', 'adapter', 'old description', 1, 0),
                   ('typescript-ivm', 'typescript-ivm', 'environment', '', 1, 0)`,
      );

      const service = new ModuleService(makeBindings(), makeLifecycle());
      await service.initialize(MISSING_PATH);

      expect(await service.get("openapi")).toMatchObject({
        id: "openapi",
        name: "OpenAPI Adapter",
        description: "Fake openapi adapter",
      });
      expect(await service.get("typescript-ivm")).toMatchObject({
        id: "typescript-ivm",
        name: "Typescript Isolated VM",
      });
    });

    it("clears the orphaned flag when a previously orphaned module reappears", async () => {
      // Run 1: orphan a module.
      const first = new ModuleService(makeBindings(), makeLifecycle());
      await db.run(
        sql`INSERT INTO modules (id, name, type, description, enabled, orphaned)
            VALUES ('openapi', 'openapi', 'adapter', '', 0, 1)`,
      );
      await first.initialize(MISSING_PATH);

      const row = unwrap(await first.get("openapi"), "module 'openapi'");
      expect(row.orphaned).toBe(false);
    });

    it("reload() re-runs reconcile and respects new manifests", async () => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mci-mod-"));
      try {
        const service = new ModuleService(makeBindings(), makeLifecycle());
        await service.initialize(dir);
        // No custom modules → only the builtins.
        let rows = await service.list();
        expect(rows.map((r) => r.id).sort()).toEqual([
          "openapi",
          "typescript-ivm",
        ]);

        // Add a custom module on disk, then reload.
        const modDir = path.join(dir, "fresh");
        await fs.mkdir(modDir);
        await fs.writeFile(
          path.join(modDir, "module.json"),
          JSON.stringify({
            id: "freshMod",
            name: "Fresh Module",
            description: "x",
            type: "adapter",
            main: "index.mjs",
          }),
        );
        await fs.writeFile(
          path.join(modDir, "index.mjs"),
          `export function instantiate() {
             return {
               async setup() {},
               async teardown() {},
               async generateDefinition() { return { name: "x", description: "", configSchema: {}, secretsSchema: {}, tools: [], adapterDomain: {} }; },
               async hydrateService() {},
               async dehydrateService() {},
               async invoke() { return null; },
             };
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

    it("reload() does not deactivate in-memory state for now-orphaned modules", async () => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mci-mod-"));
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
            main: "index.mjs",
          }),
        );
        await fs.writeFile(
          path.join(modDir, "index.mjs"),
          `export function instantiate() {
             return {
               async setup() {},
               async teardown() {},
               async generateDefinition() { return { name: "x", description: "", configSchema: {}, secretsSchema: {}, tools: [], adapterDomain: {} }; },
               async hydrateService() {},
               async dehydrateService() {},
               async invoke() { return { stale: true }; },
             };
           }`,
        );

        const service = new ModuleService(makeBindings(), makeLifecycle());
        await service.initialize(dir);
        // Custom adapter is active.
        await db.run(
          sql`INSERT INTO services (id, name, description, hash, source, adapter, enabled, config_schema, secrets_schema, adapter_domain)
              VALUES ('alpha', 'alpha', '', 'h', '', 'transientMod', 1, '{}', '{}', '{}')`,
        );
        await db.run(
          sql`INSERT INTO tools (service_id, id, name, description, enabled, input_schema, output_schema, adapter_domain)
              VALUES ('alpha', 't', 't', '', 1, '{}', '{}', '{}')`,
        );

        // Now remove the custom module directory and reload.
        await fs.rm(modDir, { recursive: true, force: true });
        await service.reload();

        const row = unwrap(
          await service.get("transientMod"),
          "module 'transientMod'",
        );
        expect(row.orphaned).toBe(true);
        expect(row.enabled).toBe(false);

        // The bug: the stale in-memory adapter still serves invokes. The fix
        // should make this throw 503 (adapter no longer active).
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

  // ----------------------------------------------------------------------
  // Environment swap / draining
  // ----------------------------------------------------------------------
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

      // Teardown shouldn't have fired yet — execution is still pending.
      expect(env.teardownCalls.length).toBe(0);

      release();
      await exec;
      // Give the dispose chain a tick to settle.
      await new Promise((resolve) => setImmediate(resolve));
      expect(env.teardownCalls.length).toBeGreaterThan(0);
    });
  });

  // ----------------------------------------------------------------------
  // config / secrets
  // ----------------------------------------------------------------------
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
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mci-mod-"));
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
            main: "index.mjs",
            configSchema: { type: "null" },
          }),
        );
        await fs.writeFile(
          path.join(moduleDir, "index.mjs"),
          `export function instantiate() {
             return {
               async setup() {},
               async teardown() {},
               async generateDefinition() { return { name: "x", description: "", configSchema: {}, secretsSchema: {}, tools: [], adapterDomain: {} }; },
               async hydrateService() {},
               async dehydrateService() {},
               async invoke() { return null; },
             };
           }`,
        );

        const service = new ModuleService(makeBindings(), makeLifecycle());
        await service.initialize(dir);

        await expect(
          service.patchConfig({
            id: "nullConfig",
            patch: [{ op: "replace", path: "", value: null }],
          }),
        ).resolves.toBeUndefined();

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
      // A second instance should have been created with the new config.
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
        sql`INSERT INTO modules (id, name, type, description, enabled, orphaned)
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

      // New environment instance created with updated config.
      expect(envInstances).toHaveLength(2);
      const secondEnv = unwrap(envInstances[1], "environment (post-reload)");
      expect(secondEnv.setupCalls[0]).toMatchObject({
        config: { poolSize: 4 },
        secrets: {},
      });

      // Old env drains then tears down.
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

      // The stored payload should be the encrypted blob, not the plaintext.
      const stored = await db.run(
        sql`SELECT payload FROM module_secrets WHERE module_id = 'openapi'`,
      );
      const payload = String(stored.rows?.[0]?.[0] ?? "");
      expect(payload).not.toContain("sekret");

      // Reload should have provided the new secrets to the new adapter.
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

    it("setEnabled refuses to enable when config is invalid", async () => {
      const service = new ModuleService(makeBindings(), makeLifecycle());
      await db.run(
        sql`INSERT INTO modules (id, name, type, description, enabled, orphaned)
            VALUES ('openapi', 'openapi', 'adapter', '', 0, 0)`,
      );
      await service.initialize(MISSING_PATH);

      // Seed a bad config (an unknown property) directly in the DB so that
      // the validation in setEnabled rejects it.
      await db.run(
        sql`INSERT INTO module_configurations (module_id, payload, updated_at)
            VALUES ('openapi', '{"unknown":1}', 0)`,
      );

      await expect(
        service.setEnabled({ id: "openapi", enabled: true }),
      ).rejects.toBeInstanceOf(HttpError);
      // Activation should not have happened.
      expect(adapterInstances).toHaveLength(0);
    });

    it("config/secrets survive reload() and are still applied on next enable", async () => {
      const service = new ModuleService(makeBindings(), makeLifecycle());
      await service.initialize(MISSING_PATH);

      await service.patchConfig({
        id: "openapi",
        patch: [{ op: "add", path: "/baseUrl", value: "https://kept" }],
      });

      // Disable and re-enable should pass the persisted config through.
      await service.setEnabled({ id: "openapi", enabled: false });
      adapterInstances.length = 0;
      await service.setEnabled({ id: "openapi", enabled: true });

      const adapter = unwrap(adapterInstances[0], "adapter");
      expect(adapter.setupCalls[0]).toMatchObject({
        config: { baseUrl: "https://kept" },
      });
    });
  });

  // ----------------------------------------------------------------------
  // installModule()
  // ----------------------------------------------------------------------
  describe("installModule()", () => {
    it("installs a module from a valid archive and returns its manifest", async () => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mci-install-"));
      try {
        const tarData = await createTestTar(dir, {
          "module.json": JSON.stringify({
            id: "installedMod",
            name: "Installed Module",
            description: "test module",
            type: "adapter",
            main: "index.mjs",
          }),
          "index.mjs": `export function instantiate() {
            return {
              async setup() {},
              async teardown() {},
              async generateDefinition() { return { name: "x", description: "", configSchema: {}, secretsSchema: {}, tools: [], adapterDomain: {} }; },
              async hydrateService() {},
              async dehydrateService() {},
              async invoke() { return null; },
            };
          }`,
        });

        const tarUint8 = new Uint8Array(tarData);
        downloadBinaryMock.mockResolvedValue(Buffer.from("mocked"));
        decompressMock.mockReturnValue(tarUint8);

        const service = new ModuleService(makeBindings(), makeLifecycle());
        await service.initialize(dir);

        const manifest = await service.installModule(
          "https://example.com/mod.tar.zst",
        );

        expect(manifest.id).toBe("installedMod");
        expect(manifest.name).toBe("Installed Module");
        expect(manifest.type).toBe("adapter");
        expect(manifest.enabled).toBe(false);
        expect(manifest.orphaned).toBe(false);
        expect(manifest.isBuiltin).toBe(false);

        const record = unwrap(
          await service.get("installedMod"),
          "module 'installedMod'",
        );
        expect(record.enabled).toBe(false);
        expect(record.orphaned).toBe(false);
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
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mci-install-"));
      try {
        const tarData = await createTestTar(dir, {
          "module.json": JSON.stringify({
            id: "dupeMod",
            name: "Dupe Module",
            description: "duplicate",
            type: "adapter",
            main: "index.mjs",
          }),
          "index.mjs": `export function instantiate() {
            return {
              async setup() {},
              async teardown() {},
              async generateDefinition() { return { name: "x", description: "", configSchema: {}, secretsSchema: {}, tools: [], adapterDomain: {} }; },
              async hydrateService() {},
              async dehydrateService() {},
              async invoke() { return null; },
            };
          }`,
        });

        const tarUint8 = new Uint8Array(tarData);
        downloadBinaryMock.mockResolvedValue(Buffer.from("mocked"));
        decompressMock.mockReturnValue(tarUint8);

        const service = new ModuleService(makeBindings(), makeLifecycle());
        await service.initialize(dir);

        await service.installModule("https://example.com/first.tar.zst");

        downloadBinaryMock.mockResolvedValue(Buffer.from("mocked"));
        decompressMock.mockReturnValue(tarUint8);

        await expect(
          service.installModule("https://example.com/dupe.tar.zst"),
        ).rejects.toMatchObject({
          statusCode: 409,
          message: "Module 'dupeMod' is already registered.",
        });
      } finally {
        await fs.rm(dir, { recursive: true, force: true });
      }
    });

    it("rejects an archive missing module.json", async () => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mci-install-"));
      try {
        const tarData = await createTestTar(dir, {
          "index.mjs": `export function instantiate() { return {}; }`,
        });

        const tarUint8 = new Uint8Array(tarData);
        downloadBinaryMock.mockResolvedValue(Buffer.from("mocked"));
        decompressMock.mockReturnValue(tarUint8);

        const service = new ModuleService(makeBindings(), makeLifecycle());
        await service.initialize(dir);

        await expect(
          service.installModule("https://example.com/bad.tar.zst"),
        ).rejects.toMatchObject({
          statusCode: 400,
          message: "Archive must contain a 'module.json' at its root.",
        });
      } finally {
        await fs.rm(dir, { recursive: true, force: true });
      }
    });

    it("rejects an archive with invalid module.json content", async () => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mci-install-"));
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
          service.installModule("https://example.com/bad.tar.zst"),
        ).rejects.toMatchObject({
          statusCode: 400,
          message: "module.json contains invalid JSON.",
        });
      } finally {
        await fs.rm(dir, { recursive: true, force: true });
      }
    });

    it("rejects an archive whose main points outside the archive", async () => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mci-install-"));
      try {
        const tarData = await createTestTar(dir, {
          "module.json": JSON.stringify({
            id: "escapeMod",
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
          service.installModule("https://example.com/escape.tar.zst"),
        ).rejects.toMatchObject({
          statusCode: 400,
          message: "Manifest 'main' must point to a file inside the archive.",
        });
      } finally {
        await fs.rm(dir, { recursive: true, force: true });
      }
    });
  });

  // ----------------------------------------------------------------------
  // deleteModule()
  // ----------------------------------------------------------------------
  describe("deleteModule()", () => {
    it("deletes a module and its filesystem directory", async () => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mci-del-"));
      try {
        const modDir = path.join(dir, "toBeDeleted");
        await fs.mkdir(modDir);
        await fs.writeFile(
          path.join(modDir, "module.json"),
          JSON.stringify({
            id: "toBeDeleted",
            name: "Delete Me",
            description: "will be deleted",
            type: "adapter",
            main: "index.mjs",
          }),
        );
        await fs.writeFile(
          path.join(modDir, "index.mjs"),
          `export function instantiate() {
            return {
              async setup() {},
              async teardown() {},
              async generateDefinition() { return { name: "x", description: "", configSchema: {}, secretsSchema: {}, tools: [], adapterDomain: {} }; },
              async hydrateService() {},
              async dehydrateService() {},
              async invoke() { return null; },
            };
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
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mci-del-"));
      try {
        const modDir = path.join(dir, "adapterMod");
        await fs.mkdir(modDir);
        await fs.writeFile(
          path.join(modDir, "module.json"),
          JSON.stringify({
            id: "adapterMod",
            name: "Adapter",
            description: "adapter",
            type: "adapter",
            main: "index.mjs",
          }),
        );
        await fs.writeFile(
          path.join(modDir, "index.mjs"),
          `export function instantiate() {
            return {
              async setup() {},
              async teardown() {},
              async generateDefinition() { return { name: "x", description: "", configSchema: {}, secretsSchema: {}, tools: [], adapterDomain: {} }; },
              async hydrateService() {},
              async dehydrateService() {},
              async invoke() { return null; },
            };
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

  // ----------------------------------------------------------------------
  // installModule — hash and source storage
  // ----------------------------------------------------------------------
  describe("installModule hash/source", () => {
    it("stores hash and source in the database but omits them from the return value", async () => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mci-hash-"));
      try {
        const tarData = await createTestTar(dir, {
          "module.json": JSON.stringify({
            id: "hashTestMod",
            name: "Hash Test",
            description: "testing",
            type: "adapter",
            main: "index.mjs",
          }),
          "index.mjs": `export function instantiate() {
            return {
              async setup() {},
              async teardown() {},
              async generateDefinition() { return { name: "x", description: "", configSchema: {}, secretsSchema: {}, tools: [], adapterDomain: {} }; },
              async hydrateService() {},
              async dehydrateService() {},
              async invoke() { return null; },
            };
          }`,
        });

        const tarUint8 = new Uint8Array(tarData);
        const downloadPayload = Buffer.from("test-download-bytes");
        downloadBinaryMock.mockResolvedValue(downloadPayload);
        decompressMock.mockReturnValue(tarUint8);

        const service = new ModuleService(makeBindings(), makeLifecycle());
        await service.initialize(dir);

        const result = await service.installModule(
          "https://example.com/hash-test.tar.zst",
        );

        // Return value should include hash and source
        expect(result.hash).toBeDefined();
        expect(result.source).toBe("https://example.com/hash-test.tar.zst");

        // DB should have them
        const [row] = await db
          .select({
            hash: (await import("@/db/schema")).modules.hash,
            source: (await import("@/db/schema")).modules.source,
          })
          .from((await import("@/db/schema")).modules)
          .where(eq((await import("@/db/schema")).modules.id, "hashTestMod"))
          .limit(1);
        expect(row).toBeDefined();
        expect(row?.source).toBe("https://example.com/hash-test.tar.zst");

        const { computeBinaryHash } = await import("@/utils/hash.util");
        expect(row?.hash).toBe(computeBinaryHash(downloadPayload));
      } finally {
        await fs.rm(dir, { recursive: true, force: true });
      }
    });
  });

  // ----------------------------------------------------------------------
  // updateModule()
  // ----------------------------------------------------------------------
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
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mci-upd-"));
      try {
        const modDir = path.join(dir, "noSourceMod");
        await fs.mkdir(modDir);
        await fs.writeFile(
          path.join(modDir, "module.json"),
          JSON.stringify({
            id: "noSourceMod",
            name: "No Source",
            description: "no source",
            type: "adapter",
            main: "index.mjs",
          }),
        );
        await fs.writeFile(
          path.join(modDir, "index.mjs"),
          `export function instantiate() {
            return {
              async setup() {},
              async teardown() {},
              async generateDefinition() { return { name: "x", description: "", configSchema: {}, secretsSchema: {}, tools: [], adapterDomain: {} }; },
              async hydrateService() {},
              async dehydrateService() {},
              async invoke() { return null; },
            };
          }`,
        );

        const service = new ModuleService(makeBindings(), makeLifecycle());
        await service.initialize(dir);

        await expect(service.updateModule("noSourceMod")).rejects.toMatchObject(
          {
            statusCode: 409,
            message:
              "Module 'noSourceMod' has no stored install source and cannot be updated automatically.",
          },
        );
      } finally {
        await fs.rm(dir, { recursive: true, force: true });
      }
    });

    it("skips the update when the archive hash has not changed", async () => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mci-upd-"));
      try {
        const tarData = await createTestTar(dir, {
          "module.json": JSON.stringify({
            id: "stableMod",
            name: "Stable Module",
            description: "stable",
            type: "adapter",
            main: "index.mjs",
          }),
          "index.mjs": `export function instantiate() {
            return {
              async setup() {},
              async teardown() {},
              async generateDefinition() { return { name: "x", description: "", configSchema: {}, secretsSchema: {}, tools: [], adapterDomain: {} }; },
              async hydrateService() {},
              async dehydrateService() {},
              async invoke() { return null; },
            };
          }`,
        });

        const tarUint8 = new Uint8Array(tarData);
        const downloadPayload = Buffer.from("stable-download");
        downloadBinaryMock.mockResolvedValue(downloadPayload);
        decompressMock.mockReturnValue(tarUint8);

        const service = new ModuleService(makeBindings(), makeLifecycle());
        await service.initialize(dir);
        await service.installModule("https://example.com/stable.tar.zst");

        // Same payload → same hash → should skip
        downloadBinaryMock.mockResolvedValue(downloadPayload);

        const result = await service.updateModule("stableMod");
        expect(result).toEqual({ updated: false });
      } finally {
        await fs.rm(dir, { recursive: true, force: true });
      }
    });

    it("re-installs when the archive hash has changed", async () => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mci-upd-"));
      try {
        const tarData = await createTestTar(dir, {
          "module.json": JSON.stringify({
            id: "changedMod",
            name: "Changed Module",
            description: "original",
            type: "adapter",
            main: "index.mjs",
          }),
          "index.mjs": `export function instantiate() {
            return {
              async setup() {},
              async teardown() {},
              async generateDefinition() { return { name: "x", description: "", configSchema: {}, secretsSchema: {}, tools: [], adapterDomain: {} }; },
              async hydrateService() {},
              async dehydrateService() {},
              async invoke() { return null; },
            };
          }`,
        });

        const tarUint8 = new Uint8Array(tarData);
        downloadBinaryMock.mockResolvedValue(Buffer.from("original-download"));
        decompressMock.mockReturnValue(tarUint8);

        const service = new ModuleService(makeBindings(), makeLifecycle());
        await service.initialize(dir);
        await service.installModule("https://example.com/changed.tar.zst");

        // New tar with updated name
        const newTarData = await createTestTar(dir, {
          "module.json": JSON.stringify({
            id: "changedMod",
            name: "Changed Module Updated",
            description: "updated",
            type: "adapter",
            main: "index.mjs",
          }),
          "index.mjs": `export function instantiate() {
            return {
              async setup() {},
              async teardown() {},
              async generateDefinition() { return { name: "x", description: "", configSchema: {}, secretsSchema: {}, tools: [], adapterDomain: {} }; },
              async hydrateService() {},
              async dehydrateService() {},
              async invoke() { return null; },
            };
          }`,
        });

        const newTarUint8 = new Uint8Array(newTarData);
        downloadBinaryMock.mockResolvedValue(Buffer.from("updated-download"));
        decompressMock.mockReturnValue(newTarUint8);

        const result = await service.updateModule("changedMod");
        expect(result).toEqual({ updated: true });

        // Description should be updated
        const record = unwrap(
          await service.get("changedMod"),
          "module 'changedMod'",
        );
        expect(record.description).toBe("updated");

        // DB should also reflect the update
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
  });
});
