# Developing Cyrnel

- [Developing Cyrnel](#developing-cyrnel)
  - [Getting started](#getting-started)
    - [Prerequisites](#prerequisites)
  - [Local development](#local-development)
    - [Fork the repo](#fork-the-repo)
    - [Clone the repo](#clone-the-repo)
    - [Install workspace dependencies](#install-workspace-dependencies)
    - [Environment variables](#environment-variables)
    - [Initialise the database](#initialise-the-database)
    - [Running the stack](#running-the-stack)
  - [Project structure](#project-structure)
  - [Testing](#testing)
  - [Linting and type checking](#linting-and-type-checking)
  - [Managing dependencies](#managing-dependencies)
  - [Changelogs and releases](#changelogs-and-releases)
  - [Create a pull request](#create-a-pull-request)
  - [Community channels](#community-channels)
  - [Contributors](#contributors)

## Getting started

Thank you for your interest in Cyrnel and your willingness to contribute.

Please read our [Code of Conduct](./CODE_OF_CONDUCT.md) to ensure a positive
and inclusive environment. We encourage you to explore the existing
[issues](https://github.com/actelos/cyrnel/issues) to see how you can make a
meaningful impact. This document will help you set up your development
environment.

### Prerequisites

You will need to install and configure the following on your machine to build
Cyrnel:

- [Git](https://git-scm.com/)
- [Node.js](https://nodejs.org) `^22.x`
- [pnpm](https://pnpm.io/) `^10.30.3`. The easiest way to get the right
  version is via [Corepack](https://nodejs.org/api/corepack.html):

  ```sh
  corepack enable
  corepack prepare pnpm@10.30.3 --activate
  ```

Alternatively, Cyrnel ships a `flake.nix` that pins both Node and pnpm exactly.
If you use [Nix](https://nixos.org/) with flakes enabled and
[direnv](https://direnv.net/), just `cd` into the repo and the environment
will activate automatically via `.envrc`.

## Local development

Cyrnel is a [Turborepo](https://turbo.build/repo) + pnpm monorepo. Every
workspace is in TypeScript.

### Fork the repo

To contribute code to Cyrnel, you must first fork the
[Cyrnel repo](https://github.com/actelos/cyrnel) on GitHub.

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

### Install workspace dependencies

Install all workspace dependencies from the repo root:

```sh
pnpm i -r
```

This installs everything across all workspaces in one pass. Never run
`npm` or `yarn`, pnpm manages the workspace graph and lockfile.

### Environment variables

Each app ships an `.example.env` file that documents every variable it needs.
Copy them all at once:

```sh
for app in api mcp web; do cp "apps/$app/.example.env" "apps/$app/.env"; done
```

**Important:** Before running anything that touches secrets, replace the
placeholder `CYRNEL_SECRETS_KEY` in `apps/api/.env`. The shipped value is a
base64-encoded block of zero bytes and is equivalent to no encryption at all:

```sh
openssl rand -base64 32
# Paste the output into apps/api/.env as CYRNEL_SECRETS_KEY
```

Open `apps/api/.example.env` directly to read the full list of variables and
what each one does. The two most important ones beyond the secrets key are:

- `CYRNEL_DATA_DIR`: Where Cyrnel stores `data.db` (defaults to the `apps/api`
  working directory)
- `CYRNEL_API_KEY`: If set, every request to the API must include
  `Authorization: Bearer <key>`. Leave it unset for unauthenticated local
  development on `127.0.0.1`.

### Initialise the database

Cyrnel's API uses [Drizzle ORM](https://orm.drizzle.team/) with an SQLite
database. On first run, push the schema to create `data.db`:

```sh
pnpm -C apps/api db:push
```

> **`db:push` vs migrations:** `db:push` is a shortcut for first-time setup
> only. It applies your schema directly without generating a migration file.
> For any subsequent schema changes, use `db:generate` followed by
> `db:migrate` so that a migration file is produced and committed alongside
> your code.

Other Drizzle commands you'll use during development:

| Command | What it does |
|---|---|
| `pnpm -C apps/api db:generate` | Generate a new migration from schema changes |
| `pnpm -C apps/api db:migrate` | Apply pending migrations |
| `pnpm -C apps/api db:studio` | Open Drizzle Studio in the browser to inspect the live database |

Whenever you change a table in `apps/api/src/db/schema.ts`, run `db:generate`
to produce a migration file, then commit both the schema change and the
migration together.

### Running the stack

#### Development mode (recommended)

For active development, run each service in watch mode so changes are picked
up automatically:

```sh
pnpm -C apps/api dev     # nodemon / tsx --watch on the Express server
pnpm -C apps/web dev     # Vite dev server with HMR
pnpm -C apps/mcp dev     # tsx --watch on the fastmcp server
```

You can also use the Turborepo `--filter` flag from the root:

```sh
pnpm turbo dev --filter=@cyrnel/api
pnpm turbo dev --filter=@cyrnel/web
```

#### Production mode

To build and run all services at once:

```sh
pnpm build
pnpm start
```

`pnpm build` compiles all workspaces. `pnpm start` then runs all three
services in parallel:

| Service | Workspace | Port |
|---|---|---|
| Express API | `@cyrnel/api` | `:9371` |
| Vite + React web app | `@cyrnel/web` | `:5173` |
| fastmcp HTTP server | `@cyrnel/mcp-ts` | `:9373` |

## Project structure

```
cyrnel/
├── apps/
│   ├── api/                    # @cyrnel/api: Core API server
│   ├── web/                    # @cyrnel/web: Web dashboard
│   └── mcp/                    # @cyrnel/mcp: MCP server
├── packages/
│   ├── libs/
│   │   └── sdk/                # @cyrnel/sdk: Shared module SDK
│   └── modules/
│       ├── openapi/            # @cyrnel/openapi: Built-in adapter module
│       └── typescript-ivm/     # @cyrnel/typescript-ivm: Built-in environment module
├── docs/                       # In-repo documentation
```

## Testing

Cyrnel uses [Vitest](https://vitest.dev/) across all workspaces. Unit tests
live next to their source files as `*.test.ts`. Integration, E2E and other
broader tests live in `/tests/*.test.ts` for each workspace.

```sh
# Runs via Turbo across all workspaces
pnpm test

# Run tests in a single workspace
pnpm -C apps/api test

# Filter by file or test name
pnpm -C apps/api test src/middleware/auth.middleware.test.ts
pnpm -C apps/api test -t "should reject"

# Run tests in watch mode
pnpm -C apps/api exec vitest
```

## Linting and type checking

Cyrnel uses [Biome](https://biomejs.dev/) for linting and formatting. The root
`biome.json` applies to all `apps/**` and `packages/**`.

**Commands:**

```sh
pnpm check         # report lint + format issues (no changes made)
pnpm check:fix     # auto-fix everything Biome can fix
pnpm typecheck     # tsc --noEmit across all workspaces
```

Your editor will pick up `biome.json` automatically if you have the
[Biome extension](https://biomejs.dev/guides/editors/first-party-plugins/)
installed. Enable "format on save" and you'll rarely need to run `check:fix`
manually.

## Managing dependencies

Avoid hand-editing `dependencies`, `devDependencies`, or `peerDependencies` in
`package.json`. pnpm keeps the lockfile, workspace graph, and `node_modules` in
sync, manual edits may break that.

Instead, use the pnpm CLI:

```sh
pnpm -C apps/api add zod
pnpm -C apps/api add -D @types/node
pnpm -C apps/mcp add @cyrnel/sdk --workspace
pnpm -C apps/api remove some-package
pnpm up some-package -r
pnpm up some-package -r --latest
```

After any dependency change, always commit both `package.json` **and** the
updated `pnpm-lock.yaml` together.

## Changelogs and releases

Cyrnel uses [Changesets](https://github.com/changesets/changesets) to manage
versioning and changelogs.

When your PR includes a user-visible change to a publishable package
(`@cyrnel/sdk`), add a changeset:

```sh
pnpm changeset
```

## Create a pull request

After making your changes, open a pull request against the `develop` branch of
`actelos/cyrnel`. Once you submit your PR, the team will review it with you.
See [CONTRIBUTING.md](./CONTRIBUTING.md) for the full checklist before you open
it.

## Community channels

If you get stuck or have questions, open a
[GitHub Discussion](https://github.com/orgs/actelos/discussions/new/choose).
We're here to help.

## Contributors

<a href="https://github.com/actelos/cyrnel/graphs/contributors">
   <img src="https://contributors.deno.dev/actelos/cyrnel?height=1200&width=1200&count=90" width="1200" height="1200" alt="contributors">
</a>
