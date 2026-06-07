# Cyrnel

<img src="assets/banner.png" alt="Banner" style="width:100%; height:auto; display:block;">

<div>
  <a href="https://github.com/actelos/cyrnel/actions/workflows/check.yml?branch=main"><img src="https://img.shields.io/github/actions/workflow/status/actelos/cyrnel/check.yml?branch=main&style=for-the-badge" alt="CI status"></a>
  <a href="https://github.com/actelos/cyrnel/releases"><img src="https://img.shields.io/github/v/release/actelos/cyrnel?include_prereleases&style=for-the-badge" alt="GitHub release"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue.svg?style=for-the-badge" alt="MIT License"></a>
</div>

<br/>

Cyrnel is software that enables secure, fast, reliable, and efficient integration
between LLM applications and external services.

Cyrnel is an interface that lets users plug in any service over any protocol with
any standard and have models use it efficiently at low cost.

Rather than a USB-C for AI applications, think of cyrnel as a modular docking
station. Instead of expecting all devices to use USB-C ports, we have one
powerful docking station that can connect to any port and communicate with any
service. If your port isn’t on the existing docking station, just make an
extension for it.

[Docs](https://actelos.mintlify.app/content/introduction) · [FAQ](https://actelos.mintlify.app/content/faq)

## Prerequisites

- **Node.js** — pinned to `v22.x` (CI runs `v22`).
- **pnpm** — `pnpm@10.30.3` (declared in `packageManager`).

There are no published releases yet — cyrnel runs from source.

## Install

```bash
git clone https://github.com/actelos/cyrnel.git
cd cyrnel
pnpm i -r
```

## Configure

Copy the example env file for the API:

```bash
for app in api mcp web; do cp "apps/$app/.example.env" "apps/$app/.env"; done
```

Then **replace the example `CYRNEL_SECRETS_KEY`** before doing anything that
stores secrets — the shipped value is a base64-encoded block of zero bytes,
which is the same as having no key at all.

```bash
openssl rand -base64 32
```

## Initialise the database

```bash
pnpm -C apps/api db:push
```

This creates `data.db` in `CYRNEL_DATA_DIR` (defaults to the API working
directory).

## Run

### One command, everything at once

```bash
pnpm build
pnpm start
```

After building, `pnpm start` runs every workspace in parallel:

- `@cyrnel/api` — Express server on `:7687`
- `@cyrnel/web` — Vite dev server on `:5173`
- `@cyrnel/mcp` — `fastmcp` HTTP server on `:3333`

## Talk to the API

### Modules

```bash
# List installed modules
curl http://localhost:7687/modules

# Get a single module (includes hash, source, config/secrets schemas)
curl http://localhost:7687/modules/openapi

# Install a module from a .tar.zst archive URL
curl -X POST http://localhost:7687/modules/install \
  -H 'content-type: application/json' \
  -d '{"source":"https://example.com/module.tar.zst"}'

# Update a module (re-download from its stored source)
curl -X POST http://localhost:7687/modules/openapi/update \
  -H 'content-type: application/json' \
  -d '{}'

# Delete a module (removes its services, database record, and disk directory)
curl -X DELETE http://localhost:7687/modules/openapi

# Enable / disable a module
curl -X POST http://localhost:7687/modules/openapi/enabled \
  -H 'content-type: application/json' \
  -d '{"enabled":false}'

# Reload the on-disk module registry
curl -X POST http://localhost:7687/modules/reload \
  -H 'content-type: application/json' \
  -d '{}'
```

If you set `CYRNEL_API_KEY`, every request needs `Authorization: Bearer <key>`.
Anonymous mode (key unset) is intended for `127.0.0.1` only.

### Submit a process

```bash
curl -X POST http://localhost:7687/processes \
  -H 'content-type: application/json' \
  -d '{"code":"cyrnel.output({ hello: 42 });","block":true}'
# { "pid": 1 }

curl http://localhost:7687/processes/1/output
# { "hello": 42 }
```
