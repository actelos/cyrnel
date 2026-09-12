---
"@cyrnel/sdk": major
---

**BREAKING** Replace snapshot config/secrets with scope-bound providers, add the host-level auth contract, and tighten the execution contract for process-backed approvals.

Provider model:

- `ModuleSetupContext` no longer delivers `config`/`secrets` as plain `Record<string, unknown>` snapshots or a log-bindings generic. It is now `ModuleSetupContext<Config, Secrets>` with `config: ConfigProvider<Config>`, `secrets: SecretsProvider<Secrets>`, and `credentials?: CredentialProvider` (present iff the module declares `auth`). Providers are scope-bound with single-key `get()` only: undeclared keys throw `ProviderKeyNotDeclared`, declared-but-unset keys throw `ProviderKeyNotConfigured`, and reads never return `undefined` (see `ConfiguredValue<T>`).

Auth contract:

- New `AuthScheme` discriminated union: `ApiKeyAuthScheme` (`header`/`query`/`cookie`), `BasicAuthScheme`, `HttpAuthScheme` (bearer only; `bearerFormat` informational), and `OAuth2AuthScheme` (`authorizationCode`/`clientCredentials`/`deviceCode` grants, no `pkceChallengeMethod` — the host always enforces `S256`). `private_key_jwt` client assertions stay host-internal; modules only ever see the resulting `oauth2` credential.
- New `SecurityRequirement`/`SecurityRequirements`: OR-of-AND groups mapping scheme names to scopes. Scope arrays MUST be empty for non-OAuth2 schemes. Adapters resolve multi-branch requirements deterministically (first satisfiable group in declaration order). New `AuthDefinition` (`schemes` + `security`, both required; `schemes: {}` / `security: []` mean "none").
- New `ResolvedCredential` (`apiKey`/`basic`/`bearer`/`oauth2`) and scope-bound `CredentialProvider.getCredential(schemeName)`; credentials are owner-scoped with at most one per `(owner, scheme)`, so resolution is unambiguous. The oauth2 variant carries the provider-granted scopes and adapters enforce required scopes against them (fail closed).
- New shared `OAuthClient` registration type: required display-only `provider` plus required `availableScopes` (`[]` = unscoped-only client, fail closed).
- `ModuleExport` gains optional `auth?: AuthDefinition` (a present value must declare at least one scheme). `ServiceDefinition` now `extends AuthDefinition`, so `schemes`/`security` are required on every definition.
- `ToolDefinition` gains the three-way `security` override: `undefined` inherits the service default, `[]` is explicitly anonymous, non-empty fully overrides. `ToolState` now carries `adapterDomain` + `security`.
- `ServiceState` is replaced by `ServiceRuntime`: providers instead of copied config/secrets snapshots, explicit required `schemes`/`security`, optional `credentials` (present iff `schemes` is non-empty), and no exposed credential IDs.
- `AdapterModule.generateDefinition(input)` is renamed to `generateService(input)`, and `hydrateService(state: ServiceState)` becomes `hydrateService(service: ServiceRuntime)`. The `AdapterSetupContext` alias is removed; `InvokeInput` gains a `Parameters` generic.

Execution contract:

- `ExecutionInput` renames `eid` → `executionId` and now requires both `executionId` and `processId` (every execution is process-backed for approval and policy tracking). `envConfig` gains a `RuntimeConfig` generic.
- `EnvironmentModule.resume(eid, remainingMs?)` becomes `resume(executionId)` — the host owns timeout accounting; resume only pauses/resumes execution machinery. `execute`/`kill`/`suspend` parameters are renamed `eid` → `executionId` (positional, call-compatible).
- New `EnvironmentModuleExport`: environment default exports must declare `executionConfigSchema` (use `{ type: "object", properties: {}, additionalProperties: false }` to accept none). `EnvironmentSetupContext` is now generic over `Config`/`Secrets`, and `EnvironmentBindings` lifecycle methods rename `eid` → `executionId` (positional, call-compatible).

### Migration

- Read config/secrets via `await context.config.get("key")` / `await context.secrets.get("key")` instead of property access; handle `ProviderKeyNotConfigured` for unset keys.
- Add `schemes: {}` / `security: []` (or real auth declarations) to every constructed `ServiceDefinition`; rename `generateDefinition` → `generateService` and update `hydrateService` to accept `ServiceRuntime`.
- Remove `AdapterSetupContext` imports (use `ModuleSetupContext<Config, Secrets>`); tool-level auth goes on `ToolDefinition.security`.
- Replace `input.eid` with `input.executionId` and always pass `processId` in `ExecutionInput`; drop the `remainingMs` argument from `resume()` calls and add `executionConfigSchema` to environment module default exports.
