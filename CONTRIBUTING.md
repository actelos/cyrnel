# Contributing to Cyrnel

Thank you for contributing to cyrnel! We'd love to have your help making cyrnel better.

[1. Getting Started](#getting-started)
[2. Issues](#issues)
[3. Pull Requests](#pull-requests)

## Getting Started

To ensure a positive and inclusive environment, please read our [Code of Conduct](./CODE_OF_CONDUCT.md) before contributing. For help setting up the repo locally, follow the [DEVELOPERS.md](./DEVELOPERS.md) guide.

## Issues

If you find a bug, please create an Issue and we'll triage it.

- Please search [existing Issues](https://github.com/actelos/cyrnel/issues) before creating a new one.
- Please include a clear description of the problem along with steps to reproduce it. Exact steps with screenshots and API request/response payloads really help here.
- For security vulnerabilities, do not open a public issue, instead follow the process in [SECURITY.md](./SECURITY.md).

## Pull Requests

We actively welcome your Pull Requests! A couple of things to keep in mind before you submit:

- If you're fixing an Issue, make sure someone else hasn't already created a PR fixing the same issue. Likewise, make sure to link your PR to the related Issue(s).
- We will always try to accept the first viable PR that resolves the Issue.
- If you're new, we encourage you to take a look at issues tagged with [good first issue](https://github.com/actelos/cyrnel/labels/good%20first%20issue).
- If you're submitting a new feature or a new module, make sure you have opened a [Discussion](https://github.com/orgs/actelos/discussions/new/choose) first. We'd love to accept your hard work, but if a feature or module hasn't gone through a design discussion, the PR will be closed.
- Please use the PR template and provide detailed context for quicker review. PRs without a clear problem statement will be closed.

Prior to submitting your PR, please run the following pre-flight checks locally:

- Run `pnpm build` to make sure everything compiles across all workspaces.
- Run `pnpm check:fix` to ensure Biome lint and formatting pass.
- Run `pnpm typecheck` to catch any TypeScript errors.
- Run `pnpm test` to make sure no existing tests are broken.

Running these before you open the PR will reduce back and forth with the team.
