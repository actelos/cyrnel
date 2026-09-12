# Repository Instructions

Cyrnel is a Turbo + pnpm monorepo. Every workspace is TypeScript (6.0).

**Prerequisites:** Node.js `^24` (`engines: >=24.0.0`, flake pins `nodejs_24`, CI uses 24), pnpm `^10.30.3` (via Corepack: `corepack enable && corepack prepare pnpm@10.30.3 --activate`). Nix flake available (`flake.nix` + `.envrc` for direnv).

## Workspaces

| Directory | Package | Port | Role |
|---|---|---|---|
| `apps/api` | `@cyrnel/api` | 9371 | Express 5 + Drizzle (SQLite/libsql) |
| `apps/web` | `@cyrnel/web` | 5173 | Vite + React 19 + shadcn + SSR |
| `apps/mcp` | `@cyrnel/mcp` | 9373 | fastmcp MCP server |
| `packages/libs/sdk` | `@cyrnel/sdk` | — | Published npm package (4.0.0) |
| `packages/modules/openapi` | `@cyrnel/openapi` | — | OpenAPI adapter module (private) |
| `packages/modules/typescript-ivm` | `@cyrnel/typescript-ivm` | — | isolated-vm environment module (private) |

Tooling: pnpm 10.30.3 / turbo / Biome 2.5 / Vitest.

## Setup & root commands

```bash
pnpm i                      # install (never npm/yarn)
pnpm dev / build / start    # turbo proxies (start depends on build)
pnpm test                   # turbo test (api + module packages only — web/mcp/sdk have no test script)
pnpm check / check:fix      # Biome (root only, NOT per-package)
pnpm typecheck              # tsc --noEmit per package
```

## Per-package shortcuts

```bash
pnpm -C apps/api dev                       # tsx watch + dev registry (port 9372) via concurrently
pnpm -C apps/api test                      # vitest run
pnpm -C apps/api test src/foo.test.ts      # single file
pnpm -C apps/api test -t "should reject"   # filter by name
pnpm -C apps/api exec vitest               # watch mode
pnpm -C apps/api db:push                   # Drizzle: schema→DB (first-time setup only)
pnpm -C apps/api db:generate / db:migrate  # migration workflow (schema changes; commit both)
pnpm -C apps/api db:studio                 # Drizzle Studio
pnpm -C apps/api openapi:generate          # regenerate apps/api/openapi/*.v*.json + docs/openapi/*.v*.json (API + registry specs)
pnpm -C apps/web dev                       # Vite dev (client only)
pnpm -C apps/web start                     # SSR prod (node dist/server/index.js)
pnpm -C apps/mcp dev                       # tsx watch
```

## Validation gauntlet (before committing)

```bash
pnpm build && pnpm check:fix && pnpm typecheck && pnpm test
```

If you touched API routes/schemas, also run `pnpm -C apps/api openapi:generate` and commit the regenerated specs — CI (`check.yml`) fails on a stale `apps/api/openapi/` or `docs/openapi/`. Same for registry protocol changes (`src/utils/registry.util.ts` wire types feed `openapi/registry.v1.openapi.json`). Iterating? Use scoped `pnpm -C <pkg> ...` forms, full gauntlet before commit. CI runs `biome ci` + `turbo typecheck test build`; `checks` is the required gate (Docker builds gate `main` only).

## Branch workflow

`develop` is the integration branch (default) — PRs target it. `main` is production, only via `develop` → `main` release PRs.

1. `git switch develop && git pull token-origin develop` (use `token-origin` — `origin` is SSH and may lack a working key)
2. Short-lived branch: `feat/<name>` / `fix/<name>` / `chore/<name>` / `docs/<name>`
3. Implement + run the gauntlet; conventional commits (`feat(scope): …`, `fix(scope): …`, …)
4. Push `git push -u token-origin <branch>`, open PR → `develop` (squash-merge, no approval required), delete the branch
5. Release: PR `develop` → `main` needs 1 approval + all checks + Docker builds; merge `main` back into `develop` right after

