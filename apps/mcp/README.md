# Cyrnel MCP Server

Cyrnel is an open-source integration platform that connects AI applications to
any API or service. Think of it as a universal docking station for your AI
tools — instead of building custom integrations for every service, Cyrnel
handles the connection so you can focus on what matters.

This package is the **Cyrnel MCP server**. It exposes Cyrnel's tools and
services through the [Model Context Protocol (MCP)](https://modelcontextprotocol.io),
making them available to any MCP-compatible AI client like Opencode, Claude
Desktop, and others.

## Getting Started

Install and run directly with npx:

```bash
npx @cyrnel/mcp
```

Or install globally:

```bash
npm install -g @cyrnel/mcp
cyrnel-mcp
```

The server starts on port 3333 by default. Set the `CYRNEL_API_URL`
environment variable to point to your Cyrnel API instance.

### From source

```bash
pnpm install
pnpm build
pnpm start
```

This starts the Cyrnel API, web dashboard, and MCP server together.

## Using with an AI Client

Once running, point your MCP client to the server:

**HTTP mode (default):**

```json
{
  "mcpServers": {
    "cyrnel": {
      "url": "http://127.0.0.1:3333/sse"
    }
  }
}
```

**stdio mode:**

```json
{
  "mcpServers": {
    "cyrnel": {
      "command": "node",
      "args": ["path/to/apps/mcp/dist/index.js"],
      "env": {
        "MCP_TRANSPORT": "stdio",
        "CYRNEL_API_URL": "http://localhost:7687"
      }
    }
  }
}
```

## Resources

- [Cyrnel Documentation](https://actelos.mintlify.app/cyrnel/docs)
- [FAQ](https://actelos.mintlify.app/cyrnel/docs/faq)
- [Specifications](https://actelos.mintlify.app/cyrnel/specs)
- [GitHub Repository](https://github.com/actelos/mci)
- [Developer Setup Guide](./DEVELOPERS.md)

## Environment

The server can run in two transport modes:

- **HTTP**: Serves an SSE endpoint on port 3333
- **stdio**: Standard MCP transport for local use

Refer to `.example.env` for all available configuration options.

## License

MIT
