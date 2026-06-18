# Cyrnel API

Cyrnel is an open-source integration platform that connects AI applications to
any API or service. Think of it as a universal docking station for your AI
tools, instead of building custom integrations for every service, Cyrnel
handles the connection so you can focus on what matters.

This package is the **Cyrnel core API server**. It manages modules (adapter and
environment plugins), services (installed API integrations), tools (callable
operations), and process execution (sandboxed TypeScript runtime). The API
exposes a REST interface consumed by the web dashboard, MCP server, and
opencode agent.

## Getting Started

### npx

```bash
npx @cyrnel/api
```

The server listens on port 7687 by default. Set the `AUTH_TOKEN` and
`ENCRYPTION_KEY` environment variables to secure your instance.

### From source

From the repository root:

```bash
pnpm install
pnpm build
pnpm start
```

This starts the Cyrnel API, web dashboard, and MCP server together.

### Standalone

```bash
pnpm -C apps/api build
pnpm -C apps/api start
```

## Configuration

Copy `.example.env` to `.env` and configure at minimum:

| Variable | Default | Description |
|---|---|---|
| `PORT` | `7687` | HTTP listen port |
| `AUTH_TOKEN` | - | API authentication token (required) |
| `ENCRYPTION_KEY` | - | Key for encrypting stored secrets |
| `TURSO_DB_URL` | `file:data.db` | SQLite database path (libsql) |

See `.example.env` for the full list.

## API Overview

The REST API is organized around these resources:

- **Modules**: Register, configure, enable/disable adapter and environment
  plugins
- **Services**: Install API integrations from registries or direct URLs
- **Tools** Discover and invoke operations provided by installed services
- **Processes**: Execute sandboxed TypeScript code via the environment module

An OpenAPI definition is generated at build time in `openapi.json`.

## Resources

- [Cyrnel Documentation](https://actelos.mintlify.app/cyrnel/docs)
- [FAQ](https://actelos.mintlify.app/cyrnel/docs/faq)
- [Specifications](https://actelos.mintlify.app/cyrnel/specs)
- [GitHub Repository](https://github.com/actelos/mci)

## License

MIT