## Quirks & gotchas

- **Express 5** — verify `@types/express` version if adding type augmentations
- **tsc-alias** — `apps/api` and `apps/mcp` builds use `tsc + tsc-alias` (tsc doesn't resolve `@/` aliases)
- **Web SSR** — build is `vite build && tsc -p tsconfig.server.json`; three tsconfigs (`app` = React, `node` = Vite config, `server` = SSR)
- **`inject-workspace-packages: true`** — workspace deps are symlinked, SDK changes propagate instantly
- **`.npmrc`**: `auto-install-peers=false`
- **Environment** — copy `apps/api/.example.env` → `apps/api/.env` (source of truth for all vars). Non-obvious: `CYRNEL_SECRETS_KEY` is AES-256-GCM, 32 bytes base64 (`openssl rand -base64 32`; the shipped value is zero bytes = no encryption); `CYRNEL_SECRETS_PREVIOUS_KEYS` holds old keys for rotation; unset `CYRNEL_API_KEY` = unauthenticated access
- **Migrations don't auto-run** — run `db:push` (first time) or `db:migrate` explicitly before `dev`; prod migrates via `node dist/migrate.js`
- **Search engine** — local ONNX embeddings (`@xenova/transformers`, default `Xenova/bge-small-en-v1.5`) + `sqlite-vec` + SQLite FTS5 hybrid search; changing models requires rebuilding `tool_embeddings`
- **Registry protocol** — `GET <baseUrl>/.well-known/registry.json` advertises capabilities as a keyed map (`definitions.v1`, `modules.v1`); negotiate highest supported version, resolve relative URLs against the post-redirect URL, enforce same-origin for capability URLs/entry sources, ignore unknown keys. Definition entries carry `kind` (`<identifier>@<version>`, e.g. `openapi@3.0`); the browse `kind` param is advisory. Adapter modules declare `compatibility: [{ identifier, version: <semver range> }]` for ranking (`GET /services/install/adapters?kind=…`) and auto-select when `POST /services/install` omits `adapter`. Local fixture: `apps/api/scripts/dev-registry.ts` (port 9372)
- **Registry auth** — well-known `auth: {schemes, security}` (multi-method: `apiKey`/`basic`/`http-bearer`/`oauth2` + per-capability `{url, security}` overrides; `[]` = public; absent `auth` = fully public). Owner-scoped `registry_credentials` + `registry_credential_auth` (≤1 per `(registry, scheme)`, AES-256-GCM); `authorization_code` tokens delegate to shared `oauth_clients`. Setup: `POST /registries {id, baseUrl}`, `POST /registries/:id/auth`, nested `PUT|DELETE /registries/:id/credentials/:scheme/...` + authorize/code, `GET /registries/:id/auth` (declaration + summaries, never secrets). Credential requests need https unless loopback or `CYRNEL_REGISTRY_AUTH_INSECURE_CIDRS`; discovery itself never attaches auth
- **Per-tool permissions** — `ModuleService.invoke` gates every call against `tool_policies` (`allow|block|ask`, default `ask`). `ask` → durable `approval_requests` row (`expiresAt` frozen at creation; swept every minute); process enters host-only `suspended` state (`pendingApprovalIds`, excluded from idle trim) and resumes via `ProcessService.notifyApprovalResolved`. Modules never set `suspended` themselves
- **Host-level auth** — services declare `schemes` + `security` (`ServiceDefinition extends AuthDefinition`; tool `security`: `undefined` = inherit, `[]` = anonymous). Credentials are owner-scoped (`service_credentials`/`module_credentials` + `*_credential_auth`, ≤1 per `(owner, scheme)`); oauth2 via shared `oauth_clients` (`provider` label + `availableScopes` required; PKCE `S256`, 10-min pendings). Adapters get `ConfigProvider`/`SecretsProvider`/`CredentialProvider` (`get`/`getCredential` only — never snapshots) via `generateService(string)` / `hydrateService(service: ServiceRuntime)`. Routes: nested `PUT|DELETE /:id/credentials/:scheme/...`, `POST .../oauth/authorize|code`, `GET /auth/callback`, top-level `/oauth-clients` CRUD + `/resolve`. Web `/authentication` lists OAuth clients only. Env: `CYRNEL_OAUTH_REDIRECT_BASE` (absolute URL, default `http://localhost:9371`), `CYRNEL_AUTH_REFRESH_INTERVAL_MS` (default `300000`, `0` = on-demand only)
- **Module examples are versioned**: `examples/5.0.0/` (not `examples/<type>/`)

## Workspace dependency graph

```
@cyrnel/api       → @cyrnel/sdk, @cyrnel/openapi, @cyrnel/typescript-ivm
@cyrnel/openapi   → @cyrnel/sdk
@cyrnel/typescript-ivm → @cyrnel/sdk
@cyrnel/web       → @cyrnel/sdk
@cyrnel/mcp       — no workspace deps
```

Changing `sdk`/`openapi`/`typescript-ivm`: update consumers in the same commit (`pnpm ls -r --depth 0` to find them) and add a changeset (only `@cyrnel/sdk` publishes). Cross-cutting config/env changes: mirror new vars in `apps/api/.example.env`, `DEVELOPERS.md`, and `docker-compose.yml`, then `pnpm build && pnpm typecheck`.

## Releasing (changesets)

Changeset config limits publishing to `packages/libs/**` (`baseBranch: main`). Apps/modules are private.

```bash
pnpm changeset          # create .changeset/*.md file, commit alongside code
# Don't hand-edit CHANGELOG.md
```

**`CYRNEL_CORE_VERSION` (`apps/api/src/constants.ts`) must mirror the SDK version** — it advertises the engine version custom modules validate `engines.cyrnel` against. `apps/api/src/constants.test.ts` fails CI on drift. `publish.yml` runs on any push to `main` (SDK → npm, api/web/mcp → ghcr.io).

## Package.json editing rules

Don't hand-edit `dependencies`/`devDependencies`/`peerDependencies` or CLI-settable scripts — use `pnpm -C <dir> add|remove|up <pkg>` (workspace deps: `--workspace`) so the lockfile stays in sync. Direct edits allowed only for `engines`, `exports`/`main`/`types`, `private`, `type`, `files`, `packageManager`, complex chained scripts. Commit `package.json` + `pnpm-lock.yaml` together.

## TypeScript conventions

- `strict: true`, ESM, `moduleResolution: "bundler"`, `target: ES2022`
- Path alias `@/*` → `src/*` (tsconfig paths + vitest `resolve.alias`)
- `import type { ... }` for type-only imports; Node built-ins use `node:` prefix
- `kebab-case` files in `apps/api/src/**`; `camelCase` fns/vars; `PascalCase` types
- Avoid `any` — prefer `unknown` + narrowing
- API logs: `pino`/`pino-http` with stable keys (`requestId`, `userId`, `adapterId`). Never log secrets

## Infra conventions (`apps/api/src/infra/`)

`infra/<subsystem>/` (`embedding/`, `logging/`, `search/`, `updater/`) holds generic stateful subsystems with their own lifecycle; domain wiring lives in `src/services/` (e.g. `log.service.ts`, search passthroughs on `services.service.ts`).

- Flat: one level of files per subsystem, no nested dirs, no `index.ts` barrels — import directly (`@/infra/logging/log-sink`); the subsystem entry may be `index.ts` (imported as the directory, e.g. `@/infra/logging`)
- One concern per file, co-located `*.test.ts`; subsystems own state/lifecycle and expose `init()`/`close()`
- **Dependency rule**: `services → infra` only — infra never imports `services/`/`controllers/`/`routes/`; cross-infra imports only `search → embedding`, except any layer may import `infra/logging`
- Services expose narrow methods (e.g. `initSearch()`), never the raw engine instance; the logger is imported directly from `infra/logging`, never via another service
