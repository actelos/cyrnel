import crypto from "node:crypto";
import dns from "node:dns/promises";
import fs from "node:fs/promises";
import path from "node:path";
import type {
  JSONSchema,
  ServiceDefinition,
  ServiceState,
  ToolDocsInput,
} from "@cyrnel/sdk";
import { sql } from "drizzle-orm";
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

import { db } from "@/db/client";
import { HttpError } from "@/models/error.model";
import type { GenerateDefinitionInput } from "@/models/modules.model";
import {
  type AdapterController,
  ServicesService,
} from "@/services/services.service";
import { encryptSecrets } from "@/utils/secrets.util";

const MIGRATIONS_DIR = path.resolve(import.meta.dirname, "../../drizzle");

const SECRETS_KEY = crypto.randomBytes(32).toString("base64");
const originalSecretsKey = process.env.CYRNEL_SECRETS_KEY;
const originalPreviousKeys = process.env.CYRNEL_SECRETS_PREVIOUS_KEYS;

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

async function ensureAdapterRow(id = "test-adapter"): Promise<void> {
  await db.run(
    sql`INSERT INTO modules (id, name, type, description, enabled, missing)
        VALUES (${id}, ${id}, 'adapter', '', 1, 0)`,
  );
}

type ControllerSpy = {
  [K in keyof AdapterController]: ReturnType<
    typeof vi.fn<AdapterController[K]>
  >;
};

function makeController(overrides: Partial<ControllerSpy> = {}): ControllerSpy {
  return {
    generateDefinition: vi.fn<AdapterController["generateDefinition"]>(
      async (_input: GenerateDefinitionInput): Promise<ServiceDefinition> =>
        sampleDefinition(),
    ),
    hydrateService: vi.fn<AdapterController["hydrateService"]>(
      async (_adapterId: string, _state: ServiceState): Promise<void> => {},
    ),
    dehydrateService: vi.fn<AdapterController["dehydrateService"]>(
      async (_adapterId: string, _serviceId: string): Promise<void> => {},
    ),
    generateToolDocs: vi.fn<AdapterController["generateToolDocs"]>(
      async (_input: ToolDocsInput): Promise<string> => "# docs",
    ),
    ...overrides,
  };
}

const EMPTY_OBJECT_SCHEMA: JSONSchema = {
  type: "object",
  properties: {},
  additionalProperties: false,
};

function sampleDefinition(
  overrides: Partial<ServiceDefinition> = {},
): ServiceDefinition {
  return {
    name: "Demo Service",
    description: "demo",
    configSchema: EMPTY_OBJECT_SCHEMA,
    secretsSchema: EMPTY_OBJECT_SCHEMA,
    adapterDomain: {},
    tools: [
      {
        id: "doStuff",
        name: "doStuff",
        description: "does stuff",
        inputSchema: EMPTY_OBJECT_SCHEMA,
        outputSchema: EMPTY_OBJECT_SCHEMA,
        adapterDomain: {},
      },
    ],
    ...overrides,
  };
}

async function seedService(
  id: string,
  options: {
    adapter?: string;
    enabled?: boolean;
    source?: string;
    hash?: string;
    name?: string;
    description?: string;
    configSchema?: JSONSchema;
    secretsSchema?: JSONSchema;
    tools?: { id: string; name: string; enabled?: boolean }[];
    version?: string;
  } = {},
): Promise<void> {
  const adapter = options.adapter ?? "test-adapter";
  await db.run(
    sql`INSERT INTO services (id, name, description, hash, version, source, adapter, enabled, config_schema, secrets_schema, adapter_domain)
        VALUES (${id},
                ${options.name ?? id},
                ${options.description ?? ""},
                ${options.hash ?? "hash"},
                ${options.version ?? "1.0.0"},
                ${options.source ?? "https://example.com/def.json"},
                ${adapter},
                ${options.enabled === false ? 0 : 1},
                ${JSON.stringify(options.configSchema ?? EMPTY_OBJECT_SCHEMA)},
                ${JSON.stringify(options.secretsSchema ?? EMPTY_OBJECT_SCHEMA)},
                ${JSON.stringify({})})`,
  );
  for (const tool of options.tools ?? []) {
    await db.run(
      sql`INSERT INTO tools (service_id, id, name, description, enabled, input_schema, output_schema, adapter_domain)
          VALUES (${id}, ${tool.id}, ${tool.name}, '',
                  ${tool.enabled === false ? 0 : 1},
                  ${JSON.stringify(EMPTY_OBJECT_SCHEMA)},
                  ${JSON.stringify(EMPTY_OBJECT_SCHEMA)},
                  ${JSON.stringify({})})`,
    );
  }
}

function mockFetchOnce(
  body: string,
  init: { status?: number; contentLength?: string; url?: string } = {},
) {
  const headers = new Headers();
  if (init.contentLength) headers.set("content-length", init.contentLength);
  const response = new Response(body, {
    status: init.status ?? 200,
    headers,
  });
  if (init.url) Object.defineProperty(response, "url", { value: init.url });
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => response),
  );
}

function mockFetchRegistryThen(
  hash: string | undefined,
  downloadUrl: string,
  definitionContent: string,
) {
  let callCount = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string) => {
      callCount++;
      if (callCount === 1) {
        return new Response(
          JSON.stringify({
            latestVersion: "1.0.0",
            versions: { "1.0.0": { downloadUrl, hash } },
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
      }
      return new Response(definitionContent, { status: 200 });
    }),
  );
}

function mockFetchRegistryWithIcon(opts: {
  registryUrl?: string;
  registryHash?: string;
  downloadUrl: string;
  definitionContent: string;
  icon?: { url: string; hash: string; data?: Buffer; error?: boolean };
}) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (opts.icon && url === opts.icon.url) {
        if (opts.icon.error) throw new Error("icon network failure");
        return new Response(opts.icon.data ?? PNG_ICON, { status: 200 });
      }
      if (url === (opts.registryUrl ?? "https://registry.example.com/svc")) {
        return new Response(
          JSON.stringify({
            latestVersion: "1.0.0",
            versions: {
              "1.0.0": {
                downloadUrl: opts.downloadUrl,
                hash: opts.registryHash,
                ...(opts.icon
                  ? { icon: { url: opts.icon.url, hash: opts.icon.hash } }
                  : {}),
              },
            },
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
      }
      return new Response(opts.definitionContent, { status: 200 });
    }),
  );
}

const PNG_ICON = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(16),
]);

