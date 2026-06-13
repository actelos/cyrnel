# @cyrnel/web

## 1.0.0

### Major Changes

- c65ce9c: Initial release of the Cyrnel local web dashboard.

  A local-only SPA for managing processes, services, and modules on a Cyrnel instance.

  **Processes** — Monitor sandboxed TypeScript processes in real time. View state,
  output, stdout, stderr, and source code per process. Create, run, restart, and
  kill processes with confirmation dialogs for destructive actions.

  **Services** — Install and manage external service adapters. Filter by name,
  enabled state, and adapter type. Configure services via a JSON / JSON Patch
  editor, manage write-only secrets, and toggle individual tools on or off.

  **Modules** — Install adapter and environment modules from `.tar.zst` URLs.
  Reload all modules, enable/disable, update, and delete modules. Edit module
  configuration and secrets through the same editor.

  **Tech stack** — React 19, Vite 8, Tailwind CSS v4, shadcn/ui primitives, SWR
  for data fetching, Zod for runtime validation, and `react-router-dom` for
  client-side routing.
