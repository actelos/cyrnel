# Repository Instructions

This repository is a monorepo (Turbo + pnpm) with:
- TypeScript apps & packages for API + Web + shared packages
- A small Python MCP app under `apps/mcp`

## Repo layout

- `apps/api`: Express API (TypeScript) + Vitest tests
- `apps/web`: Vite + React web app
- `apps/mcp`: Python service (FastMCP)
- `packages/libs/*`: shared TS libraries (`core`, `sdk`)
- `packages/modules/*`: TS module(s) (`typescript-ivm`)

## Tooling

- Package manager: `pnpm`
- Task runner: `turbo` (see `turbo.json`)
- Lint/format: `biome` (see `biome.json`)
- Tests: `vitest` (in TS packages with tests)
- Python lint/format: `ruff` (configured in `apps/mcp/pyproject.toml`)
- Python typecheck: `pyright` (dev dependency group)

## Install

### JavaScript/TypeScript

From repo root:

- Install dependencies: `pnpm i -r`

Turbo tasks are run from the root (recommended), but you can also `pnpm -C <dir> <script>`
inside a specific package.

### Python (MCP)

From repo root (matches `README.md`):

- Create venv: `uv venv --directory apps/mcp`
- Install deps:
  - `uv pip install --python apps/mcp/.venv/bin/python -r apps/mcp/pyproject.toml`

(If you already have a Python env manager, keep it consistent; this repo expects `uv`.)

## Common commands (root)

Scripts in `package.json`:

- Build all: `pnpm build`
- Start all (depends on build): `pnpm start`
- Tests all: `pnpm test`
- Lint/format check (all): `pnpm check`
- Lint/format fix (all): `pnpm check:fix`
- Typecheck all: `pnpm typecheck`

Notes:
- Turbo runs tasks across packages; if you only changed one area, prefer filtering.

## Run a single package task

Use `pnpm -C` for a specific workspace package/app:

- API tests: `pnpm -C apps/api test`
- API check (biome): `pnpm -C apps/api check`
- Web check: `pnpm -C apps/web check`
- Core tests: `pnpm -C packages/libs/core test`

## Turbo filtering (recommended)

Run tasks for a subset of packages using `--filter`:

- Build API only: `pnpm turbo build --filter=@mci/api`
- Test API only: `pnpm turbo test --filter=@mci/api`
- Check web only: `pnpm turbo check --filter=@mci/web`
- Typecheck core only: `pnpm turbo typecheck --filter=@mci/core`

You can also filter by directory:
- `pnpm turbo test --filter=./apps/api`

## Tests (Vitest)

Most TS packages use `vitest run` and a common include pattern:
- `src/**/*.test.ts`
- `tests/**/*.test.ts`

### Run all tests in a package

- `pnpm -C apps/api test`
- `pnpm -C packages/libs/core test`

### Run a single test file

From the package directory:

- `pnpm -C apps/api test -- src/middleware/auth.middleware.test.ts`

From within the package:

- `pnpm test -- src/middleware/auth.middleware.test.ts`

### Run a single test by name

- `pnpm -C apps/api test -- -t "auth"`
- `pnpm -C apps/api test -- -t "should reject"`

### Watch mode

This repo’s scripts use `vitest run` by default; for watch, call vitest directly:

- `pnpm -C apps/api vitest`
- `pnpm -C apps/api vitest src/.../file.test.ts`
- `pnpm -C apps/api vitest -t "test name"`

(If `pnpm vitest` isn’t available, use `pnpm -C apps/api exec vitest ...`.)

## API app dev commands

From `apps/api/package.json`:

- Dev server: `pnpm -C apps/api dev`
- Build: `pnpm -C apps/api build`
- Start built server: `pnpm -C apps/api start`
- Database (Drizzle):
  - `pnpm -C apps/api db:generate`
  - `pnpm -C apps/api db:migrate`
  - `pnpm -C apps/api db:push`
  - `pnpm -C apps/api db:studio`
- OpenAPI generation: `pnpm -C apps/api openapi:generate`

