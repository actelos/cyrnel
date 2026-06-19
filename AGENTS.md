# Repository Instructions

Cyrnel is a Turbo + pnpm monorepo. Every workspace is TypeScript.

## Repo layout

- `apps/api` — Express API (`@cyrnel/api`)
- `apps/web` — Vite + React web app (`@cyrnel/web`)
- `apps/mcp` — MCP server built on `fastmcp` (`@cyrnel/mcp-ts`)
- `packages/libs/sdk` — shared TS SDK (`@cyrnel/sdk`)
- `packages/modules/openapi` — OpenAPI generator (`@cyrnel/openapi`)
- `packages/modules/typescript-ivm` — sandboxed TS runtime (`@cyrnel/typescript-ivm`)

Workspaces are declared in `pnpm-workspace.yaml`; the Turbo pipeline lives in
`turbo.json`; lint/format config is `biome.json`.

## Tooling

- Package manager: `pnpm`
- Task runner: `turbo`
- Lint/format: `biome`
- Tests: `vitest`
- TypeScript.

## Install

From the repo root:

```bash
pnpm i -r
```

## Root commands

The root `package.json` proxies to Turbo across all workspaces:

- `pnpm dev`
- `pnpm build`
- `pnpm start` (depends on build)
- `pnpm test`
- `pnpm check` / `pnpm check:fix` (global Biome — **not** per-package)
- `pnpm typecheck`

`check` and `check:fix` run Biome from the root against the whole repo (no
per-package Biome scripts). Every other command fans out uniformly via Turbo.

## Per-package commands

Scope to a single workspace with `pnpm -C <dir> <script>`:

- `pnpm -C apps/api test`
- `pnpm -C apps/web dev`
- `pnpm -C apps/mcp dev`
- `pnpm -C packages/modules/openapi test`

Or filter via Turbo:

- `pnpm turbo test --filter=@cyrnel/api`
- `pnpm turbo build --filter=./apps/mcp`

## App-specific scripts

### `apps/api`

- Dev: `pnpm -C apps/api dev`
- DB (Drizzle): `db:generate`, `db:migrate`, `db:push`, `db:studio`
- OpenAPI definition: `pnpm -C apps/api openapi:generate`
- Env vars are documented in `apps/api/.example.env`.

### `apps/web`

- Dev: `pnpm -C apps/web dev`
- Preview built bundle: `pnpm -C apps/web start`

### `apps/mcp`

- Dev (watch via `tsx`): `pnpm -C apps/mcp dev`
- Built server entry: `dist/server.js`

## Tests (Vitest)

- Unit tests live next to code as `*.test.ts`.
- Module packages (`packages/modules/*`) also have a `tests/**` folder for
  broader/integration tests.
- The `@cyrnel/sdk` package currently has no tests.

Run a single file or filter by name:

```bash
pnpm -C apps/api test src/middleware/auth.middleware.test.ts
pnpm -C apps/api test -t "should reject"
```

Watch mode (the `test` script uses `vitest run`):

```bash
pnpm -C apps/api exec vitest
```

## TypeScript conventions

Per-package `tsconfig.json` settings are consistent:

- `strict: true`, ESM, `moduleResolution: "bundler"`, `target: ES2022`
- Path alias: `@/*` → `src/*`

Style:

- Prefer explicit types at module boundaries.
- Avoid `any`; prefer `unknown` + narrowing.
- `type` for unions/intersections; `interface` when declaration merging or
  class `implements` is needed.
- Use `import type { ... }` for type-only imports.
- Node built-ins use the `node:` prefix.
- Import groups (Biome will normalize): node built-ins → externals → workspace
  (`@cyrnel/*`, `@/...`) → relative.

Naming: `kebab-case` files in `apps/api/src/**`, `camelCase` for
functions/vars, `PascalCase` for classes/types, `SCREAMING_SNAKE_CASE` only
for true constants, tests `*.test.ts`.

Formatting: let Biome handle it (double quotes, spaces).

## Error handling & logging

- Prefer typed errors and explicit error pathways.
- Don't swallow errors — add context and rethrow, return a structured result,
  or translate to a consistent HTTP error.
