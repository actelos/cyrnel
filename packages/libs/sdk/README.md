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

More details in our [specification](https://actelos.mintlify.app/cyrnel/specs).
Built with [Cyrnel](https://github.com/actelos/cyrnel).
