# Developing Cyrnel

- [Developing Cyrnel](#developing-cyrnel)
  - [Getting started](#getting-started)
    - [Install dependencies](#install-dependencies)
  - [Local development](#local-development)
    - [Fork the repo](#fork-the-repo)
    - [Clone the repo](#clone-the-repo)
    - [Install dependencies](#install-dependencies-1)
    - [Environment variables](#environment-variables)
    - [Initialise the database](#initialise-the-database)
    - [Running the stack](#running-the-stack)
  - [Project structure](#project-structure)
  - [Working with each workspace](#working-with-each-workspace)
    - [apps/api — the Express server](#appsapi--the-express-server)
    - [apps/web — the React frontend](#appsweb--the-react-frontend)
    - [apps/mcp — the MCP server](#appsmcp--the-mcp-server)
    - [packages/libs/sdk — the shared SDK](#packageslibssdk--the-shared-sdk)
    - [packages/modules/openapi — the OpenAPI adapter](#packagesmodulesopenapi--the-openapi-adapter)
    - [packages/modules/typescript-ivm — the sandboxed runtime](#packagesmodulestypescript-ivm--the-sandboxed-runtime)
  - [Working with the docs](#working-with-the-docs)
  - [Testing](#testing)
  - [Linting and type checking](#linting-and-type-checking)
  - [Managing dependencies](#managing-dependencies)
  - [Turborepo tips](#turborepo-tips)
  - [Changesets and releases](#changesets-and-releases)
  - [Create a pull request](#create-a-pull-request)
  - [Community channels](#community-channels)

## Getting started

Thank you for your interest in cyrnel and your willingness to contribute!

To ensure a positive and inclusive environment, please read our [Code of Conduct](./CODE_OF_CONDUCT.md). We encourage you to explore the existing [issues](https://github.com/actelos/cyrnel/issues) to see how you can make a meaningful impact. This document will help you set up your development environment.

### Install dependencies

You will need to install and configure the following on your machine to build cyrnel:

- [Git](https://git-scm.com/)
- [Node.js](https://nodejs.org) `^22.x`
- [pnpm](https://pnpm.io/) `^10.30.3` the easiest way to get the right version is via [Corepack](https://nodejs.org/api/corepack.html):

  ```sh
  corepack enable
  corepack prepare pnpm@10.30.3 --activate
  ```

Alternatively, cyrnel ships a `flake.nix` that pins both Node and pnpm exactly. If you use [Nix](https://nixos.org/) with flakes enabled and [direnv](https://direnv.net/), just `cd` into the repo, the environment activates automatically via `.envrc`.

## Local development

Cyrnel is a [Turborepo](https://turbo.build/repo) + pnpm monorepo. Every workspace is TypeScript.

### Fork the repo

To contribute code to cyrnel, you must first fork the [cyrnel repo](https://github.com/actelos/cyrnel) on GitHub.

### Clone the repo

1. Clone your fork:

   ```sh
   git clone https://github.com/<your_github_username>/cyrnel.git
   ```

2. Navigate into the repo:

   ```sh
   cd cyrnel
   ```

3. Add the upstream remote so you can pull in future changes:

   ```sh
   git remote add upstream https://github.com/actelos/cyrnel.git
   ```

### Install dependencies

Install all workspace dependencies from the repo root:

```sh
pnpm i -r
```

This installs everything across all workspaces in one pass. Never run `pnpm install` or `yarn`, pnpm manages the workspace graph and lockfile.

### Environment variables

Each app ships an `.example.env` file that documents every variable it needs. Copy them all at once:

```sh
for app in api mcp web; do cp "apps/$app/.example.env" "apps/$app/.env"; done
```

**Important:** Before running anything that touches secrets, replace the placeholder `CYRNEL_SECRETS_KEY` in `apps/api/.env`. The shipped value is a base64-encoded block of zero bytes and is equivalent to no encryption at all:

```sh
openssl rand -base64 32
# Paste the output into apps/api/.env as CYRNEL_SECRETS_KEY
```

Open `apps/api/.example.env` directly to read the full list of variables and what each one does. The two most important ones beyond the secrets key are:

- `CYRNEL_DATA_DIR`: Where cyrnel stores `data.db` (defaults to the `apps/api` working directory)
- `CYRNEL_API_KEY`: If set, every request to the API must include `Authorization: Bearer <key>`; leave it unset for unauthenticated local development on `127.0.0.1`

### Initialise the database

Cyrnel's API uses [Drizzle ORM](https://orm.drizzle.team/) with a SQLite database. Push the schema to create `data.db` on first run:

```sh
pnpm -C apps/api db:push
```

Other Drizzle commands you'll use during development:

| Command | What it does |
|---|---|
| `pnpm -C apps/api db:generate` | Generate a new migration from schema changes |
| `pnpm -C apps/api db:migrate` | Apply pending migrations |
| `pnpm -C apps/api db:studio` | Open Drizzle Studio in the browser to inspect the live database |

Whenever you change a table in `apps/api/src/db/schema.ts`, run `db:generate` to produce a migration file, then commit both the schema change and the migration together.

### Running the stack

#### All at once

```sh
pnpm build
pnpm start
```

`pnpm start` depends on `build` (as declared in `turbo.json`) and runs all three services in parallel:

| Service | Workspace | Port |
|---|---|---|
| Express API | `@cyrnel/api` | `:7687` |
| Vite + React web app | `@cyrnel/web` | `:5173` |
| fastmcp HTTP server | `@cyrnel/mcp-ts` | `:3333` |

#### Individual workspaces

Use `pnpm -C <dir> dev` to run any single app in watch mode:

```sh
pnpm -C apps/api dev     # nodemon / tsx --watch on the Express server
pnpm -C apps/web dev     # Vite dev server with HMR
pnpm -C apps/mcp dev     # tsx --watch on the fastmcp server
```

You can also use the Turborepo `--filter` flag from the root:

```sh
pnpm turbo dev --filter=@cyrnel/api
pnpm turbo dev --filter=./apps/web
```

## Project structure

```
cyrnel/
├── apps/
│   ├── api/                    # @cyrnel/api — Express API
│   ├── web/                    # @cyrnel/web — Vite + React frontend
│   └── mcp/                    # @cyrnel/mcp-ts — fastmcp HTTP server
├── packages/
│   ├── libs/
│   │   └── sdk/                # @cyrnel/sdk — shared TypeScript SDK
│   └── modules/
│       ├── openapi/            # @cyrnel/openapi — built-in adapter module
│       └── typescript-ivm/     # @cyrnel/typescript-ivm — built-in environment module
├── docs/                       # In-repo documentation
```

## Working with each workspace

### apps/api — the Express server

`@cyrnel/api` is the heart of cyrnel. It manages modules, processes, services, tools, and secrets. It exposes a REST API on `:7687`.

**Key scripts:**

```sh
pnpm -C apps/api dev              # Start in watch mode
pnpm -C apps/api build            # Compile to dist/
pnpm -C apps/api test             # Run all tests
pnpm -C apps/api typecheck        # tsc --noEmit
pnpm -C apps/api db:generate      # Generate a Drizzle migration
pnpm -C apps/api db:migrate       # Apply pending migrations
pnpm -C apps/api db:push          # Push schema directly (dev only)
pnpm -C apps/api db:studio        # Open Drizzle Studio
pnpm -C apps/api openapi:generate # Regenerate the OpenAPI definition
```

**Layout inside `apps/api/src`:**

- `db/` — Drizzle schema, migrations, and the database client
- `modules/` — module registry, install/uninstall, enable/disable
- `processes/` — process lifecycle (create, run, kill, output)
- `services/` — service manifests, config, secrets
- `tools/` — tool listing and gating
- `middleware/` — auth, error handling
- `env/` — environment variable validation (uses Zod)

**OpenAPI definition:**

Whenever you add or change API endpoints, regenerate the spec and commit it:

```sh
pnpm -C apps/api openapi:generate
```

This updates `apps/api/openapi.json`, which is also served at `https://actelos.mintlify.app/cyrnel.openapi.json` for the public docs.

**Auth:**

If `CYRNEL_API_KEY` is set, include it on every request:

```sh
curl -H 'Authorization: Bearer <key>' http://localhost:7687/modules
```

Unset it in your local `.env` for anonymous development — anonymous mode is intentionally only safe on `127.0.0.1`.

### apps/web — the React frontend

`@cyrnel/web` is the Vite + React web application. It communicates with `apps/api` and provides the visual interface for managing modules, services, and processes.

**Key scripts:**

```sh
pnpm -C apps/web dev      # Start Vite dev server with HMR on :5173
pnpm -C apps/web build    # Build to dist/
pnpm -C apps/web start    # Preview the built bundle
pnpm -C apps/web typecheck
```

The dev server proxies API requests to `:7687`, so `apps/api` must be running alongside it. Running `pnpm start` from the root starts both together.

### apps/mcp — the MCP server

`@cyrnel/mcp-ts` is the [fastmcp](https://github.com/punkpeye/fastmcp) HTTP server that exposes cyrnel's tools to MCP-compatible AI clients. It bridges cyrnel's internal tool/process model into the MCP protocol on `:3333`.

**Key scripts:**

```sh
pnpm -C apps/mcp dev     # tsx --watch on src/server.ts
pnpm -C apps/mcp build   # Compile to dist/; entry is dist/server.js
pnpm -C apps/mcp start   # Run the compiled server
```

Because the MCP server calls `apps/api` internally, the API must also be running. The root `pnpm start` handles this automatically.

### packages/libs/sdk — the shared SDK

`@cyrnel/sdk` is the shared TypeScript SDK consumed by adapter and environment modules. It exports the types, interfaces, and utilities that modules must conform to.

There are currently no tests in this package. If you add functionality, add tests alongside the code.

**Key scripts:**

```sh
pnpm -C packages/libs/sdk build      # Compile to dist/
pnpm -C packages/libs/sdk typecheck
```

When making changes to the SDK, run `pnpm build` from the root afterward — all downstream workspaces depend on the built output.

### packages/modules/openapi — the OpenAPI adapter

`@cyrnel/openapi` is cyrnel's built-in adapter module. It ingests OpenAPI documents and exposes their operations as cyrnel tools, allowing LLMs to call any REST API described by an OpenAPI spec.

**Key scripts:**

```sh
pnpm -C packages/modules/openapi build
pnpm -C packages/modules/openapi test
pnpm -C packages/modules/openapi typecheck
```

Tests live in `packages/modules/openapi/tests/` and cover the integration surface (parsing specs, generating tools, handling config/secrets validation).

### packages/modules/typescript-ivm — the sandboxed runtime

`@cyrnel/typescript-ivm` is cyrnel's built-in environment module. It provides a sandboxed TypeScript runtime using [isolated-vm](https://github.com/laverdet/isolated-vm), which is the execution environment for processes submitted to cyrnel.

**Key scripts:**

```sh
pnpm -C packages/modules/typescript-ivm build
pnpm -C packages/modules/typescript-ivm test
pnpm -C packages/modules/typescript-ivm typecheck
```

`isolated-vm` is a native module. If it fails to build or load, make sure your Node.js version is `v22.x` and that native build tools (`build-essentials` or Xcode CLT) are installed.

## Working with the docs

Cyrnel's public documentation lives at https://actelos.mintlify.app/cyrnel/docs and is authored in the `docs/` folder of this repo using [Mintlify](https://mintlify.com/).

**Prerequisites:**

You do not need a Mintlify account to preview docs locally. The Mintlify CLI handles everything:

```sh
pnpm dlx mintlify dev
# or
npx mintlify dev
```

This starts a local preview server, typically at `http://localhost:3000`. Changes to `.md` and `.mdx` files in `docs/` hot-reload automatically.

**Structure:**

Mintlify uses a `docs/mint.json` (or `mint.json` at the repo root) to define navigation. When adding a new page, register it there in addition to creating the file.

**API reference:**

The API reference pages are generated from `apps/api/openapi.json`. After regenerating the spec (`pnpm -C apps/api openapi:generate`), the docs will reflect the updated endpoints on the next preview or deploy.

**Linting docs:**

Mintlify validates broken links and misconfigured pages:

```sh
pnpm dlx mintlify broken-links
```

## Testing

Cyrnel uses [Vitest](https://vitest.dev/) across all workspaces. Unit tests live next to their source files as `*.test.ts`. Integration/broader tests for module packages live in `packages/modules/*/tests/`.

**Run all tests:**

```sh
pnpm test   # runs via Turbo across all workspaces
```

**Run tests in a single workspace:**

```sh
pnpm -C apps/api test
pnpm -C packages/modules/openapi test
```

**Filter by file or test name:**

```sh
pnpm -C apps/api test src/middleware/auth.middleware.test.ts
pnpm -C apps/api test -t "should reject"
```

**Watch mode:**

The root `test` script uses `vitest run` (single-pass). For watch mode, invoke Vitest directly:

```sh
pnpm -C apps/api exec vitest
```

## Linting and type checking

Cyrnel uses [Biome](https://biomejs.dev/) for linting and formatting. The root `biome.json` applies to all `apps/**` and `packages/**`.

**Biome settings:**
- Indent: 2 spaces
- Quotes: double
- Import organisation: automatic (`organizeImports: on`)

**Commands:**

```sh
pnpm check         # report lint + format issues (no changes made)
pnpm check:fix     # auto-fix everything Biome can fix
pnpm typecheck     # tsc --noEmit across all workspaces
```

Your editor will pick up `biome.json` automatically if you have the [Biome extension](https://biomejs.dev/guides/editors/first-party-plugins/) installed. Enable "format on save" and you'll rarely need to run `check:fix` manually.

**TypeScript conventions** (enforced by `tsconfig.json` in every workspace):
- `strict: true`, ESM, `moduleResolution: "bundler"`, `target: ES2022`
- Path alias `@/*` → `src/*`
- Avoid `any` — use `unknown` + narrowing instead
- `type` for unions/intersections; `interface` when declaration merging or `implements` is needed
- `import type { ... }` for type-only imports
- `node:` prefix for all Node built-ins
- Naming: `kebab-case` files, `camelCase` functions/vars, `PascalCase` classes/types, `SCREAMING_SNAKE_CASE` true constants, `*.test.ts` for tests

## Managing dependencies

Never hand-edit `dependencies`, `devDependencies`, or `peerDependencies` in `package.json`. pnpm keeps the lockfile, workspace graph, and `node_modules` in sync — manual edits silently break that.

Always use the pnpm CLI:

```sh
# Add a runtime dependency to a workspace
pnpm -C apps/api add zod

# Add a dev dependency
pnpm -C apps/api add -D @types/node

# Add a workspace (internal) dependency
pnpm -C apps/mcp add @cyrnel/sdk --workspace

# Remove a dependency
pnpm -C apps/api remove some-package

# Upgrade a package across all workspaces
pnpm up some-package -r

# Upgrade to latest
pnpm up some-package -r --latest
```

You **may** hand-edit `package.json` only for fields pnpm has no CLI for: `engines`, `exports`/`main`/`types`, `files`, `private`, `type`, or non-trivial `scripts` entries.

After any dependency change, always commit both `package.json` **and** the updated `pnpm-lock.yaml` together.

## Turborepo tips

All root scripts (`dev`, `build`, `start`, `test`, `check`, `check:fix`, `typecheck`) fan out across workspaces via the Turbo pipeline defined in `turbo.json`. Every task has `"dependsOn": ["^build"]`, meaning a workspace's dependencies are always built first.

**Run a task for specific workspaces:**

```sh
pnpm turbo test --filter=@cyrnel/api
pnpm turbo build --filter=./apps/mcp
pnpm turbo build --filter=@cyrnel/sdk...  # sdk and everything that depends on it
```

**Turbo cache:**

Turbo caches task outputs in `.turbo/`. On a clean tree, running `pnpm check:fix && pnpm typecheck && pnpm test && pnpm build` is fast. If something seems stale:

```sh
pnpm turbo daemon stop
rm -rf .turbo
```

## Changesets and releases

Cyrnel uses [Changesets](https://github.com/changesets/changesets) to manage versioning and changelogs. The `@changesets/cli` is already installed as a dev dependency.

When your PR includes a user-visible change to a publishable package (currently `@cyrnel/sdk`), add a changeset:

```sh
pnpm changeset
```

This interactively asks which packages changed and whether the bump is `patch`, `minor`, or `major`, then writes a `.changeset/*.md` file. Commit that file alongside your code changes.

Releases are handled by the maintainers — you don't need to run `pnpm changeset version` or `pnpm changeset publish` yourself.

## Create a pull request

After making your changes, open a pull request against the `main` branch of `actelos/cyrnel`. Once you submit your PR, the team will review it with you. See [CONTRIBUTING.md](./CONTRIBUTING.md) for the full checklist before you open it.

## Community channels

If you get stuck or have questions, open a [GitHub Discussion](https://github.com/orgs/actelos/discussions/new/choose). We're here to help.

<a href="https://github.com/actelos/cyrnel/graphs/contributors">
   <img src="https://contributors.deno.dev/actelos/cyrnel?height=1200&width=1200&count=90" width="1200" height="1200" alt="contributors">
</a>
