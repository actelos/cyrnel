import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const importIndex = async () => await import("@/index");

describe("createModuleRegistry", () => {
  let dir: string | undefined;

  afterEach(async () => {
    vi.resetModules();
    if (!dir) return;
    await rm(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it("loads manifests from top-level module directories and adds builtins", async () => {
    dir = await mkdtemp(join(tmpdir(), "mci-core-loader-"));

    await mkdir(join(dir, "mod-one"));
    await writeFile(
      join(dir, "mod-one", "module.json"),
      JSON.stringify({
        name: "mod-one",
        version: "0.1.0",
        description: "one",
        type: "adapter",
        main: "main.ts",
      }),
      "utf8",
    );

    await mkdir(join(dir, "mod-two"));
    await writeFile(
      join(dir, "mod-two", "module.json"),
      JSON.stringify({
        name: "mod-two",
        version: "0.2.0",
        description: "two",
        type: "environment",
        main: "main.ts",
      }),
      "utf8",
    );

    const { createModuleRegistry } = await importIndex();
    const registry = await createModuleRegistry(dir);
    const manifests = registry.listManifests();

    expect(manifests.map((m) => m.name).sort()).toEqual(
      ["mod-one", "mod-two"].sort(),
    );
    expect(registry.getManifest("mod-one")?.isBuiltin).toBe(false);
    expect(registry.getManifest("mod-two")?.name).toBe("mod-two");
  });

  it("skips top-level directories without a module.json", async () => {
    dir = await mkdtemp(join(tmpdir(), "mci-core-loader-"));

    await mkdir(join(dir, "not-a-module"));

    const { createModuleRegistry } = await importIndex();
    const registry = await createModuleRegistry(dir);
    expect(registry.listManifests()).toEqual([]);
  });

  it("throws when module.json does not match schema", async () => {
    dir = await mkdtemp(join(tmpdir(), "mci-core-loader-"));

    await mkdir(join(dir, "bad-module"));
    await writeFile(
      join(dir, "bad-module", "module.json"),
      JSON.stringify({
        name: "bad-module",
        version: "0.0.1",
      }),
      "utf8",
    );

    const { createModuleRegistry } = await importIndex();
    await expect(createModuleRegistry(dir)).rejects.toThrow(/bad-module/);
  });

  it("throws on duplicate manifest names among custom modules", async () => {
    dir = await mkdtemp(join(tmpdir(), "mci-core-loader-"));

    await mkdir(join(dir, "a"));
    await writeFile(
      join(dir, "a", "module.json"),
      JSON.stringify({
        name: "dup",
        version: "9.9.9",
        description: "first",
        type: "adapter",
        main: "main.ts",
      }),
      "utf8",
    );

    await mkdir(join(dir, "b"));
    await writeFile(
      join(dir, "b", "module.json"),
      JSON.stringify({
        name: "dup",
        version: "9.9.8",
        description: "second",
        type: "adapter",
        main: "main.ts",
      }),
      "utf8",
    );

    const { createModuleRegistry } = await importIndex();
    await expect(createModuleRegistry(dir)).rejects.toThrow(/duplicate/i);
  });

  it("lists manifests filtered by type", async () => {
    dir = await mkdtemp(join(tmpdir(), "mci-core-loader-"));

    await mkdir(join(dir, "mod-one"));
    await writeFile(
      join(dir, "mod-one", "module.json"),
      JSON.stringify({
        name: "mod-one",
        version: "0.1.0",
        description: "one",
        type: "adapter",
        main: "main.ts",
      }),
      "utf8",
    );

    await mkdir(join(dir, "mod-two"));
    await writeFile(
      join(dir, "mod-two", "module.json"),
      JSON.stringify({
        name: "mod-two",
        version: "0.2.0",
        description: "two",
        type: "environment",
        main: "main.ts",
      }),
      "utf8",
    );

    const { createModuleRegistry } = await importIndex();
    const registry = await createModuleRegistry(dir);
    expect(
      registry.listManifests({ type: "adapter" }).map((m) => m.name),
    ).toEqual(["mod-one"]);
    expect(
      registry.listManifests({ type: "environment" }).map((m) => m.name),
    ).toEqual(["mod-two"]);
  });

  it("lists manifests filtered by query (name/description)", async () => {
    dir = await mkdtemp(join(tmpdir(), "mci-core-loader-"));

    await mkdir(join(dir, "alpha"));
    await writeFile(
      join(dir, "alpha", "module.json"),
      JSON.stringify({
        name: "alpha",
        version: "0.1.0",
        description: "Hello World",
        type: "adapter",
        main: "main.ts",
      }),
      "utf8",
    );

    await mkdir(join(dir, "beta"));
    await writeFile(
      join(dir, "beta", "module.json"),
      JSON.stringify({
        name: "beta",
        version: "0.2.0",
        description: "Something else",
        type: "adapter",
        main: "main.ts",
      }),
      "utf8",
    );

    const { createModuleRegistry } = await importIndex();
    const registry = await createModuleRegistry(dir);
    expect(
      registry.listManifests({ query: "world" }).map((m) => m.name),
    ).toEqual(["alpha"]);
    expect(registry.listManifests({ query: "bet" }).map((m) => m.name)).toEqual(
      ["beta"],
    );
  });
});

describe("createModuleRegistry with builtins", () => {
  let dir: string | undefined;
  const environmentBindings = {} as any;

  afterEach(async () => {
    vi.resetModules();
    if (!dir) return;
    await rm(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it("detects collisions between builtins and custom modules", async () => {
    vi.doMock("./builtins", () => ({
      builtinModules: [
        {
          manifest: {
            name: "builtin-x",
            version: "1.0.0",
            description: "builtin",
            type: "adapter",
            main: "index.js",
            isBuiltin: true,
          },
          instantiate: () => ({ type: "adapter" }),
        },
      ],
    }));

    dir = await mkdtemp(join(tmpdir(), "mci-core-loader-"));
    await mkdir(join(dir, "builtin-x"));
    await writeFile(
      join(dir, "builtin-x", "module.json"),
      JSON.stringify({
        name: "builtin-x",
        version: "2.0.0",
        description: "custom collision",
        type: "adapter",
        main: "main.ts",
      }),
      "utf8",
    );

    const { createModuleRegistry } = await import("./index");
    await expect(createModuleRegistry(dir)).rejects.toThrow(/duplicate/i);
  });

  it("lists manifests filtered by isBuiltin", async () => {
    vi.doMock("./builtins", () => ({
      builtinModules: [
        {
          manifest: {
            name: "builtin-x",
            version: "1.0.0",
            description: "builtin",
            type: "adapter",
            main: "index.js",
            isBuiltin: true,
          },
          instantiate: () => ({ type: "adapter" }),
        },
      ],
    }));

    dir = await mkdtemp(join(tmpdir(), "mci-core-loader-"));
    await mkdir(join(dir, "custom-y"));
    await writeFile(
      join(dir, "custom-y", "module.json"),
      JSON.stringify({
        name: "custom-y",
        version: "2.0.0",
        description: "custom",
        type: "adapter",
        main: "main.ts",
      }),
      "utf8",
    );

    const { createModuleRegistry } = await import("./index");
    const registry = await createModuleRegistry(dir, { environmentBindings });
    expect(
      registry.listManifests({ isBuiltin: true }).map((m) => m.name),
    ).toEqual(["builtin-x"]);
    expect(
      registry.listManifests({ isBuiltin: false }).map((m) => m.name),
    ).toEqual(["custom-y"]);
  });

  it("activates a builtin module only once", async () => {
    let instantiations = 0;
    vi.doMock("./builtins", () => ({
      builtinModules: [
        {
          manifest: {
            name: "builtin-x",
            version: "1.0.0",
            description: "builtin",
            type: "adapter",
            main: "index.js",
            isBuiltin: true,
          },
          instantiate: () => {
            instantiations += 1;
            return { type: "adapter" };
          },
        },
      ],
    }));

    dir = await mkdtemp(join(tmpdir(), "mci-core-loader-"));

    const { createModuleRegistry } = await import("./index");
    const registry = await createModuleRegistry(dir, { environmentBindings });
    await registry.activate("builtin-x", {});
    await registry.activate("builtin-x", {});

    expect(instantiations).toBe(1);
  });

  it("allows multiple active adapters but only one active environment", async () => {
    const instantiated: string[] = [];
    vi.doMock("./builtins", () => ({
      builtinModules: [
        {
          manifest: {
            name: "adapter-a",
            version: "1.0.0",
            description: "adapter a",
            type: "adapter",
            main: "index.js",
            isBuiltin: true,
          },
          instantiate: () => {
            instantiated.push("adapter-a");
            return { type: "adapter" };
          },
        },
        {
          manifest: {
            name: "adapter-b",
            version: "1.0.0",
            description: "adapter b",
            type: "adapter",
            main: "index.js",
            isBuiltin: true,
          },
          instantiate: () => {
            instantiated.push("adapter-b");
            return { type: "adapter" };
          },
        },
        {
          manifest: {
            name: "env-x",
            version: "1.0.0",
            description: "env x",
            type: "environment",
            main: "index.js",
            isBuiltin: true,
          },
          instantiate: () => {
            instantiated.push("env-x");
            return { type: "environment" };
          },
        },
        {
          manifest: {
            name: "env-y",
            version: "1.0.0",
            description: "env y",
            type: "environment",
            main: "index.js",
            isBuiltin: true,
          },
          instantiate: () => {
            instantiated.push("env-y");
            return { type: "environment" };
          },
        },
      ],
    }));

    dir = await mkdtemp(join(tmpdir(), "mci-core-loader-"));

    const { createModuleRegistry } = await import("./index");
    const registry = await createModuleRegistry(dir, { environmentBindings });

    await registry.activate("adapter-a", {});
    await registry.activate("adapter-b", {});
    expect(instantiated).toEqual(["adapter-a", "adapter-b"]);

    await registry.activate("env-x", {});
    await registry.activate("env-x", {});
    expect(instantiated).toEqual(["adapter-a", "adapter-b", "env-x"]);

    await expect(registry.activate("env-y", {})).rejects.toThrow(/already active/i);
  });

  it("deactivates modules immediately and allows switching environments", async () => {
    const instantiated: string[] = [];
    vi.doMock("./builtins", () => ({
      builtinModules: [
        {
          manifest: {
            name: "adapter-a",
            version: "1.0.0",
            description: "adapter a",
            type: "adapter",
            main: "index.js",
            isBuiltin: true,
          },
          instantiate: () => {
            instantiated.push("adapter-a");
            return { type: "adapter" };
          },
        },
        {
          manifest: {
            name: "env-x",
            version: "1.0.0",
            description: "env x",
            type: "environment",
            main: "index.js",
            isBuiltin: true,
          },
          instantiate: () => {
            instantiated.push("env-x");
            return { type: "environment" };
          },
        },
        {
          manifest: {
            name: "env-y",
            version: "1.0.0",
            description: "env y",
            type: "environment",
            main: "index.js",
            isBuiltin: true,
          },
          instantiate: () => {
            instantiated.push("env-y");
            return { type: "environment" };
          },
        },
      ],
    }));

    dir = await mkdtemp(join(tmpdir(), "mci-core-loader-"));

    const { createModuleRegistry } = await import("./index");
    const registry = await createModuleRegistry(dir, { environmentBindings });

    await registry.activate("adapter-a", {});
    await registry.deactivate("adapter-a");
    await registry.activate("adapter-a", {});

    await registry.activate("env-x", {});
    await registry.deactivate("env-x");
    await registry.activate("env-y", {});
    expect(instantiated).toEqual(["adapter-a", "adapter-a", "env-x", "env-y"]);
  });

  it("runs setup on activate and teardown on deactivate", async () => {
    const setup = vi.fn().mockResolvedValue(undefined);
    const teardown = vi.fn().mockResolvedValue(undefined);

    vi.doMock("./builtins", () => ({
      builtinModules: [
        {
          manifest: {
            name: "adapter-a",
            version: "1.0.0",
            description: "adapter a",
            type: "adapter",
            main: "index.js",
            isBuiltin: true,
          },
          instantiate: () => ({ setup, teardown }),
        },
      ],
    }));

    dir = await mkdtemp(join(tmpdir(), "mci-core-loader-"));

    const { createModuleRegistry } = await import("./index");
    const registry = await createModuleRegistry(dir, { environmentBindings });

    const context = { any: "context" };
    await registry.activate("adapter-a", context);
    expect(setup).toHaveBeenCalledTimes(1);
    expect(setup).toHaveBeenCalledWith(context);

    await registry.deactivate("adapter-a");
    expect(teardown).toHaveBeenCalledTimes(1);
  });

  it("does not call setup again when re-activating an active module", async () => {
    const setup = vi.fn().mockResolvedValue(undefined);

    vi.doMock("./builtins", () => ({
      builtinModules: [
        {
          manifest: {
            name: "adapter-a",
            version: "1.0.0",
            description: "adapter a",
            type: "adapter",
            main: "index.js",
            isBuiltin: true,
          },
          instantiate: () => ({ setup }),
        },
      ],
    }));

    dir = await mkdtemp(join(tmpdir(), "mci-core-loader-"));

    const { createModuleRegistry } = await import("./index");
    const registry = await createModuleRegistry(dir, { environmentBindings });

    await registry.activate("adapter-a", {});
    await registry.activate("adapter-a", {});
    expect(setup).toHaveBeenCalledTimes(1);
  });

  it("injects registry-provided bindings into environment setup context", async () => {
    const setup = vi.fn().mockResolvedValue(undefined);

    vi.doMock("./builtins", () => ({
      builtinModules: [
        {
          manifest: {
            name: "env-x",
            version: "1.0.0",
            description: "env x",
            type: "environment",
            main: "index.js",
            isBuiltin: true,
          },
          instantiate: () => ({ setup }),
        },
      ],
    }));

    dir = await mkdtemp(join(tmpdir(), "mci-core-loader-"));

    const { createModuleRegistry } = await import("./index");
    const registry = await createModuleRegistry(dir, { environmentBindings });

    const context = { extra: "data" };
    await registry.activate("env-x", context);
    expect(setup).toHaveBeenCalledWith({ ...context, bindings: environmentBindings });
  });
});
