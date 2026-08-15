# @cyrnel/sdk

TypeScript types and interfaces for building Cyrnel modules.

## Install

```bash
npm i @cyrnel/sdk
```

## Usage

```ts
import type {
  Module,
  EnvironmentModule,
  AdapterModule,
  ServiceDefinition,
  ToolDefinition,
  JSONSchema,
} from "@cyrnel/sdk";
```

### Module types

- **`Module`**: Base interface with `setup` and `teardown`
- **`EnvironmentModule`**: Sandboxed runtime module with `execute`/`kill`
- **`AdapterModule`**: Service adapter module with `invoke`/`hydrate`

### Workflow types

- **`ServiceDefinition`**: Describes a service and its tools
- **`ToolDefinition`**: Describes a single tool with input/output schemas

### Bindings

`EnvironmentBindings` provides the runtime API available to environment modules:
- `invokeTool` Call a tool on a service
- `setState` / `setError` / `emitStdout` / `emitStderr` / `emitOutput`: Lifecycle signals

### Module logging

The host owns all logging. A module receives a single `ModuleLogger` through
its `setup` context and never constructs a root logger itself. Every entry a
module emits is automatically tagged with `type: "module"`, `moduleId`,
`moduleType`, and the owning `adapterId`/`environmentId` — these correlation
fields are host-managed and cannot be forged or overridden by the module.

```ts
import type {
  ModuleSetupContext,
  ModuleLogger,
} from "@cyrnel/sdk";

async setup(context: ModuleSetupContext): Promise<void> {
  const patterns = (context.config.redactionPatterns as string[] | undefined) ?? [];
  // configure reduction for yourself from your own config field
  this.logger = context.logger.redact(patterns).child({ phase: "setup" });
}

this.logger?.info({ event: "request", path }, "Sending request");
```

- `ModuleLogger` exposes the six levels `trace` / `debug` / `info` / `warn` /
  `error` / `fatal`, each accepting `(payload?, message?)`.
- `child(bindings)` scopes the logger. `bindings` is `ModuleLogBindings`
  (`{ phase?, event? }` only) — the host merges only `phase`/`event`, so a
  module cannot set host-owned correlation metadata.
- `redact(patterns)` returns a **new** logger that applies the module's path
  patterns **additively** on top of a non-disableable host baseline
  (secrets / tokens / passwords / authorization). Chained `redact()` calls
  accumulate; non-string or empty patterns are ignored. The host never pushes
  patterns into the setup context.
- `context` is `Readonly` — a module reads but never mutates the logger's
  bound metadata.

`AdapterSetupContext` is a plain alias of `ModuleSetupContext`; the
adapter-vs-environment distinction lives in the `AdapterModule` /
`EnvironmentModule` interfaces, not in the context type.

More details in our [specification](https://actelos.mintlify.app/cyrnel/specs).
Built with [Cyrnel](https://github.com/actelos/cyrnel).
