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

## Usage

There are no releases yet. To use MCI, clone this repository and run it from
source with npm or pnpm.

Install dependencies:

```bash
pnpm install -r
uv venv --directory apps/mcp
uv pip install --python apps/mcp/.venv/bin/python -r apps/mcp/pyproject.toml
```

### Run the server

Build and start with:

```bash
pnpm build start
```
