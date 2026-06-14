# @cyrnel/web

The cyrnel local web dashboard for managing processes, services, and
modules on your Cyrnel instance.

This package ships a static SPA built with Vite and a production Node.js server
that serves it.

## Getting Started

```bash
npx @cyrnel/web
```

The dashboard starts on port 4173 by default. Open `http://localhost:4173` in
your browser.

### Install globally

```bash
npm install -g @cyrnel/web
cyrnel-web
```

## Configuration

The server reads runtime configuration from environment variables:

| Variable | Default | Description |
|---|---|---|
| `PORT` | `4173` | HTTP server port |
| `HOST` | `0.0.0.0` | Bind address |
| `CYRNEL_API_URL` | — | URL of the Cyrnel API instance |
| `CYRNEL_API_KEY` | — | API key for the Cyrnel API |

The dashboard connects to your cyrnel API at the configured `CYRNEL_API_URL`. If
not set, you can enter the URL and key in the Connect panel within the UI.

### Build-time variables (via `.env`)

When building from source, these can also be set as `VITE_CYRNEL_API_URL` and
`VITE_CYRNEL_API_KEY` via `.env` or `VITE_` prefixed environment variables.
Refer to `.example.env` for all available options.

## Resources

- [Cyrnel Documentation](https://actelos.mintlify.app/cyrnel/docs)
- [GitHub Repository](https://github.com/actelos/cyrnel)

## License

MIT