- The API uses `pino` / `pino-http`. Use structured logs with stable keys
  (`requestId`, `userId`, `adapterId`). Never log secrets.

---

## Working as an agent

### Do not hand-edit `package.json` for dependencies

If a CLI command can do it, use the CLI. **Never** hand-edit `dependencies`,
`devDependencies`, `peerDependencies`, `scripts` you could add via `pnpm pkg
set`, package names, versions, or workspace links — pnpm keeps the lockfile,
the workspace graph, and `node_modules` in sync, and manual edits silently
break that.

Use:

- New workspace: `pnpm init` inside the directory
- Add a dep to a workspace: `pnpm -C <dir> add <pkg>`
- Add a dev dep: `pnpm -C <dir> add -D <pkg>`
- Add a workspace dep: `pnpm -C <dir> add <pkg-name> --workspace`
- Remove a dep: `pnpm -C <dir> remove <pkg>`
- Bump versions: `pnpm up <pkg>` (optionally `--latest`, `-r` for recursive)
- Set/unset fields scriptably: `pnpm pkg set scripts.foo="…"`
- Run a script: `pnpm -C <dir> <script>` (don't add ad-hoc one-shot scripts)

You **may** edit `package.json` directly only for changes pnpm has no command
for: `engines`, `exports`/`main`/`types` maps, `private`, `type`, `files`,
`packageManager`, custom metadata, or fixing up a `scripts` entry whose
content is non-trivial (multi-flag commands, env prefixes, chained `&&`).
When in doubt, prefer the CLI.

After any dependency change, commit both `package.json` **and** the updated
`pnpm-lock.yaml`.

### Always validate before committing

Before any commit, run the full repo-wide gauntlet from the root **in this
order**:

```bash
pnpm check:fix
pnpm test
pnpm typecheck
pnpm build
```

Turbo's caching makes this cheap on a clean tree. Iterating? Use the scoped
forms (`pnpm -C <pkg> ...` or `pnpm turbo … --filter=…`) while working, then
run the repo-wide gauntlet before declaring the task done. Trivial doc-only or
single-file comment edits don't need it; anything that changes runtime
behavior or types does.

### Releasing packages

Several packages are published to npm (`@cyrnel/*`). **Do not edit
`CHANGELOG.md` files manually** — release changelogs are generated by CI.

Instead, run `pnpm changeset` (uses `@changesets/cli`) to create a changeset
file in `.changeset/`. This produces a markdown file with frontmatter
declaring which packages changed and the semver bump type (`patch`, `minor`,
`major`), followed by a human-readable summary of the change.

- Create **one changeset per logical package change**.
- If the same commit touches multiple packages, create a separate changeset
  for each (or a single changeset listing multiple packages if the change is
  atomic across them).
- Commit the `.changeset/*.md` file alongside the code changes.

Example changeset:

```markdown
---
"@cyrnel/web": patch
---

Fix alignment in module detail grid
```

CI reads these files on merge to `main`, composes them into `CHANGELOG.md`,
bumps versions, and publishes. You only need to ship the `.md` file.

### Cross-package awareness

Packages in this monorepo depend on each other (e.g. `@cyrnel/sdk` → `@cyrnel/api`)
via workspace references in `package.json`. A change to one package can break
consumers in other packages or apps. Before making a change:

1. Check `pnpm ls -r --depth 0` or grep workspace deps to see what depends on
   the package you're editing.
2. Update consumers in the same commit if your change is a breaking type
   signature, export removal, or behavioural contract.
3. Create changeset entries for **every affected published package**.

This is especially important for `@cyrnel/sdk` (consumed by `@cyrnel/api` and
`@cyrnel/web`) and `@cyrnel/openapi` (consumed by `@cyrnel/api`).

### Scope and style

- Change only what the request requires.
- Match existing patterns in the area you're editing — don't introduce a new
  convention to fix a small bug.
- Prefer shared root config (Biome, TS) over per-package overrides unless a
  package genuinely needs one.
- If something in the repo is ambiguous or contradicts these instructions,
  **ask** rather than guess. Everything not covered here is in the repo —
  read the relevant `package.json`, `tsconfig.json`, `vitest.config.ts`, or
  source file.
