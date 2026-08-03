# Repository Instructions

Cyrnel is a Turbo + pnpm monorepo. Every workspace is TypeScript (6.0).

## Workspaces

| Directory | Package | Port | Role |
|---|---|---|---|
| `apps/api` | `@cyrnel/api` | 9371 | Express 5 + Drizzle (SQLite/libsql) |
| `apps/web` | `@cyrnel/web` | 5173 | Vite + React 19 + shadcn + SSR |
| `apps/mcp` | `@cyrnel/mcp` | 9373 | fastmcp MCP server |
| `packages/libs/sdk` | `@cyrnel/sdk` | — | Published npm package (2.0.0) |
| `packages/modules/openapi` | `@cyrnel/openapi` | — | OpenAPI generator (private) |
| `packages/modules/typescript-ivm` | `@cyrnel/typescript-ivm` | — | isolated-vm sandbox (private) |

Tooling: pnpm 10.30.3 / turbo / Biome 2.5 / Vitest.

## Setup & root commands

```bash
pnpm i -r                 # install
pnpm dev / build / start  # turbo proxies (start depends on build)
pnpm test                 # turbo test
pnpm check / check:fix    # Biome (root only, NOT per-package)
pnpm typecheck            # tsc --noEmit per package
```

## Per-package shortcuts

```bash
pnpm -C apps/api dev                       # tsx watch (hot reload)
pnpm -C apps/api test                      # vitest run
pnpm -C apps/api test src/foo.test.ts      # single file
pnpm -C apps/api exec vitest               # watch mode
pnpm -C apps/api db:push                   # Drizzle: schema→DB (dev)
pnpm -C apps/api db:generate / db:migrate  # migration workflow (prod)
pnpm -C apps/api db:studio                 # Drizzle Studio
pnpm -C apps/api openapi:generate          # emit openapi.json
pnpm -C apps/web dev                       # Vite dev (client only)
pnpm -C apps/web start                     # SSR prod (node dist/server/index.js)
pnpm -C apps/mcp dev                       # tsx watch
pnpm -C packages/modules/openapi test
pnpm -C packages/modules/typescript-ivm test
```

## Validation gauntlet (before committing)

```bash
pnpm check:fix && pnpm test && pnpm typecheck && pnpm build
```

Iterating during dev? Use scoped forms (`pnpm -C <pkg> ...`), run full gauntlet before commit.

## Branch workflow

`develop` is the integration branch (default on GitHub) and the only branch kept locally most of the time. `main` is production and receives only `develop` → `main` release PRs.

**Implementing a change (feature / fix / chore / docs):**

1. Start from latest develop: `git switch develop && git pull`
2. Create a short-lived branch: `git switch -c feat/<name>` / `fix/<name>` / `chore/<name>` / `docs/<name>`
3. Implement, then run the validation gauntlet above
4. Commit with conventional style matching history — `feat(scope): …`, `fix(scope): …`, `chore(deps): …`, `docs: …`
5. Push: `git push -u token-origin <branch>` (use `token-origin` — `origin` is SSH and may not have a working key)
6. Open a PR → `develop` (the default target). CI gates: `checks` (biome / typecheck / test / build) + Docker image builds
7. Merge to `develop` (squash, matching history). No review approval required on `develop`
8. Delete the branch locally and on the remote

**Promoting to main (release):**

1. Open a PR `develop` → `main` (e.g. `release: vX.Y.Z`)
2. Gates: all checks + Docker builds, **1 required approval**, branch up-to-date
3. Merge → CI (`publish.yml`) publishes the SDK to npm and pushes Docker images
4. Merge `main` back into `develop` immediately after, so the next release PR is clean

**Branch protection (GitHub):**

- `main` — PR required + 1 approval, required checks: `checks`, `build (api)`, `build (web)`, `build (mcp)`; strict; force-push and deletion blocked; enforced for admins
- `develop` — PR required (no approval), required check: `checks`; strict; force-push and deletion blocked

## Quirks & gotchas

- **Express 5** — API uses Express v5; verify `@types/express` version if adding type augmentations
- **tsc-alias** — `apps/api` and `apps/mcp` builds use `tsc + tsc-alias` because tsc doesn't resolve `@/` path aliases
- **Web SSR** — `pnpm build` compiles client (Vite) + server (tsc); `pnpm start` runs `dist/server/index.js`
- **Web tsconfigs** — three files: `tsconfig.app.json` (React), `tsconfig.node.json` (Vite config), `tsconfig.server.json` (SSR)
- **`inject-workspace-packages: true`** — workspace deps are symlinked, SDK changes propagate instantly
- **`.npmrc`**: `auto-install-peers=false`
- **Environment** — copy `apps/api/.example.env` → `apps/api/.env`. `CYRNEL_SECRETS_KEY` is AES-256-GCM, 32 bytes base64: `openssl rand -base64 32`. Unset `CYRNEL_API_KEY` = unauthenticated access.
- **Migrations don't auto-run** — run `pnpm -C apps/api db:migrate` explicitly before `pnpm -C apps/api dev` if schema changed
- **`@cyrnel/sdk` has no tests** (no vitest dep, no test script)

