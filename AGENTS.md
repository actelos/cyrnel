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

- **The `ask` approval gate has no enforced trust boundary (open)** — `POST /approvals/:id/{approve,deny}` sits behind the same `apiKeyMiddleware` as everything else, and there is exactly one principal. An agent that can reach the API can approve its own gated call, which defeats the point of `ask`. It is worse than that when `CYRNEL_API_KEY` is unset, since `apiKeyMiddleware` short-circuits to `next()` and the whole API is open. Fixing it means a principal/scope model (agent scope excludes `approvals:decide`), not a patch — and `manual` mode's `approve_approval`/`deny_approval` tools need the same gate or they become a self-approval vending machine
- **`db:generate` is broken (open)** — drizzle-kit 0.31.10 reports `00xx_snapshot.json data is malformed` for snapshots 0018-0021 and exits without generating, on unmodified schemas too. `db:migrate` still works (it reads the journal, not the snapshots). Until fixed, hand-write the `.sql` + journal entry + next snapshot, then `db:migrate`
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
- **Ordered tool policy rules** — `ModuleService.invoke` gates every call against `tool_policy_rules` (first match in ascending `position` order wins, otherwise immutable `ask` default; no per-tool rows, no policy sync on service refresh). `ask` → durable `approval_requests` row (`expiresAt` frozen at creation; swept every minute); process enters host-only `suspended` state (`pendingApprovalIds`, excluded from idle trim) and resumes via `ProcessService.notifyApprovalResolved`. Modules never set `suspended` themselves. Rules CRUD at `/tool-policies` (`PUT /tool-policies/order` reorders, `GET /tool-policies/:id/affected-tools` previews); effective policies carry `source` provenance (`rule` or `default`)
- **Credential preflight precedes the policy gate** — `validateToolCredentials` (`modules.service.ts`) runs *before* policy resolution so a doomed call never burns a human approval. It reads `tools.security` (the operation's own clause), never the service-level `default_security`: OpenAPI definitions that declare security per operation (Google Discovery documents) leave the service clause empty, and reading it skips validation for exactly the services that need it. An OAuth credential must hold the scopes the operation asks for, not merely any non-empty grant (`missingScopes`); scope satisfaction is part of the requirement decision, not a post-check. Empty requirements mean the operation genuinely needs no auth. Preflight failures are a bare `403` with no error `code`, and the sandbox exposes no `statusCode` property — match on the message
- **`processes.ref` is a client correlation label, not an identity** — partial unique index `processes_ref_active_unique` over live states only (`queued`/`running`/`suspended`/`terminating`); settled processes (`idle`/`terminated`) release the label, and a parked `autorun: false` process rests in `idle` so it holds nothing. `ProcessService.assertRefIsFree` reads ahead for a clean `409`/`process_ref_conflict`, with an insert-violation backstop for the race the read can't close. The message deliberately discloses no id, state, or owner. Keep `REF_HOLDING_STATES` in `process.service.ts` in sync with the index predicate
- **MCP approval transport** — `apps/mcp` only *presents* approvals; policy and decisions stay in the API. `CYRNEL_MCP_APPROVAL_METHOD=elicitation|manual` (default `elicitation`, invalid fails startup). `waitForProcess` (`process.ts`) is shared by `create_process`/`run_process`: `suspended` **plus** non-empty pending approvals is required before acting (never equate `suspended` with approval). `elicitation` drives one `ctx.elicit` per approval (fastmcp ≥4.22, needs client `elicitation: { form: {} }`); accept+`approved:true` → approve, accept+false/`decline`/`cancel` → deny. Presenter seam is `McpApprovalPresenter` (`inBand: false` = manual → return suspended to the caller). Approval params are redacted/truncated (`summarizeParameters`) before prompts or logs; elicit payloads carry only a boolean so a client can never name an approval id. Manual mode adds `list_pending_approvals`/`approve_approval`/`deny_approval` — **which lets the model satisfy its own `ask` gate; that trust boundary is unresolved, see Gotchas**. MCP never auto-decides. Three separate budgets, never collapse them: run deadline (`timeoutS * 1000 + 1000`), non-approval suspension ceiling (10 min), and `APPROVAL_WAIT_BUDGET_MS` (25s, per prompt). The per-prompt budget must stay below the MCP client's request timeout or the client gives up first, loses the process id with the response, and orphans the process; `presentWithinBudget` returns the suspended record instead and leaves the prompt in flight so a late answer still resolves
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

## Research & Examples

If you are unsure how to implement something, use `gh_grep` to search for code examples on GitHub. This searches real-world usage patterns across public repositories.

## Documentation Lookup

When you need to search docs, use `context7` tools. Use `context7_resolve-library-id` to find the library ID, then `context7_query-docs` to fetch current documentation. Do this for any library, framework, SDK, API, CLI tool, or cloud service — even well-known ones like React, Next.js, Prisma, Express, Tailwind, Django, or Spring Boot. Your training data may not reflect recent changes.
