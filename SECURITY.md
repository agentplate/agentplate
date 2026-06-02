# Security Policy

Agentplate spawns autonomous AI agents that read and write code, run commands, and can deploy to
external targets. We take its security posture seriously.

## Reporting a vulnerability

Please **do not** open a public issue for security vulnerabilities. Instead, report them privately
via [GitHub Security Advisories](https://github.com/agentplate/agentplate/security/advisories/new) or by
email to the maintainers. We aim to acknowledge reports within 72 hours.

## Scope of particular interest

- **Secret handling:** API keys and deploy credentials must never be written to committed files,
  agent overlays, mail, audit logs, or distilled skills. Reports of secret leakage are high priority.
- **Command execution:** distilled skills and generated CI/CD config are scanned for dangerous
  commands before use. Bypasses of these guards are in scope.
- **Deploy safety:** outward-facing deploys are gated and audited. Reports of ungated or
  unauthenticated deploy paths are in scope.

## Supported versions

Agentplate is in early development; security fixes are applied to the latest release.
