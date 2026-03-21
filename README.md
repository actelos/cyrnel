# MCI - The Model Control Interface

<img src="assets/banner.png" alt="Banner" style="width:100%; height:auto; display:block;">

<div>
  <a href="https://github.com/actelos/mci/actions/workflows/ci.yml?branch=main"><img src="https://img.shields.io/github/actions/workflow/status/actelos/mci/ci.yml?branch=main&style=for-the-badge" alt="CI status"></a>
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

[Docs](https://modelcontrolinterface.mintlify.app/server/introduction) · [FAQ](https://modelcontrolinterface.mintlify.app/server/faq)

## Usage

There are no releases yet. To use MCI, clone this repository and run it from
source with npm or pnpm.

### Configuration

The server requires a valid configuration before it can start. The
configuration directory must be located at `~/mci/` or provided through the
`MCI_CONFIG_DIR` environment variable.

The required configuration file is `modules.toml`:

```toml
[localjsenv]
path="./modules/localjs.mjs"

[localpyenv]
path="./modules/localpy.mjs"
```

The module files referenced by this configuration can be found in the
[mci-module](https://github.com/actelos/mci-module) repository.

### Run the server

Start the server with:

```bash
pnpm run start
```