describe("ServicesService", () => {
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
    await ensureAdapterRow();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.useRealTimers();
    vi.spyOn(dns, "lookup").mockResolvedValue([
      { address: "93.184.216.34", family: 4 },
    ] as never);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe("listServices()", () => {
    it("returns every row when no filter is supplied", async () => {
      await seedService("alpha");
      await seedService("beta");
      const svc = new ServicesService(makeController());

      const rows = await svc.listServices();
      expect(rows.map((r) => r.id).sort()).toEqual(["alpha", "beta"]);
    });

    it("filters by enabled flag", async () => {
      await seedService("on", { enabled: true });
      await seedService("off", { enabled: false });
      const svc = new ServicesService(makeController());

      expect(
        (await svc.listServices({ enabled: true })).map((r) => r.id),
      ).toEqual(["on"]);
      expect(
        (await svc.listServices({ enabled: false })).map((r) => r.id),
      ).toEqual(["off"]);
    });

    it("matches against id, name, and description with the query filter (fails because drizzle `ilike` emits SQL `ILIKE` which libsql/SQLite rejects)", async () => {
      await seedService("alpha", { name: "Demo One", description: "first" });
      await seedService("beta", { name: "Other", description: "weather" });
      const svc = new ServicesService(makeController());

      expect(
        (await svc.listServices({ query: "alpha" })).map((r) => r.id),
      ).toEqual(["alpha"]);
      expect(
        (await svc.listServices({ query: "demo" })).map((r) => r.id),
      ).toEqual(["alpha"]);
      expect(
        (await svc.listServices({ query: "weather" })).map((r) => r.id),
      ).toEqual(["beta"]);
    });

    it("matches a mixed-case query against mixed-case stored values", async () => {
      await seedService("alpha", { name: "Demo One", description: "First" });
      const svc = new ServicesService(makeController());

      expect(
        (await svc.listServices({ query: "DEMO" })).map((r) => r.id),
      ).toEqual(["alpha"]);
      expect(
        (await svc.listServices({ query: "first" })).map((r) => r.id),
      ).toEqual(["alpha"]);
    });

    it("respects the limit", async () => {
      for (const id of ["a", "b", "c", "d"]) await seedService(id);
      const svc = new ServicesService(makeController());

      const rows = await svc.listServices({ limit: 2 });
      expect(rows).toHaveLength(2);
    });

    it("does not return configSchema, secretsSchema, or adapterDomain", async () => {
      await seedService("alpha");
      const svc = new ServicesService(makeController());

      const [row] = await svc.listServices();
      expect(row).toBeDefined();
      expect("configSchema" in (row as object)).toBe(false);
      expect("secretsSchema" in (row as object)).toBe(false);
      expect("adapterDomain" in (row as object)).toBe(false);
    });
  });

  describe("getService()", () => {
    it("returns the row including configSchema and secretsSchema", async () => {
      await seedService("alpha");
      const svc = new ServicesService(makeController());

      const row = await svc.getService("alpha");
      expect(row.id).toBe("alpha");
      expect(row.configSchema).toBeDefined();
      expect(row.secretsSchema).toBeDefined();
    });

    it("throws 404 when not found", async () => {
      const svc = new ServicesService(makeController());
      await expect(svc.getService("missing")).rejects.toMatchObject({
        statusCode: 404,
      });
    });
  });

  describe("listTools()", () => {
    it("throws 404 when filtering by an unknown service", async () => {
      const svc = new ServicesService(makeController());
      await expect(svc.listTools({ serviceId: "ghost" })).rejects.toMatchObject(
        {
          statusCode: 404,
        },
      );
    });

    it("returns tools across services when serviceId is omitted", async () => {
      await seedService("alpha", { tools: [{ id: "x", name: "x" }] });
      await seedService("beta", { tools: [{ id: "y", name: "y" }] });
      const svc = new ServicesService(makeController());

      const rows = await svc.listTools({});
      expect(rows.map((r) => r.name).sort()).toEqual(["x", "y"]);
      for (const r of rows) {
        expect("inputSchema" in r).toBe(false);
        expect("outputSchema" in r).toBe(false);
        expect("adapterDomain" in r).toBe(false);
      }
    });

    it("effectivelyEnabled reflects both the service and tool flags", async () => {
      await seedService("alpha", {
        enabled: true,
        tools: [
          { id: "on", name: "on", enabled: true },
          { id: "off", name: "off", enabled: false },
        ],
      });
      await seedService("beta", {
        enabled: false,
        tools: [{ id: "on", name: "on", enabled: true }],
      });
      const svc = new ServicesService(makeController());

      const alphaRows = await svc.listTools({ serviceId: "alpha" });
      const map = new Map(alphaRows.map((r) => [r.name, r.effectivelyEnabled]));
      expect(map.get("on")).toBe(true);
      expect(map.get("off")).toBe(false);

      const betaRows = await svc.listTools({ serviceId: "beta" });
      expect(betaRows[0]?.effectivelyEnabled).toBe(false);
    });

    it("respects enabled and limit filters", async () => {
      await seedService("alpha", {
        tools: [
          { id: "one", name: "one", enabled: true },
          { id: "two", name: "two", enabled: false },
          { id: "three", name: "three", enabled: true },
        ],
      });
      const svc = new ServicesService(makeController());

      expect(
        (await svc.listTools({ enabled: false })).map((r) => r.name),
      ).toEqual(["two"]);
      expect(await svc.listTools({ limit: 1 })).toHaveLength(1);
    });

    it("query filter for tools (fails on libsql because drizzle `ilike` emits unsupported SQL)", async () => {
      await seedService("alpha", {
        tools: [
          { id: "one", name: "one", enabled: true },
          { id: "three", name: "three", enabled: true },
        ],
      });
      const svc = new ServicesService(makeController());

      expect(
        (await svc.listTools({ query: "thr" })).map((r) => r.name),
      ).toEqual(["three"]);
    });
  });

  describe("getTool()", () => {
    it("returns the tool with effectivelyEnabled", async () => {
      await seedService("alpha", {
        enabled: true,
        tools: [{ id: "x", name: "x", enabled: true }],
      });
      const svc = new ServicesService(makeController());

      const tool = await svc.getTool({ serviceId: "alpha", toolId: "x" });
      expect(tool.name).toBe("x");
      expect(tool.effectivelyEnabled).toBe(true);
    });

    it("effectivelyEnabled is false when service is disabled", async () => {
      await seedService("alpha", {
        enabled: false,
        tools: [{ id: "x", name: "x", enabled: true }],
      });
      const svc = new ServicesService(makeController());

      const tool = await svc.getTool({ serviceId: "alpha", toolId: "x" });
      expect(tool.effectivelyEnabled).toBe(false);
    });

    it("throws 404 when the tool does not exist", async () => {
      await seedService("alpha");
      const svc = new ServicesService(makeController());
      await expect(
        svc.getTool({ serviceId: "alpha", toolId: "ghost" }),
      ).rejects.toMatchObject({ statusCode: 404 });
    });

    it("throws 404 when the service does not exist", async () => {
      const svc = new ServicesService(makeController());
      await expect(
        svc.getTool({ serviceId: "ghost", toolId: "x" }),
      ).rejects.toMatchObject({ statusCode: 404 });
    });

    it("looks up by tool id, not name", async () => {
      await seedService("alpha", {
        tools: [{ id: "do_stuff", name: "Do Stuff", enabled: true }],
      });
      const svc = new ServicesService(makeController());

      const tool = await svc.getTool({
        serviceId: "alpha",
        toolId: "do_stuff",
      });
      expect(tool.id).toBe("do_stuff");
      expect(tool.name).toBe("Do Stuff");

      await expect(
        svc.getTool({ serviceId: "alpha", toolId: "Do Stuff" }),
      ).rejects.toMatchObject({ statusCode: 404 });
    });
  });

  describe("getToolDocs()", () => {
    it("delegates to controller.generateToolDocs and returns the rendered docs", async () => {
      await seedService("alpha", {
        tools: [{ id: "x", name: "x" }],
      });
      const controller = makeController({
        generateToolDocs: vi.fn(async () => "# rendered"),
      });
      const svc = new ServicesService(controller);

      const docs = await svc.getToolDocs({ serviceId: "alpha", toolId: "x" });
      expect(docs).toBe("# rendered");
      expect(controller.generateToolDocs).toHaveBeenCalledWith(
        expect.objectContaining({ serviceId: "alpha", toolId: "x" }),
      );
    });

    it("throws 404 when the tool is missing", async () => {
      const svc = new ServicesService(makeController());
      await expect(
        svc.getToolDocs({ serviceId: "ghost", toolId: "x" }),
      ).rejects.toMatchObject({ statusCode: 404 });
    });

    it("looks up by tool id, not name", async () => {
      await seedService("alpha", {
        tools: [{ id: "do_stuff", name: "Do Stuff", enabled: true }],
      });
      const controller = makeController({
        generateToolDocs: vi.fn(async () => "# rendered"),
      });
      const svc = new ServicesService(controller);

      const docs = await svc.getToolDocs({
        serviceId: "alpha",
        toolId: "do_stuff",
      });
      expect(docs).toBe("# rendered");

      await expect(
        svc.getToolDocs({ serviceId: "alpha", toolId: "Do Stuff" }),
      ).rejects.toMatchObject({ statusCode: 404 });
    });
  });

  describe("createService()", () => {
    it("rejects invalid service ids", async () => {
      const svc = new ServicesService(makeController());
      await expect(
        svc.createServiceDirect({
          id: "1bad",
          url: "https://example.com/def.json",
          adapter: "test-adapter",
        }),
      ).rejects.toMatchObject({ statusCode: 400 });
    });

    it("persists the service and tools when valid", async () => {
      mockFetchOnce("payload");
      const controller = makeController();
      const svc = new ServicesService(controller);

      await svc.createServiceDirect({
        id: "alpha",
        url: "https://example.com/def.json",
        adapter: "test-adapter",
      });

      const row = await svc.getService("alpha");
      expect(row.enabled).toBe(false);
      expect(controller.generateDefinition).toHaveBeenCalledWith({
        definition: "payload",
        adapter: "test-adapter",
      });

      const tools = await svc.listTools({ serviceId: "alpha" });
      expect(tools.map((t) => t.name)).toEqual(["doStuff"]);
      expect(tools[0]?.enabled).toBe(true);
    });

    it('rejects definitions whose tool id is not a valid identifier (createService says "Tool name" instead of the intended "Tool id")', async () => {
      mockFetchOnce("payload");
      const controller = makeController({
        generateDefinition: vi.fn(async () =>
          sampleDefinition({
            tools: [
              {
                id: "1bad",
                name: "1bad",
                description: "",
                inputSchema: EMPTY_OBJECT_SCHEMA,
                outputSchema: EMPTY_OBJECT_SCHEMA,
                adapterDomain: {},
              },
            ],
          }),
        ),
      });
      const svc = new ServicesService(controller);

      try {
        await svc.createServiceDirect({
          id: "alpha",
          url: "https://example.com/def.json",
          adapter: "test-adapter",
        });
        throw new Error("should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(HttpError);
        expect((err as HttpError).statusCode).toBe(400);
        expect((err as HttpError).message).toMatch(
          /Tool id '1bad' must be a valid TypeScript identifier/,
        );
      }
    });

    it("returns 409 when the service already exists (fails because the UNIQUE-constraint regex inspects the outer drizzle wrapper, but libsql nests the SqliteError on .cause)", async () => {
      await seedService("alpha");
      mockFetchOnce("payload");
      const svc = new ServicesService(makeController());

      await expect(
        svc.createServiceDirect({
          id: "alpha",
          url: "https://example.com/def.json",
          adapter: "test-adapter",
        }),
      ).rejects.toMatchObject({ statusCode: 409 });
    });
  });

  describe("createServiceFromRegistry() (icon)", () => {
    it("stores the icon when the registry declares one", async () => {
      const { computeBinaryHash } = await import("@/utils/hash.util");
      const iconHash = computeBinaryHash(PNG_ICON);

      mockFetchRegistryWithIcon({
        registryUrl: "https://registry.example.com/svc",
        downloadUrl: "https://example.com/download",
        definitionContent: "payload",
        icon: { url: "https://icons.example.com/a.png", hash: iconHash },
      });

      const svc = new ServicesService(makeController());
      await svc.createServiceFromRegistry({
        id: "alpha",
        source: "https://registry.example.com/svc",
        adapter: "test-adapter",
      });

      const row = await svc.getService("alpha");
      expect(row.hasIcon).toBe(true);

      const icon = await svc.getServiceIcon("alpha");
      expect(icon).not.toBeNull();
      expect(icon?.data.equals(PNG_ICON)).toBe(true);
      expect(icon?.mime).toBe("image/png");
      expect(icon?.hash).toBe(iconHash);
    });

    it("installs without an icon when the icon download fails", async () => {
      const { computeBinaryHash } = await import("@/utils/hash.util");

      mockFetchRegistryWithIcon({
        registryUrl: "https://registry.example.com/svc",
        downloadUrl: "https://example.com/download",
        definitionContent: "payload",
        icon: {
          url: "https://icons.example.com/a.png",
          hash: computeBinaryHash(PNG_ICON),
          error: true,
        },
      });

      const svc = new ServicesService(makeController());
      await svc.createServiceFromRegistry({
        id: "alpha",
        source: "https://registry.example.com/svc",
        adapter: "test-adapter",
      });

      const row = await svc.getService("alpha");
      expect(row.hasIcon).toBe(false);
      expect(await svc.getServiceIcon("alpha")).toBeNull();
    });

    it("installs without an icon when the icon hash does not match", async () => {
      mockFetchRegistryWithIcon({
        registryUrl: "https://registry.example.com/svc",
        downloadUrl: "https://example.com/download",
        definitionContent: "payload",
        icon: { url: "https://icons.example.com/a.png", hash: "wrong-hash" },
      });

      const svc = new ServicesService(makeController());
      await svc.createServiceFromRegistry({
        id: "alpha",
        source: "https://registry.example.com/svc",
        adapter: "test-adapter",
      });

      const row = await svc.getService("alpha");
      expect(row.hasIcon).toBe(false);
    });

    it("installs without an icon when the content is not a supported raster", async () => {
      const { computeBinaryHash } = await import("@/utils/hash.util");
      const svg = Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>");

      mockFetchRegistryWithIcon({
        registryUrl: "https://registry.example.com/svc",
        downloadUrl: "https://example.com/download",
        definitionContent: "payload",
        icon: {
          url: "https://icons.example.com/a.svg",
          hash: computeBinaryHash(svg),
          data: svg,
        },
      });

      const svc = new ServicesService(makeController());
      await svc.createServiceFromRegistry({
        id: "alpha",
        source: "https://registry.example.com/svc",
        adapter: "test-adapter",
      });

      const row = await svc.getService("alpha");
      expect(row.hasIcon).toBe(false);
    });

    it("reports no icon for manual installs", async () => {
      mockFetchOnce("payload");
      const svc = new ServicesService(makeController());
      await svc.createServiceDirect({
        id: "alpha",
        url: "https://example.com/def.json",
        adapter: "test-adapter",
      });

      const row = await svc.getService("alpha");
      expect(row.hasIcon).toBe(false);
      expect(await svc.getServiceIcon("alpha")).toBeNull();
    });
  });

  describe("updateService()", () => {
    it("throws 404 when the service is unknown", async () => {
      const svc = new ServicesService(makeController());
      await expect(svc.updateService("missing")).rejects.toMatchObject({
        statusCode: 404,
      });
    });

    it("throws 409 when the service has no install source", async () => {
      await seedService("alpha", { source: "" });
      const svc = new ServicesService(makeController());
      await expect(svc.updateService("alpha")).rejects.toMatchObject({
        statusCode: 409,
      });
    });

    it("preserves enabled flags for tools that survive the update", async () => {
      await seedService("alpha", {
        tools: [
          { id: "keep", name: "keep", enabled: true },
          { id: "drop", name: "drop", enabled: true },
        ],
      });
      mockFetchRegistryThen(
        undefined,
        "https://example.com/download",
        "payload",
      );

      const controller = makeController({
        generateDefinition: vi.fn(async () =>
          sampleDefinition({
            tools: [
              {
                id: "keep",
                name: "keep",
                description: "",
                inputSchema: EMPTY_OBJECT_SCHEMA,
                outputSchema: EMPTY_OBJECT_SCHEMA,
                adapterDomain: {},
              },
              {
                id: "fresh",
                name: "fresh",
                description: "",
                inputSchema: EMPTY_OBJECT_SCHEMA,
                outputSchema: EMPTY_OBJECT_SCHEMA,
                adapterDomain: {},
              },
            ],
          }),
        ),
      });

      const svc = new ServicesService(controller);
      await svc.updateService("alpha");

      const tools = await svc.listTools({ serviceId: "alpha" });
      const map = new Map(tools.map((t) => [t.name, t.enabled]));
      expect(map.get("keep")).toBe(true);
      expect(map.get("fresh")).toBe(false);
      expect(map.has("drop")).toBe(false);

      const refreshed = await svc.getService("alpha");
      expect(refreshed.enabled).toBe(false);

      expect(controller.dehydrateService).toHaveBeenCalledWith(
        "test-adapter",
        "alpha",
      );
    });

    it("skips re-download when the content hash has not changed", async () => {
      await seedService("alpha", { enabled: true });
      const { computeContentHash } = await import("@/utils/hash.util");
      const content = "same-content";
      const hash = computeContentHash(content);

      await db.run(sql`UPDATE services SET hash = ${hash} WHERE id = 'alpha'`);

      mockFetchRegistryThen(undefined, "https://example.com/download", content);

      const controller = makeController();
      const svc = new ServicesService(controller);

      await svc.updateService("alpha");

      const refreshed = await svc.getService("alpha");
      expect(refreshed.enabled).toBe(true);

      expect(controller.dehydrateService).not.toHaveBeenCalled();
    });

    it("re-downloads when the content hash has changed", async () => {
      await seedService("alpha", { enabled: true });
      const { computeContentHash } = await import("@/utils/hash.util");
      const oldContent = "old-content";
      const oldHash = computeContentHash(oldContent);

      await db.run(
        sql`UPDATE services SET hash = ${oldHash} WHERE id = 'alpha'`,
      );

      mockFetchRegistryThen(
        undefined,
        "https://example.com/download",
        "new-content",
      );

      const controller = makeController();
      const svc = new ServicesService(controller);

      await svc.updateService("alpha");

      const refreshed = await svc.getService("alpha");
      expect(refreshed.enabled).toBe(false);

      expect(controller.dehydrateService).toHaveBeenCalledWith(
        "test-adapter",
        "alpha",
      );
    });

    it("skips the definition download when nothing changed", async () => {
      const { computeBinaryHash } = await import("@/utils/hash.util");
      const iconHash = computeBinaryHash(PNG_ICON);
      await seedService("alpha");
      await db.run(
        sql`UPDATE services SET icon_hash = ${iconHash} WHERE id = 'alpha'`,
      );

      mockFetchRegistryWithIcon({
        registryUrl: "https://example.com/def.json",
        registryHash: "hash",
        downloadUrl: "https://example.com/download",
        definitionContent: "unused",
        icon: { url: "https://icons.example.com/a.png", hash: iconHash },
      });

      const svc = new ServicesService(makeController());
      await svc.updateService("alpha");

      const calls = vi.mocked(fetch).mock.calls.map(([input]) => String(input));
      expect(calls).toEqual(["https://example.com/def.json"]);
    });

    it("re-fetches and stores the icon when the registry icon hash changes", async () => {
      const { computeBinaryHash } = await import("@/utils/hash.util");
      const newHash = computeBinaryHash(PNG_ICON);
      await seedService("alpha");
      await db.run(
        sql`UPDATE services SET icon_hash = 'old-hash' WHERE id = 'alpha'`,
      );

      mockFetchRegistryWithIcon({
        registryUrl: "https://example.com/def.json",
        downloadUrl: "https://example.com/download",
        definitionContent: "payload",
        icon: { url: "https://icons.example.com/a.png", hash: newHash },
      });

      const svc = new ServicesService(makeController());
      await svc.updateService("alpha");

      const icon = await svc.getServiceIcon("alpha");
      expect(icon).not.toBeNull();
      expect(icon?.data.equals(PNG_ICON)).toBe(true);
      expect(icon?.mime).toBe("image/png");
      expect(icon?.hash).toBe(newHash);
      expect(await svc.getService("alpha")).toMatchObject({ hasIcon: true });
    });

    it("keeps the stored icon when the icon re-fetch fails", async () => {
      const { computeBinaryHash } = await import("@/utils/hash.util");
      const storedHash = computeBinaryHash(PNG_ICON);
      await seedService("alpha");
      await db.run(
        sql`UPDATE services SET icon_hash = ${storedHash}, icon_data = ${PNG_ICON}, icon_mime = 'image/png' WHERE id = 'alpha'`,
      );

      mockFetchRegistryWithIcon({
        registryUrl: "https://example.com/def.json",
        downloadUrl: "https://example.com/download",
        definitionContent: "payload",
        icon: {
          url: "https://icons.example.com/a.png",
          hash: "new-hash",
          error: true,
        },
      });

      const svc = new ServicesService(makeController());
      await svc.updateService("alpha");

      const icon = await svc.getServiceIcon("alpha");
      expect(icon).not.toBeNull();
      expect(icon?.data.equals(PNG_ICON)).toBe(true);
      expect(icon?.mime).toBe("image/png");
      expect(icon?.hash).toBe(storedHash);
      expect(await svc.getService("alpha")).toMatchObject({ hasIcon: true });
    });

    it("skips the definition download when only the icon changed and the registry hash matches", async () => {
      const { computeBinaryHash, computeContentHash } = await import(
        "@/utils/hash.util"
      );
      const contentHash = computeContentHash("payload");
      const newHash = computeBinaryHash(PNG_ICON);
      await seedService("alpha", { hash: contentHash });
      await db.run(
        sql`UPDATE services SET icon_hash = 'old-hash' WHERE id = 'alpha'`,
      );

      mockFetchRegistryWithIcon({
        registryUrl: "https://example.com/def.json",
        registryHash: contentHash,
        downloadUrl: "https://example.com/download",
        definitionContent: "unused",
        icon: { url: "https://icons.example.com/a.png", hash: newHash },
      });

      const svc = new ServicesService(makeController());
      await svc.updateService("alpha");

      const icon = await svc.getServiceIcon("alpha");
      expect(icon).not.toBeNull();
      expect(icon?.hash).toBe(newHash);

      const calls = vi.mocked(fetch).mock.calls.map(([input]) => String(input));
      expect(calls).toEqual([
        "https://example.com/def.json",
        "https://icons.example.com/a.png",
      ]);
    });

    it("clears the stored icon when the registry no longer declares one", async () => {
      const { computeBinaryHash } = await import("@/utils/hash.util");
      const oldHash = computeBinaryHash(PNG_ICON);
      await seedService("alpha");
      await db.run(
        sql`UPDATE services SET icon_hash = ${oldHash}, icon_data = ${PNG_ICON}, icon_mime = 'image/png' WHERE id = 'alpha'`,
      );

      mockFetchRegistryWithIcon({
        registryUrl: "https://example.com/def.json",
        downloadUrl: "https://example.com/download",
        definitionContent: "payload",
      });

      const svc = new ServicesService(makeController());
      await svc.updateService("alpha");

      expect(await svc.getServiceIcon("alpha")).toBeNull();
      expect(await svc.getService("alpha")).toMatchObject({ hasIcon: false });
    });

    it("keeps the stored icon untouched when the icon hash matches and content is unchanged", async () => {
      const { computeBinaryHash, computeContentHash } = await import(
        "@/utils/hash.util"
      );
      const iconHash = computeBinaryHash(PNG_ICON);
      const contentHash = computeContentHash("payload");
      await seedService("alpha", { hash: contentHash });
      await db.run(
        sql`UPDATE services SET icon_hash = ${iconHash}, icon_data = ${PNG_ICON}, icon_mime = 'image/png' WHERE id = 'alpha'`,
      );

      mockFetchRegistryWithIcon({
        registryUrl: "https://example.com/def.json",
        downloadUrl: "https://example.com/download",
        definitionContent: "payload",
        icon: { url: "https://icons.example.com/a.png", hash: iconHash },
      });

      const svc = new ServicesService(makeController());
      await svc.updateService("alpha");

      expect(await svc.getServiceIcon("alpha")).toMatchObject({
        mime: "image/png",
        hash: iconHash,
      });
      expect(await svc.getService("alpha")).toMatchObject({ hasIcon: true });
    });
  });

  describe("deleteService()", () => {
    it("throws 404 when the service is unknown", async () => {
      const svc = new ServicesService(makeController());
      await expect(svc.deleteService("missing")).rejects.toMatchObject({
        statusCode: 404,
      });
    });

    it("removes the row and notifies the adapter to dehydrate", async () => {
      await seedService("alpha");
      const controller = makeController();
      const svc = new ServicesService(controller);

      await svc.deleteService("alpha");
      await expect(svc.getService("alpha")).rejects.toMatchObject({
        statusCode: 404,
      });
      expect(controller.dehydrateService).toHaveBeenCalledWith(
        "test-adapter",
        "alpha",
      );
    });

    it("swallows dehydrate failures (delete still succeeds)", async () => {
      await seedService("alpha");
      const controller = makeController({
        dehydrateService: vi.fn(async () => {
          throw new Error("adapter offline");
        }),
      });
      const svc = new ServicesService(controller);

      await expect(svc.deleteService("alpha")).resolves.toBeUndefined();
    });
  });

  describe("setServiceEnabled()", () => {
    it("throws 404 when the service does not exist", async () => {
      const svc = new ServicesService(makeController());
      await expect(
        svc.setServiceEnabled({ id: "missing", enabled: true }),
      ).rejects.toMatchObject({ statusCode: 404 });
    });

    it("enables, persists, and hydrates", async () => {
      await seedService("alpha", { enabled: false });
      const controller = makeController();
      const svc = new ServicesService(controller);

      await svc.setServiceEnabled({ id: "alpha", enabled: true });

      const row = await svc.getService("alpha");
      expect(row.enabled).toBe(true);
      expect(controller.hydrateService).toHaveBeenCalledWith(
        "test-adapter",
        expect.objectContaining({ id: "alpha" }),
      );
    });

    it("rolls back the enabled flag if hydrate fails", async () => {
      await seedService("alpha", { enabled: false });
      const controller = makeController({
        hydrateService: vi.fn(async () => {
          throw new Error("adapter offline");
        }),
      });
      const svc = new ServicesService(controller);

      await expect(
        svc.setServiceEnabled({ id: "alpha", enabled: true }),
      ).rejects.toMatchObject({ statusCode: 502 });

      const row = await svc.getService("alpha");
      expect(row.enabled).toBe(false);
    });

    it("disables and calls dehydrate", async () => {
      await seedService("alpha", { enabled: true });
      const controller = makeController();
      const svc = new ServicesService(controller);

      await svc.setServiceEnabled({ id: "alpha", enabled: false });

      const row = await svc.getService("alpha");
      expect(row.enabled).toBe(false);
      expect(controller.dehydrateService).toHaveBeenCalledWith(
        "test-adapter",
        "alpha",
      );
    });
  });

  describe("setToolEnabled()", () => {
    it("throws 404 when the tool is missing", async () => {
      await seedService("alpha");
      const svc = new ServicesService(makeController());
      await expect(
        svc.setToolEnabled({
          serviceId: "alpha",
          toolId: "ghost",
          enabled: true,
        }),
      ).rejects.toMatchObject({ statusCode: 404 });
    });

    it("toggles the stored flag", async () => {
      await seedService("alpha", {
        tools: [{ id: "x", name: "x", enabled: true }],
      });
      const svc = new ServicesService(makeController());

      await svc.setToolEnabled({
        serviceId: "alpha",
        toolId: "x",
        enabled: false,
      });

      const tools = await svc.listTools({ serviceId: "alpha" });
      expect(tools[0]?.enabled).toBe(false);
    });

    it("targets by tool id, not name", async () => {
      await seedService("alpha", {
        tools: [
          { id: "do_stuff", name: "Do Stuff", enabled: true },
          { id: "other", name: "Other", enabled: true },
        ],
      });
      const svc = new ServicesService(makeController());

      await svc.setToolEnabled({
        serviceId: "alpha",
        toolId: "do_stuff",
        enabled: false,
      });

      const rows = await svc.listTools({ serviceId: "alpha" });
      const byId = Object.fromEntries(rows.map((r) => [r.id, r.enabled]));
      expect(byId).toEqual({ do_stuff: false, other: true });

      await expect(
        svc.setToolEnabled({
          serviceId: "alpha",
          toolId: "Do Stuff",
          enabled: false,
        }),
      ).rejects.toMatchObject({ statusCode: 404 });
    });
  });

  describe("config + secrets", () => {
    it("getServiceConfig returns {} when no payload exists", async () => {
      await seedService("alpha");
      const svc = new ServicesService(makeController());
      expect(await svc.getServiceConfig("alpha")).toEqual({});
    });

    it("patchServiceConfig applies a JSON Patch and persists the result", async () => {
      await seedService("alpha", {
        configSchema: {
          type: "object",
          properties: { host: { type: "string" } },
          additionalProperties: false,
        },
      });
      const svc = new ServicesService(makeController());

      await svc.patchServiceConfig({
        id: "alpha",
        patch: [{ op: "add", path: "/host", value: "example.com" }],
      });

      expect(await svc.getServiceConfig("alpha")).toEqual({
        host: "example.com",
      });
    });

    it("patchServiceConfig rejects an invalid JSON Patch payload", async () => {
      await seedService("alpha");
      const svc = new ServicesService(makeController());

      await expect(
        svc.patchServiceConfig({
          id: "alpha",
          patch: [{ op: "replace", path: "/missing", value: 1 }],
        }),
      ).rejects.toMatchObject({ statusCode: 400 });
    });

    it("patchServiceConfig validates against the configSchema", async () => {
      await seedService("alpha", {
        configSchema: {
          type: "object",
          properties: { port: { type: "integer", minimum: 1 } },
          required: ["port"],
          additionalProperties: false,
        },
      });
      const svc = new ServicesService(makeController());

      await expect(
        svc.patchServiceConfig({
          id: "alpha",
          patch: [{ op: "add", path: "/port", value: -1 }],
        }),
      ).rejects.toMatchObject({ statusCode: 400 });
    });

    it("patchServiceConfig hydrates the service when it is enabled", async () => {
      await seedService("alpha", {
        enabled: true,
        configSchema: { type: "object", additionalProperties: true },
      });
      const controller = makeController();
      const svc = new ServicesService(controller);

      await svc.patchServiceConfig({
        id: "alpha",
        patch: [{ op: "add", path: "/x", value: 1 }],
      });
      expect(controller.hydrateService).toHaveBeenCalledWith(
        "test-adapter",
        expect.objectContaining({ id: "alpha" }),
      );
    });

    it("patchServiceConfig does NOT hydrate when the service is disabled", async () => {
      await seedService("alpha", {
        enabled: false,
        configSchema: { type: "object", additionalProperties: true },
      });
      const controller = makeController();
      const svc = new ServicesService(controller);

      await svc.patchServiceConfig({
        id: "alpha",
        patch: [{ op: "add", path: "/x", value: 1 }],
      });
      expect(controller.hydrateService).not.toHaveBeenCalled();
    });

    it("patchServiceConfig succeeds on a null-only configSchema because the null-only escape hatch runs before validation", async () => {
      await seedService("alpha", {
        configSchema: { type: "null" },
      });
      const svc = new ServicesService(makeController());

      await expect(
        svc.patchServiceConfig({ id: "alpha", patch: [] }),
      ).resolves.toEqual({ config: {}, outdated: [] });
    });

    it("patchServiceConfig rejects a patch that turns the payload into a non-object", async () => {
      await seedService("alpha", {
        configSchema: { type: "null" },
      });
      const svc = new ServicesService(makeController());

      await expect(
        svc.patchServiceConfig({
          id: "alpha",
          patch: [{ op: "replace", path: "", value: "not-an-object" }],
        }),
      ).rejects.toMatchObject({ statusCode: 400 });

      await expect(
        svc.patchServiceConfig({
          id: "alpha",
          patch: [{ op: "replace", path: "", value: [1, 2, 3] }],
        }),
      ).rejects.toMatchObject({ statusCode: 400 });
    });

    it("patchServiceSecrets encrypts and persists the result", async () => {
      await seedService("alpha", {
        secretsSchema: {
          type: "object",
          properties: { token: { type: "string" } },
          additionalProperties: false,
        },
      });
      const svc = new ServicesService(makeController());

      await svc.patchServiceSecrets({
        id: "alpha",
        patch: [{ op: "add", path: "/token", value: "abc" }],
      });

      const row = await db.run(
        sql`SELECT payload FROM service_secrets WHERE service_id = 'alpha'`,
      );
      const stored = row.rows?.[0]?.[0];
      expect(typeof stored).toBe("string");
      const parsed = JSON.parse(stored as string);
      expect(parsed.alg).toBe("aes-256-gcm");
      expect(parsed.ciphertext).toBeTypeOf("string");
    });

    it("patchServiceSecrets rejects a patch that turns the payload into a non-object", async () => {
      await seedService("alpha");
      const svc = new ServicesService(makeController());

      await expect(
        svc.patchServiceSecrets({
          id: "alpha",
          patch: [{ op: "replace", path: "", value: "not-an-object" }],
        }),
      ).rejects.toMatchObject({ statusCode: 400 });
    });

    it("getServiceConfigSchema/getServiceSecretsSchema throw 404 for unknown services", async () => {
      const svc = new ServicesService(makeController());
      await expect(svc.getServiceConfigSchema("ghost")).rejects.toMatchObject({
        statusCode: 404,
      });
      await expect(svc.getServiceSecretsSchema("ghost")).rejects.toMatchObject({
        statusCode: 404,
      });
    });

    it("loadServiceSecrets surfaces malformed payloads as 500 via the enabled flow", async () => {
      await seedService("alpha", { enabled: false });
      await db.run(
        sql`INSERT INTO service_secrets (service_id, payload, updated_at)
            VALUES ('alpha', ${JSON.stringify({ bogus: true })}, ${Date.now()})`,
      );
      const svc = new ServicesService(makeController());

      await expect(
        svc.setServiceEnabled({ id: "alpha", enabled: true }),
      ).rejects.toMatchObject({ statusCode: 500 });
    });

    it("loadServiceSecrets decrypts round-tripped payloads when enabling", async () => {
      const encrypted = encryptSecrets({ token: "abc" });
      await seedService("alpha", {
        enabled: false,
        secretsSchema: { type: "object", additionalProperties: true },
      });
      await db.run(
        sql`INSERT INTO service_secrets (service_id, payload, updated_at)
            VALUES ('alpha', ${JSON.stringify(encrypted)}, ${Date.now()})`,
      );
      const controller = makeController();
      const svc = new ServicesService(controller);

      await svc.setServiceEnabled({ id: "alpha", enabled: true });
      expect(controller.hydrateService).toHaveBeenCalledWith(
        "test-adapter",
        expect.objectContaining({
          secrets: { token: "abc" },
        }),
      );
    });

    it("getServiceSecretsPresence returns empty present and outdated arrays when no secrets are stored", async () => {
      await seedService("alpha");
      const svc = new ServicesService(makeController());

      const result = await svc.getServiceSecretsPresence("alpha");
      expect(result).toEqual({ present: [], outdated: [] });
    });

    it("getServiceSecretsPresence returns paths for flat string secrets", async () => {
      await seedService("alpha", {
        secretsSchema: { type: "object", additionalProperties: true },
      });
      const encrypted = encryptSecrets({
        apiKey: "sk-abc",
        endpoint: "https://example.com",
      });
      await db.run(
        sql`INSERT INTO service_secrets (service_id, payload, updated_at)
            VALUES ('alpha', ${JSON.stringify(encrypted)}, ${Date.now()})`,
      );
      const svc = new ServicesService(makeController());

      const result = await svc.getServiceSecretsPresence("alpha");
      expect(result.present.sort()).toEqual(["/apiKey", "/endpoint"]);
      expect(result.outdated).toEqual([]);
    });

    it("getServiceSecretsPresence returns paths for nested object secrets", async () => {
      await seedService("alpha", {
        secretsSchema: { type: "object", additionalProperties: true },
      });
      const encrypted = encryptSecrets({
        myBasic: { username: "admin", password: "hunter2" },
      });
      await db.run(
        sql`INSERT INTO service_secrets (service_id, payload, updated_at)
            VALUES ('alpha', ${JSON.stringify(encrypted)}, ${Date.now()})`,
      );
      const svc = new ServicesService(makeController());

      const result = await svc.getServiceSecretsPresence("alpha");
      expect(result.present.sort()).toEqual([
        "/myBasic/password",
        "/myBasic/username",
      ]);
    });

    it("getServiceSecretsPresence returns path for non-empty array secrets", async () => {
      await seedService("alpha", {
        secretsSchema: { type: "object", additionalProperties: true },
      });
      const encrypted = encryptSecrets({ apiKeys: ["key1", "key2"] });
      await db.run(
        sql`INSERT INTO service_secrets (service_id, payload, updated_at)
            VALUES ('alpha', ${JSON.stringify(encrypted)}, ${Date.now()})`,
      );
      const svc = new ServicesService(makeController());

      const result = await svc.getServiceSecretsPresence("alpha");
      expect(result.present).toEqual(["/apiKeys"]);
    });
  });

  describe("schema-outdated stored payloads", () => {
    const strictConfigSchema: JSONSchema = {
      type: "object",
      properties: { host: { type: "string" } },
      additionalProperties: false,
    };
    const strictSecretsSchema: JSONSchema = {
      type: "object",
      properties: { token: { type: "string" } },
      additionalProperties: false,
    };

    async function seedStaleConfig(
      id: string,
      configSchema: JSONSchema = strictConfigSchema,
    ): Promise<void> {
      await seedService(id, { configSchema, enabled: false });
      await db.run(
        sql`INSERT INTO service_configurations (service_id, payload, updated_at)
            VALUES (${id}, ${JSON.stringify({
              host: "example.com",
              stalePort: 9999,
            })}, ${Date.now()})`,
      );
    }

    async function seedStaleSecrets(id: string): Promise<void> {
      await seedService(id, { secretsSchema: strictSecretsSchema });
      const encrypted = encryptSecrets({ token: "abc", oldKey: "x" });
      await db.run(
        sql`INSERT INTO service_secrets (service_id, payload, updated_at)
            VALUES (${id}, ${JSON.stringify(encrypted)}, ${Date.now()})`,
      );
    }

    it("getServiceConfigView filters outdated keys and reports them", async () => {
      await seedStaleConfig("alpha");
      const svc = new ServicesService(makeController());

      const view = await svc.getServiceConfigView("alpha");
      expect(view).toEqual({
        config: { host: "example.com" },
        outdated: ["/stalePort"],
      });
    });

    it("getServiceSecretsPresence reports outdated secrets keys", async () => {
      await seedStaleSecrets("alpha");
      const svc = new ServicesService(makeController());

      const result = await svc.getServiceSecretsPresence("alpha");
      expect(result).toEqual({ present: ["/token"], outdated: ["/oldKey"] });
    });

    it("setServiceEnabled succeeds with outdated stored keys and hydrates a conformant state", async () => {
      await seedStaleConfig("alpha");
      const controller = makeController();
      const svc = new ServicesService(controller);

      await svc.setServiceEnabled({ id: "alpha", enabled: true });

      const state = controller.hydrateService.mock.calls[0][1] as ServiceState;
      expect(state.config).toEqual({ host: "example.com" });
    });

    it("setServiceEnabled keeps permissive keys in the hydrated state", async () => {
      await seedService("alpha", {
        enabled: false,
        configSchema: { type: "object", additionalProperties: true },
      });
      await db.run(
        sql`INSERT INTO service_configurations (service_id, payload, updated_at)
            VALUES ('alpha', ${JSON.stringify({ anyKey: 1 })}, ${Date.now()})`,
      );
      const controller = makeController();
      const svc = new ServicesService(controller);

      await svc.setServiceEnabled({ id: "alpha", enabled: true });

      const state = controller.hydrateService.mock.calls[0][1] as ServiceState;
      expect(state.config).toEqual({ anyKey: 1 });
    });

    it("patchServiceConfig tolerates pre-existing outdated keys and preserves them", async () => {
      await seedStaleConfig("alpha");
      const svc = new ServicesService(makeController());

      const view = await svc.patchServiceConfig({
        id: "alpha",
        patch: [{ op: "replace", path: "/host", value: "new.example.com" }],
      });

      expect(view).toEqual({
        config: { host: "new.example.com" },
        outdated: ["/stalePort"],
      });
      expect(await svc.getServiceConfig("alpha")).toEqual({
        host: "new.example.com",
        stalePort: 9999,
      });
    });

    it("patchServiceConfig on a null-only schema keeps the updated non-empty config and reports no outdated paths", async () => {
      await seedStaleConfig("alpha", { type: "null" });
      const svc = new ServicesService(makeController());

      const view = await svc.patchServiceConfig({
        id: "alpha",
        patch: [{ op: "replace", path: "/host", value: "new.example.com" }],
      });

      expect(view).toEqual({
        config: { host: "new.example.com", stalePort: 9999 },
        outdated: [],
      });
      expect(await svc.getServiceConfig("alpha")).toEqual({
        host: "new.example.com",
        stalePort: 9999,
      });
    });

    it("patchServiceConfig rejects adding new schema-disallowed keys", async () => {
      await seedStaleConfig("alpha");
      const svc = new ServicesService(makeController());

      await expect(
        svc.patchServiceConfig({
          id: "alpha",
          patch: [{ op: "add", path: "/freshStale", value: 1 }],
        }),
      ).rejects.toMatchObject({ statusCode: 400 });
    });

    it("patchServiceConfig treats removes of missing paths as no-ops", async () => {
      await seedStaleConfig("alpha");
      const svc = new ServicesService(makeController());

      const view = await svc.patchServiceConfig({
        id: "alpha",
        patch: [
          { op: "remove", path: "/host" },
          { op: "remove", path: "/missing" },
        ],
      });

      expect(view).toEqual({ config: {}, outdated: ["/stalePort"] });
      expect(await svc.getServiceConfig("alpha")).toEqual({
        stalePort: 9999,
      });
    });

    it("patchServiceSecrets tolerates and preserves pre-existing outdated secrets keys", async () => {
      await seedStaleSecrets("alpha");
      const svc = new ServicesService(makeController());

      await svc.patchServiceSecrets({
        id: "alpha",
        patch: [{ op: "replace", path: "/token", value: "def" }],
      });

      expect(await svc.getServiceSecretsPresence("alpha")).toEqual({
        present: ["/token"],
        outdated: ["/oldKey"],
      });
    });

    it("patchServiceSecrets rejects adding new schema-disallowed keys", async () => {
      await seedStaleSecrets("alpha");
      const svc = new ServicesService(makeController());

      await expect(
        svc.patchServiceSecrets({
          id: "alpha",
          patch: [{ op: "add", path: "/freshStale", value: 1 }],
        }),
      ).rejects.toMatchObject({ statusCode: 400 });
    });

    it("patchServiceSecrets treats removes of missing paths as no-ops", async () => {
      await seedStaleSecrets("alpha");
      const svc = new ServicesService(makeController());

      await svc.patchServiceSecrets({
        id: "alpha",
        patch: [
          { op: "remove", path: "/token" },
          { op: "remove", path: "/missing" },
        ],
      });

      expect(await svc.getServiceSecretsPresence("alpha")).toEqual({
        present: [],
        outdated: ["/oldKey"],
      });
    });
  });

  describe("downloadDefinition (via createService)", () => {
    it("rejects non-OK responses with 502", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response("nope", { status: 500 })),
      );
      const svc = new ServicesService(makeController());

      await expect(
        svc.createServiceDirect({
          id: "alpha",
          url: "https://example.com/def.json",
          adapter: "test-adapter",
        }),
      ).rejects.toMatchObject({ statusCode: 502 });
    });

    it("rejects payloads that exceed the size limit while streaming with 413", async () => {
      const big = Buffer.alloc(31 * 1024 * 1024, "x").toString();
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response(big, { status: 200 })),
      );
      const svc = new ServicesService(makeController());

      await expect(
        svc.createServiceDirect({
          id: "alpha",
          url: "https://example.com/def.json",
          adapter: "test-adapter",
        }),
      ).rejects.toMatchObject({ statusCode: 413 });
    });

    it("translates fetch errors to 502", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => {
          throw new Error("DNS failure");
        }),
      );
      const svc = new ServicesService(makeController());

      await expect(
        svc.createServiceDirect({
          id: "alpha",
          url: "https://example.com/def.json",
          adapter: "test-adapter",
        }),
      ).rejects.toMatchObject({ statusCode: 502 });
    });

    it("SSRF check does not block loopback hosts (this asserts the fix; will fail until assertRegistryAddressAllowed is corrected)", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response("payload", { status: 200 })),
      );
      const svc = new ServicesService(makeController());

      await expect(
        svc.createServiceDirect({
          id: "alpha",
          url: "http://127.0.0.1/def.json",
          adapter: "test-adapter",
        }),
      ).rejects.toMatchObject({ statusCode: 502 });
    });

    it("SSRF check does not block AWS metadata IP (will fail until fixed)", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response("payload", { status: 200 })),
      );
      const svc = new ServicesService(makeController());

      await expect(
        svc.createServiceDirect({
          id: "alpha",
          url: "http://169.254.169.254/latest/meta-data/",
          adapter: "test-adapter",
        }),
      ).rejects.toMatchObject({ statusCode: 502 });
    });

    it("SSRF check does not block private RFC1918 hosts (will fail until fixed)", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response("payload", { status: 200 })),
      );
      const svc = new ServicesService(makeController());

      await expect(
        svc.createServiceDirect({
          id: "alpha",
          url: "http://10.0.0.1/def.json",
          adapter: "test-adapter",
        }),
      ).rejects.toMatchObject({ statusCode: 502 });
    });

    it("blocks hostnames that resolve to a loopback address", async () => {
      vi.spyOn(dns, "lookup").mockResolvedValue([
        { address: "127.0.0.1", family: 4 },
      ] as never);
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response("payload", { status: 200 })),
      );
      const svc = new ServicesService(makeController());

      await expect(
        svc.createServiceDirect({
          id: "alpha",
          url: "http://internal.corp/def.json",
          adapter: "test-adapter",
        }),
      ).rejects.toMatchObject({ statusCode: 502 });
    });

    it("blocks hostnames where any resolved address is private", async () => {
      vi.spyOn(dns, "lookup").mockResolvedValue([
        { address: "93.184.216.34", family: 4 },
        { address: "10.0.0.5", family: 4 },
      ] as never);
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response("payload", { status: 200 })),
      );
      const svc = new ServicesService(makeController());

      await expect(
        svc.createServiceDirect({
          id: "alpha",
          url: "http://mixed.example.com/def.json",
          adapter: "test-adapter",
        }),
      ).rejects.toMatchObject({ statusCode: 502 });
    });

    it("returns 502 when DNS resolution fails", async () => {
      vi.spyOn(dns, "lookup").mockRejectedValue(
        Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" }),
      );
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response("payload", { status: 200 })),
      );
      const svc = new ServicesService(makeController());

      await expect(
        svc.createServiceDirect({
          id: "alpha",
          url: "http://nope.invalid/def.json",
          adapter: "test-adapter",
        }),
      ).rejects.toMatchObject({ statusCode: 502 });
    });

    it("allows private addresses in CYRNEL_REGISTRY_ALLOWED_IPS", async () => {
      vi.stubEnv("CYRNEL_REGISTRY_ALLOWED_IPS", "10.0.0.0/8");
      mockFetchOnce("payload");
      const svc = new ServicesService(makeController());

      await expect(
        svc.createServiceDirect({
          id: "alpha",
          url: "http://10.0.0.1/def.json",
          adapter: "test-adapter",
        }),
      ).resolves.toBeUndefined();
    });

    it("allows resolving hostnames to private IPs in CYRNEL_REGISTRY_ALLOWED_IPS", async () => {
      vi.stubEnv("CYRNEL_REGISTRY_ALLOWED_IPS", "127.0.0.1/32");
      vi.spyOn(dns, "lookup").mockResolvedValue([
        { address: "127.0.0.1", family: 4 },
      ] as never);
      mockFetchOnce("payload");
      const svc = new ServicesService(makeController());

      await expect(
        svc.createServiceDirect({
          id: "beta",
          url: "http://internal.corp/def.json",
          adapter: "test-adapter",
        }),
      ).resolves.toBeUndefined();
    });

    it("blocks a redirect from a public host to a loopback IP", async () => {
      const fetchMock = vi.fn(async (input: string | URL) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url === "https://example.com/def.json") {
          return new Response(null, {
            status: 302,
            headers: { location: "http://127.0.0.1/secret" },
          });
        }
        return new Response("payload", { status: 200 });
      });
      vi.stubGlobal("fetch", fetchMock);
      const svc = new ServicesService(makeController());

      await expect(
        svc.createServiceDirect({
          id: "alpha",
          url: "https://example.com/def.json",
          adapter: "test-adapter",
        }),
      ).rejects.toMatchObject({ statusCode: 502 });

      const calls = fetchMock.mock.calls.map((c) =>
        typeof c[0] === "string" ? c[0] : c[0].toString(),
      );
      expect(calls).toContain("https://example.com/def.json");
      expect(calls).not.toContain("http://127.0.0.1/secret");
    });

    it("blocks a redirect that resolves to a private IP via DNS", async () => {
      vi.spyOn(dns, "lookup").mockImplementation(async (host) => {
        if (host === "evil.example.com") {
          return [{ address: "10.0.0.5", family: 4 }] as never;
        }
        return [{ address: "93.184.216.34", family: 4 }] as never;
      });

      const fetchMock = vi.fn(async (input: string | URL) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url === "https://example.com/def.json") {
          return new Response(null, {
            status: 302,
            headers: { location: "https://evil.example.com/secret" },
          });
        }
        return new Response("payload", { status: 200 });
      });
      vi.stubGlobal("fetch", fetchMock);
      const svc = new ServicesService(makeController());

      await expect(
        svc.createServiceDirect({
          id: "alpha",
          url: "https://example.com/def.json",
          adapter: "test-adapter",
        }),
      ).rejects.toMatchObject({ statusCode: 502 });

      const calls = fetchMock.mock.calls.map((c) =>
        typeof c[0] === "string" ? c[0] : c[0].toString(),
      );
      expect(calls).not.toContain("https://evil.example.com/secret");
    });

    it("follows a redirect to a public host and downloads from the final URL", async () => {
      const fetchMock = vi.fn(async (input: string | URL) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url === "https://example.com/def.json") {
          return new Response(null, {
            status: 302,
            headers: { location: "https://example.com/final.json" },
          });
        }
        return new Response("payload", { status: 200 });
      });
      vi.stubGlobal("fetch", fetchMock);
      const svc = new ServicesService(makeController());

      await expect(
        svc.createServiceDirect({
          id: "alpha",
          url: "https://example.com/def.json",
          adapter: "test-adapter",
        }),
      ).resolves.toBeUndefined();

      const calls = fetchMock.mock.calls.map((c) =>
        typeof c[0] === "string" ? c[0] : c[0].toString(),
      );
      expect(calls).toContain("https://example.com/def.json");
      expect(calls).toContain("https://example.com/final.json");
    });

    it("rejects redirect chains that exceed the maximum hop count", async () => {
      const fetchMock = vi.fn(async (input: string | URL) => {
        const url = typeof input === "string" ? input : input.toString();
        const match = url.match(/redirect-(\d+)\.json$/);
        const n = match ? Number(match[1]) : 0;
        return new Response(null, {
          status: 302,
          headers: { location: `https://example.com/redirect-${n + 1}.json` },
        });
      });
      vi.stubGlobal("fetch", fetchMock);
      const svc = new ServicesService(makeController());

      await expect(
        svc.createServiceDirect({
          id: "alpha",
          url: "https://example.com/redirect-0.json",
          adapter: "test-adapter",
        }),
      ).rejects.toMatchObject({ statusCode: 502 });
    });

    it("rejects a redirect that has no Location header", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response(null, { status: 302 })),
      );
      const svc = new ServicesService(makeController());

      await expect(
        svc.createServiceDirect({
          id: "alpha",
          url: "https://example.com/def.json",
          adapter: "test-adapter",
        }),
      ).rejects.toMatchObject({ statusCode: 502 });
    });
  });

  describe("hydrateAdapter()", () => {
    it("hydrates every enabled service for the adapter", async () => {
      await seedService("a", { enabled: true });
      await seedService("b", { enabled: true });
      await seedService("c", { enabled: false });
      const controller = makeController();
      const svc = new ServicesService(controller);

      await svc.hydrateAdapter("test-adapter");

      const hydrated = controller.hydrateService.mock.calls.map(
        ([, state]) => (state as ServiceState).id,
      );
      expect(hydrated.sort()).toEqual(["a", "b"]);
    });

    it("tolerates per-service hydrate failures", async () => {
      await seedService("a", { enabled: true });
      await seedService("b", { enabled: true });
      const controller = makeController({
        hydrateService: vi.fn(async (_id, state) => {
          if ((state as ServiceState).id === "a")
            throw new Error("adapter rejected a");
        }),
      });
      const svc = new ServicesService(controller);

      await expect(svc.hydrateAdapter("test-adapter")).resolves.toBeUndefined();
    });
  });
});
