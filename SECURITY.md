# Security Policy

## Reporting a vulnerability

**Please do not open a public GitHub issue, pull request, or discussion for
security problems.** Public disclosure before a fix is available puts
existing users at risk.

Report vulnerabilities privately through GitHub Security Advisories:

> <https://github.com/actelos/cyrnel/security/advisories/new>

A good report includes:

- A description of the issue and the impact you believe it has.
- The affected component (`apps/api`, `apps/mcp`, `apps/web`, or one of
  the `packages/*`) and, if possible, the commit SHA you reproduced on.
- Steps to reproduce, or a minimal proof of concept.
- Any suggested remediation, if you have one in mind.

## What to expect

- **Acknowledgment:** within **5 business days** of your report.
- **Triage:** we will confirm whether the issue is in scope, ask follow-up
  questions if needed, and share an initial severity assessment.
- **Status updates:** at least once every **30 days** until the report is
  closed.
- **Fix and disclosure:** once a fix is ready, we will coordinate a release
  and a public advisory. We are happy to credit reporters who want
  attribution; if you prefer to remain anonymous, just say so in the
  report.

If a report is declined (e.g., it is out of scope, by design, or
unreproducible), we will explain the reasoning so you can decide whether to
follow up with more detail.

## Scope

In scope:

- Code in this repository (`apps/`, `packages/`, and supporting
  infrastructure such as CI workflows, Dockerfiles, and migrations).
- The default configuration shipped with cyrnel.

Out of scope:

- Vulnerabilities in third-party dependencies that do not have a viable
  exploitation path through cyrnel — please report those upstream.
- Issues that require a privileged account, attacker-controlled module
  installation, or other prerequisites that effectively grant code
  execution on the host.
- Self-XSS, missing security headers without a concrete exploitation path,
  rate-limiting on non-sensitive endpoints, and other findings commonly
  filed by automated scanners without manual validation.

Thanks for helping keep cyrnel and its users safe.