## Web app dev commands

From `apps/web/package.json`:

- Dev: `pnpm -C apps/web dev`
- Build: `pnpm -C apps/web build`
- Preview: `pnpm -C apps/web start`

## Python (apps/mcp) commands

`apps/mcp/pyproject.toml` config:
- Ruff line length: 88
- Target Python: 3.12
- Ruff lint selects: `E`, `F`, `I` (pycodestyle errors, pyflakes, isort)

Suggested commands (run in repo root):

- Ruff lint: `uv run --directory apps/mcp ruff check .`
- Ruff fix: `uv run --directory apps/mcp ruff check --fix .`
- Ruff format: `uv run --directory apps/mcp ruff format .`
- Pyright typecheck: `uv run --directory apps/mcp pyright`

If you need the venv python explicitly:
- `apps/mcp/.venv/bin/python -m ruff check .`

## Formatting & linting (Biome)

Biome is configured at repo root (`biome.json`) and covers:
- `apps/api/**`, `apps/web/**`, `packages/**`
- excludes `**/dist`, `**/build`, `**/node_modules`

Commands:
- Check: `pnpm check` or `pnpm -C <pkg> check`
- Fix: `pnpm check:fix` or `pnpm -C <pkg> check:fix`

Biome also organizes imports (`assist.actions.source.organizeImports = "on"`).

## TypeScript conventions

TypeScript settings are generally:
- `strict: true`
- ESM modules (`"type": "module"` in libs)
- `moduleResolution: "bundler"`
- `target: ES2022`
- Path alias: `@/*` maps to `src/*` (per-package)

### Types

- Prefer explicit types at module boundaries: exported functions/classes, public service APIs.
- Avoid `any`; prefer `unknown` + narrowing.
- Prefer `type` for unions/intersections; use `interface` when you expect declaration merging
  or class implementation.
- Use `import type { ... }` for type-only imports.

### Naming

- Files: `kebab-case` for multiword (common in `apps/api/src/...`), keep existing conventions.
- Functions/variables: `camelCase`
- Classes/types: `PascalCase`
- Constants: `SCREAMING_SNAKE_CASE` only for true constants.
- Tests: `*.test.ts` (this repo uses that pattern).

### Imports

Follow existing patterns:

- Node built-ins use the `node:` prefix:
  - `import path from "node:path";`
  - `import { createHash } from "node:crypto";`
- Keep import groups separated by a blank line (Biome will normalize):
  1) Node built-ins
  2) External deps
  3) Workspace/internal (`@mci/*`, `@/...`)
  4) Relative imports

### Formatting

- Let Biome handle formatting; do not fight it.
- Quote style: double quotes (see `biome.json`).
- Indentation: spaces.

## Error handling & logging

- Prefer typed errors and explicit error pathways.
- Avoid swallowing errors; when you catch, either:
  - add relevant context and rethrow, or
  - return a structured error result, or
  - translate to HTTP errors (API) with consistent status codes.

API uses `pino`/`pino-http`; prefer structured logs:
- include stable keys (e.g. `requestId`, `userId`, `adapterId`)
- avoid logging secrets (tokens, auth headers, credentials)

## Testing guidelines

- Prefer deterministic tests; avoid relying on timing.
- Use `describe/it` naming that matches behavior.
- For integration/e2e tests that start servers, ensure proper cleanup.
- When adding a test, match existing placement:
  - unit tests near code in `src/**.test.ts`
  - broader tests in `tests/**`

## Working as an agent

- Minimize scope: change only what the request requires.
- Keep edits consistent with existing code style and patterns.
- If you add scripts/config, prefer repo-root shared config unless a package needs overrides.
- Run the narrowest validation command that proves the change.

## Quick validation recipes

For TS-only changes in API:
- `pnpm -C apps/api check`
- `pnpm -C apps/api typecheck`
- `pnpm -C apps/api test -- src/path/to/file.test.ts`

For repo-wide sanity:
- `pnpm check:fix`
- `pnpm typecheck`
- `pnpm test`
