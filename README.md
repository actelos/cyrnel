# MCI - The Model Control Interface

<img src="assets/banner.png" alt="Banner" style="width:100%; height:auto; display:block;">

<div>
  <a href="https://github.com/actelos/mci/actions/workflows/check.yml?branch=main"><img src="https://img.shields.io/github/actions/workflow/status/actelos/mci/check.yml?branch=main&style=for-the-badge" alt="CI status"></a>
  <a href="https://github.com/actelos/mci/releases"><img src="https://img.shields.io/github/v/release/actelos/mci?include_prereleases&style=for-the-badge" alt="GitHub release"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue.svg?style=for-the-badge" alt="MIT License"></a>
</div>

<br/>

MCI is software that enables secure, fast, reliable, and efficient integration
between LLM applications and external services.

MCI is an interface that lets users plug in any service over any protocol with
any standard and have models use it efficiently at low cost.

Rather than a USB-C for AI applications, think of MCI as a modular docking
station. Instead of expecting all devices to use USB-C ports, we have one
powerful docking station that can connect to any port and communicate with any
service. If your port isn’t on the existing docking station, just make an
extension for it.

[Docs](https://modelcontrolinterface.mintlify.app/content/introduction) · [FAQ](https://modelcontrolinterface.mintlify.app/content/faq)

## Repo Layout

| Path | Workspace | Purpose |
| --- | --- | --- |
| `apps/api` | `@mci/api` | The MCI HTTP server (Express, Drizzle, SQLite/libSQL). |
| `apps/web` | `@mci/web` | Admin UI (Vite + React + Tailwind). |
| `apps/mcp` | `@mci/mcp` | MCP server exposing MCI tools to MCP clients (`fastmcp`). |
| `packages/libs/sdk` | `@mci/sdk` | The TypeScript SDK every module implements. |
| `packages/modules/openapi` | `@mci/openapi` | Built-in adapter for OpenAPI services. |
| `packages/modules/typescript-ivm` | `@mci/typescript-ivm` | Built-in TypeScript environment (`isolated-vm`). |

## Prerequisites

- **Node.js** — pinned to `v22.x` (CI runs `v22`).
- **pnpm** — `pnpm@10.30.3` (declared in `packageManager`).

There are no published releases yet — MCI runs from source.

## Install

```bash
git clone https://github.com/actelos/mci.git
cd mci
pnpm i -r
```

This installs every workspace under `apps/*`, `packages/libs/*`, and
`packages/modules/*` in one pass. The `isolated-vm` native module is built
during this step.

## Configure

Copy the example env file for the API:

```bash
cp apps/api/.example.env apps/api/.env
```

Then **replace the example `MCI_SECRETS_KEY`** before doing anything that
stores secrets — the shipped value is a base64-encoded block of zero bytes,
which is the same as having no key at all.

```bash
openssl rand -base64 32
# paste the result into apps/api/.env as MCI_SECRETS_KEY=...
```

### `apps/api` env vars

| Variable | Default | Effect |
| --- | --- | --- |
| `PORT` | `7687` | HTTP listen port. |
| `SHUTDOWN_TIMEOUT_MS` | `10000` | Max ms to wait for in-flight requests before exit. |
| `LOG_LEVEL` | `info` / `debug` | One of `trace`, `debug`, `info`, `warn`, `error`, `fatal`, `silent`. |
| `MCI_API_KEY` | unset | When set, requests must carry `Authorization: Bearer <value>`. |
| `MCI_SECRETS_KEY` | unset (example is insecure) | AES-256-GCM key for service secrets. Base64, 32 bytes. |
| `MCI_DB_URL` | unset → `file:$MCI_DATA_DIR/mci.db` | libSQL URL. Use `libsql://<host>?authToken=…` for Turso. |
| `MCI_DATA_DIR` | `./` | Directory for `mci.db` and custom modules (`$MCI_DATA_DIR/modules/<name>/`). |

> ⚠️ The `MCI_SECRETS_KEY` shipped in `.example.env`
> (`AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=`) decodes to 32 NUL bytes.
> Anyone with `mci.db` can decrypt every stored secret. Generate a real key
> with `openssl rand -base64 32` before storing anything.

### `apps/web` env vars

`apps/web/.env`, baked into the bundle by Vite:

| Variable | Effect |
| --- | --- |
| `VITE_MCI_API_URL` | API URL the UI calls. |
| `VITE_MCI_API_KEY` | Bearer token, copied into the UI. |
| `VITE_AUTH_USERNAME` | Username the login form expects. |
| `VITE_AUTH_PASSWORD` | Password the login form expects. |

> ⚠️ All `VITE_*` values land in the **client bundle**. The login form is a
> UX gate, not an auth boundary. Don't deploy the web UI publicly with
> credentials baked in.

### `apps/mcp` env vars

| Variable | Default | Effect |
| --- | --- | --- |
| `MCP_TRANSPORT` | `http` | `http` or `stdio`. |
| `MCP_HTTP_HOST` | `127.0.0.1` | Bind host when HTTP. |
| `MCP_HTTP_PORT` | `3333` | Bind port when HTTP. |
| `MCI_API_URL` | `http://localhost:7687` | The MCI API the MCP server proxies to. |
| `MCI_API_KEY` | unset | Bearer token sent on every upstream request. |
| `MCI_API_TIMEOUT_MS` | `30000` | Upstream timeout. |

## Initialise the database

```bash
pnpm -C apps/api db:push
```

This creates `mci.db` in `MCI_DATA_DIR` (defaults to the API working
directory).

## Run

### One command, everything at once

```bash
pnpm dev
```

Turbo runs `dev` across every workspace in parallel:

- `@mci/api` — Express server on `:7687`
- `@mci/web` — Vite dev server on `:5173`
- `@mci/mcp` — `fastmcp` HTTP server on `:3333`

### One workspace at a time

```bash
pnpm -C apps/api dev   # API on :7687
pnpm -C apps/web dev   # Web UI on :5173
pnpm -C apps/mcp dev   # MCP server on :3333 (or stdio — see below)
```

For stdio MCP transport:

```bash
MCP_TRANSPORT=stdio pnpm -C apps/mcp dev
```

### Production-style

```bash
pnpm build
pnpm start
```

## Talk to the API

```bash
curl http://localhost:7687/modules
# { "modules": [ { "id": "openapi", ... }, { "id": "typescript-ivm", ... } ] }
```

If you set `MCI_API_KEY`, every request needs `Authorization: Bearer <key>`.
Anonymous mode (key unset) is intended for `127.0.0.1` only.

### Submit a process

```bash
curl -X POST http://localhost:7687/processes \
  -H 'content-type: application/json' \
  -d '{"code":"mci.output({ hello: 42 });","block":true}'
# { "pid": 1 }

curl http://localhost:7687/processes/1/output
# { "hello": 42 }
```

## Authentication

The MCI API supports one optional mechanism: a static bearer token. Set
`MCI_API_KEY` and send `Authorization: Bearer <value>` on every request. The
middleware compares with `crypto.timingSafeEqual`; a missing or non-matching
token returns `401 { "error": "Unauthorized" }`.

There's no rotation flow — update `MCI_API_KEY` in the API's env (and in
the MCP server / web UI) and restart. There is a brief `401` window during
the restart.

## Common Pitfalls

- **`isolated-vm` fails to build.** You're on the wrong Node version. Use
  Node 22. The build also needs a working C toolchain.
- **`Secrets key is not configured` (500 from `/services/.../secrets`).**
  `MCI_SECRETS_KEY` isn't set, or the decoded value isn't 32 bytes. Run
  `openssl rand -base64 32` and paste the output.
- **Web UI can't reach the API.** `VITE_MCI_API_URL` is read at build time;
  changing `.env` requires restarting the Vite dev server.
- **Modules list is empty after `db:push`.** Hit `POST /modules/reload` (or
  restart the API) — built-in modules are reconciled on the first startup.