## Workspace dependency graph

```
@cyrnel/api       → @cyrnel/sdk, @cyrnel/openapi, @cyrnel/typescript-ivm
@cyrnel/openapi   → @cyrnel/sdk
@cyrnel/typescript-ivm → @cyrnel/sdk
@cyrnel/web       — no workspace deps
@cyrnel/mcp       — no workspace deps
```

Before changing `sdk`/`openapi`/`typescript-ivm`, check consumers with `pnpm ls -r --depth 0` and update them in the same commit. Create changeset entries for every affected published package (only `@cyrnel/sdk` is published).

## Releasing (changesets)

Only `@cyrnel/sdk` is published to npm (changeset config limits `changedFilePatterns` to `packages/libs/**`). Apps and module packages are private.

```bash
pnpm changeset          # create .changeset/*.md file
# Commit alongside code; CI reads on merge to main
# Don't hand-edit CHANGELOG.md
```

CI (`publish.yml`) on merge to `main` (via the `develop` → `main` PR): publishes SDK to npm + builds/pushes Docker images for `api`, `web`, `mcp` to ghcr.io.

## Package.json editing rules

**Don't hand-edit** `dependencies`, `devDependencies`, `peerDependencies`, or scripts settable via CLI — pnpm keeps the lockfile and workspace graph in sync; manual edits silently break that.

| Action | Command |
|--------|---------|
| Add runtime dep | `pnpm -C <dir> add <pkg>` |
| Add dev dep | `pnpm -C <dir> add -D <pkg>` |
| Add workspace dep | `pnpm -C <dir> add <pkg-name> --workspace` |
| Remove dep | `pnpm -C <dir> remove <pkg>` |
| Set script | `pnpm pkg set scripts.foo="…"` (in target dir) |
| Bump version | `pnpm up <pkg>` (add `--latest`, `-r`) |

**May** edit `package.json` directly for: `engines`, `exports`/`main`/`types`, `private`, `type`, `files`, `packageManager`, or complex scripts (multi-flag, chained `&&`). After any dep change, commit both `package.json` **and** `pnpm-lock.yaml`.

## TypeScript conventions

- `strict: true`, ESM, `moduleResolution: "bundler"`, `target: ES2022`
- Path alias `@/*` → `src/*` (tsconfig paths + vitest resolve.alias)
- `import type { ... }` for type-only imports; Node built-ins use `node:` prefix
- `kebab-case` files in `apps/api/src/**`; `camelCase` fns/vars; `PascalCase` types
- Avoid `any` — prefer `unknown` + narrowing
- API logs: `pino`/`pino-http` with stable keys (`requestId`, `userId`, `adapterId`). Never log secrets.

## Environment variables

Full set of env vars (see `apps/api/.example.env` for defaults):

| Variable | Purpose |
|---|---|
| `CYRNEL_RATE_LIMIT_MAX` | Global max requests per window (unset = disabled) |
| `CYRNEL_RATE_LIMIT_WINDOW_MS` | Global rate-limit window duration |
| `CYRNEL_ALLOWED_IPS` | Inbound IP allowlist (comma-separated CIDR) |
| `CYRNEL_BLOCKED_IPS` | Inbound IP blocklist (comma-separated CIDR) |
| `CYRNEL_MAX_ACTIVE_PROCESSES` | Max in-memory process records (default 1000) |
| `CYRNEL_MAX_IDLE_PROCESSES` | Max idle in-memory records before LRU auto-unload (unset = unlimited) |
| `CYRNEL_MAX_CODE_SIZE_BYTES` | Max sandbox code submission size (default 102400) |
| `CYRNEL_INVOKE_TIMEOUT_MS` | Tool invocation timeout (default 30000) |
| `CYRNEL_MAX_CONNECTIONS` | Max concurrent connections (0 = unlimited) |
| `CYRNEL_KEEPALIVE_TIMEOUT_MS` | Keep-alive timeout (default 5000) |
| `CYRNEL_HEADERS_TIMEOUT_MS` | Headers timeout (default 6000) |
| `CYRNEL_REQUEST_TIMEOUT_MS` | Request timeout (0 = no timeout) |
| `CYRNEL_REGISTRY_ALLOWED_IPS` | Registry egress allowlist |
| `CYRNEL_REGISTRY_BLOCKED_IPS` | Registry egress blocklist |
| `CYRNEL_BLOCK_ALL_REGISTRIES` | Deny all registry downloads (1/true) |
