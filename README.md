# Cyrnel

<img src="assets/banner.png" alt="Banner" style="width:100%; height:auto; display:block;">

<div>
  <a href="https://github.com/actelos/cyrnel/actions/workflows/check.yml?branch=main"><img src="https://img.shields.io/github/actions/workflow/status/actelos/cyrnel/check.yml?branch=main&style=for-the-badge" alt="CI status"></a>
  <a href="https://github.com/actelos/cyrnel/releases"><img src="https://img.shields.io/github/v/release/actelos/cyrnel?include_prereleases&style=for-the-badge" alt="GitHub release"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue.svg?style=for-the-badge" alt="MIT License"></a>
</div>

<br/>

Cyrnel is open-source software that enables fast, reliable, secure, and
efficient integration between LLM applications and APIs. It lets users plug in
any service over any protocol with any standard to any AI client and use it
efficiently at low cost.

Rather than a USB-C for AI applications, think of cyrnel as a modular docking
station. Instead of expecting all devices to use USB-C ports, we have one
powerful docking station that can connect to any port and communicate with any
service. If your port isn’t on the existing docking station, just make an
extension for it.

[Docs](https://actelos.mintlify.app/cyrnel/docs/introduction) · [FAQ](https://actelos.mintlify.app/cyrnel/docs/faq)

## Local Development

```bash
git clone https://github.com/actelos/cyrnel.git
cd cyrnel
pnpm i
```

- Read [DEVELOPERS.md](./DEVELOPERS.md) for more info.

## Docker

### Prerequisites

- [Docker](https://docs.docker.com/engine/install/) with Compose plugin

### Quick start

```bash
git clone https://github.com/actelos/cyrnel.git
cd cyrnel
docker compose up
```

This starts the API, web UI, and MCP server. The web UI is available at
`http://localhost:9372` and the API at `http://localhost:9371`.

### Configuration

Set environment variables in a `.env` file or pass them inline:

```bash
CYRNEL_API_KEY=sk-... CYRNEL_SECRETS_KEY=... docker compose up
```

Key variables:

| Variable | Default | Service |
|---|---|---|
| `CYRNEL_API_KEY` | _(required)_ | api |
| `CYRNEL_SECRETS_KEY` | _(required)_ | api |
| `CYRNEL_DB_URL` | `file:/data/cyrnel.db` | api |
| `CYRNEL_API_URL` | `http://api:9371` | web, mcp |
| `LOG_LEVEL` | `info` | api, mcp |

Full reference: [.example.env](apps/api/.example.env)

### Build images locally

```bash
docker compose build
```

Or build a single service:

```bash
docker compose build api
```

Images are tagged as `ghcr.io/actelos/cyrnel/{api,web,mcp}:latest` by default.
Override with `IMAGE_REGISTRY`, `IMAGE_REPO`, and `IMAGE_TAG` env vars.

## Learn More

Visit [our docs](https://actelos.mintlify.app/cyrnel/docs) or the
[deep wiki](https://deepwiki.com/actelos/cyrnel) to learn more about cyrnel.

## Contributing

Cyrnel is open source and we'd love to have your help. Whether you're fixing a
bug, improving the docs, or building modules, contributions of all kinds are
welcome.

- Read [CONTRIBUTING.md](./CONTRIBUTING.md) for guidelines on issues, pull
  requests, and what to do before you open a PR.
- Read [DEVELOPERS.md](./DEVELOPERS.md) to get your local environment set up and
  to understand how each workspace fits together.
- Browse issues tagged [`good first issue`](https://github.com/actelos/cyrnel/labels/good%20first%20issue)
  if you're looking for a place to start.

## Contributors

Thank you to everyone who has contributed to cyrnel. Every contribution moves
the project forward and is genuinely appreciated.

<a href="https://github.com/actelos/cyrnel/graphs/contributors">
  <img src="https://contributors.deno.dev/actelos/cyrnel?height=400&width=800" width="800" height="400" alt="cyrnel contributors" />
</a>
