<p align="center">
  <img src="assets/agentplate-logo.svg" alt="Agentplate" width="380" />
</p>

<p align="center">
  <strong>Self-improving multi-agent orchestration — from idea to deployed app.</strong>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@agentplate/cli"><img src="https://img.shields.io/npm/v/@agentplate/cli?color=fb4b38&amp;label=npm" alt="npm version" /></a>
  <img src="https://img.shields.io/badge/runtime-Bun-fb4b38" alt="Runtime: Bun" />
  <a href="#license"><img src="https://img.shields.io/npm/l/@agentplate/cli?color=fb4b38" alt="MIT License" /></a>
</p>

<p align="center">
  Spawn AI agent swarms in isolated git worktrees, coordinate them over a SQLite
  mail bus, and merge their work back. An interactive wizard picks your AI
  provider, a closed learning loop distills reusable skills as agents work, and a
  built-in pipeline takes you from <em>build → configure CI/CD → deploy</em> to the
  target of your choice — all observable from a CLI, a live TUI, and a web UI.
</p>

<p align="center">
  <a href="#quick-start">Quick start</a> ·
  <a href="#features">Features</a> ·
  <a href="#commands">Commands</a> ·
  <a href="#architecture">Architecture</a> ·
  <a href="#contributing">Contributing</a>
</p>

---

> **v1.0.0 — first public release.** The orchestration engine, provider wizard,
> self-improving skills, multi-runtime support, the web UI (`agentplate serve`),
> and the build→deploy pipeline are all working and tested.

## Why Agentplate

Most "AI coding agent" tools give you *one* agent in *one* session. Agentplate turns a
single command into a **team**: it spawns specialized worker agents in isolated git
worktrees, coordinates them through a fast SQLite message bus, folds their work back
with tiered conflict resolution — and then **gets better the more you use it** by
distilling reusable skills from work that passed its quality gates.

## Features

- **🧙 Interactive setup wizard.** `agentplate setup` walks you through provider
  selection (Anthropic, OpenAI, OpenRouter, DeepSeek, Google, local/Ollama, or a
  custom OpenAI-compatible endpoint) and then **how to authenticate** — reuse an
  existing **subscription / CLI login** (e.g. a Claude Pro/Max session in Claude Code,
  `codex login`, or the Gemini CLI — no key stored), an **existing environment
  variable**, or **enter an API key** (saved to a **gitignored** secrets file). Switch
  any time with `agentplate model`. Models below a 64k context floor are rejected.
- **🤖 Agent-swarm orchestration.** A `coordinator → lead → workers` hierarchy runs
  agents (scout, builder, reviewer, merger…) in isolated worktrees, coordinates them
  over `.agentplate/mail.db`, and merges branches back with a clean → auto-resolve tiered
  strategy. Headless **spawn-per-turn** execution — no tmux required.
- **📈 Self-improving skills.** After an agent completes a task whose quality gates
  pass, Agentplate distills a reusable, versioned **skill** (a markdown playbook). Future
  agents retrieve the relevant skills into their context, apply them, and the skills
  earn or lose **confidence** from real outcomes — so the swarm compounds expertise.
- **🚀 Build → CI/CD → Deploy.** A staged pipeline (architect → builder → devops →
  deployer → verifier) scaffolds an app, generates CI/CD + infrastructure, and ships
  it. Pluggable **deploy targets** (Docker + GitHub Actions today; PaaS, cloud,
  Kubernetes/Helm, and on-prem are adapter files). One command:
  `agentplate ship "an idea" --target docker-gha`.
- **🛡️ Safe by construction.** Secrets live only in env-vars / a gitignored store and
  are injected solely into the deployer process — never committed, logged, or audited.
  Production deploys require an explicit gate (`--yes`); `--dry-run` generates config
  and plans with **zero** outward mutation; every deploy is recorded in an append-only
  audit log. Distilled skills are scrubbed for secrets and dangerous commands.
- **🖥️ Three surfaces.** A CLI, a **3-pane `agentplate tui`** (active agents / live feed /
  tasks), and a modern **"agent OS" web UI** (`agentplate serve`) — an icon-rail shell with a
  Mission Control dashboard, an animated **3D Office** where agents sit and type, stand when
  idle, and walk to the whiteboard to talk when they hand off tasks (React Three Fiber), a real
  **System Monitor** (host CPU/RAM/disk/uptime), **Costs & Analytics** charts, **Tasks** and
  **Handoffs** views, a terminal-style live feed, per-agent detail drawers, a notification
  center, a **⌘K command palette**, and a chat to message the coordinator and submit tasks.
  Everything auto-refreshes every 5 seconds.
- **💬 Conversational coordinator.** `agentplate coordinator start` opens an interactive
  Claude session primed as your orchestrator — describe what you want built and it dispatches
  the team.

## Requirements

- **[Bun](https://bun.sh) `>= 1.0`** — Agentplate runs on Bun (the CLI bin uses a
  `#!/usr/bin/env bun` shebang). Plain Node.js is **not** sufficient; install Bun first
  (`curl -fsSL https://bun.sh/install | bash`).
- `git`
- A coding-agent runtime — **Claude Code** (default), **OpenCode**, or **Codex** — and an API
  key (or subscription login) for your provider. Pick one in `agentplate setup`, or per
  command with `--runtime <claude|opencode|codex>`.

## Install

```bash
# From npm (requires Bun on your PATH):
npm install -g @agentplate/cli      # or: bun install -g @agentplate/cli
agentplate --version
```

Or from source:

```bash
git clone https://github.com/agentplate/agentplate.git
cd agentplate && bun install && bun link   # puts `agentplate` (and `ap`) on your PATH
```

## Quick start

```bash
# In YOUR project:
cd ~/my-project
agentplate setup            # interactive: provider → API key → model → runtime
agentplate doctor           # verify everything is wired

# Orchestrate
agentplate coordinator start
agentplate sling TASK-1 --capability builder   # spawn a worker in a worktree
agentplate status                              # see runs / agents / worktrees
agentplate merge --all                         # fold completed work back

# Watch it live
agentplate tui              # terminal dashboard
agentplate serve            # web UI at http://127.0.0.1:7551

# Ship it
agentplate target detect                          # what kind of app is this?
agentplate ship "a URL shortener" --target docker-gha --dry-run   # plan, no deploy
agentplate ship "a URL shortener" --target docker-gha --env production --yes
```

## Commands

| Command | What it does |
|---|---|
| `agentplate setup` | Interactive provider/model/runtime wizard |
| `agentplate init` | Non-interactive `.agentplate/` scaffold |
| `agentplate model` | Switch the active provider/model |
| `agentplate doctor` | Health checks (`--category core\|providers\|deploy`) |
| `agentplate coordinator` | Start/stop the top-level orchestration session |
| `agentplate sling <task>` | Spawn a worker agent (`--capability`, `--files`, `--parent`…) |
| `agentplate status` | Runs, agent sessions, worktrees |
| `agentplate mail` | Inter-agent messaging (send/check/list/reply/purge) |
| `agentplate merge` | Fold agent branches back (`--branch`/`--all`, `--dry-run`) |
| `agentplate worktree` | List / clean agent worktrees |
| `agentplate stop <agent>` | Terminate an agent session |
| `agentplate skill` | The self-improving skill library (list/show/search/record/outcome/prune…) |
| `agentplate target` | Inspect/detect/configure deploy targets |
| `agentplate deploy` | Gate → generate → deploy → verify → audit |
| `agentplate ship [idea]` | One-shot build → CI/CD → deploy pipeline |
| `agentplate rollback` | Roll a target back to its last successful deploy |
| `agentplate serve` | Web UI (HTTP + WebSocket) |
| `agentplate tui` | Live terminal dashboard |
| `agentplate prime` / `log` | Hook targets (context priming / event logging) |

Run `agentplate <command> --help` for full options. Every command supports `--json`.

## Architecture

```
your Claude Code session  ─┐
                           │  agentplate CLI
  coordinator ─────────────┤
    └─ lead                │   • git worktrees (isolated per agent)
        ├─ scout           │   • SQLite mail bus (.agentplate/mail.db, WAL)
        ├─ builder         │   • spawn-per-turn headless runtimes
        ├─ reviewer        │   • tiered merge (clean → auto-resolve)
        └─ merger          │   • self-improving skills (retrieve→apply→distill→score)
  ship-lead ───────────────┤   • deploy targets (docker-gha, …) behind gates + audit
    architect → builder → devops → [gate] → deployer → verifier
```

- **Runtimes** (`src/runtimes/`) — pluggable coding-agent adapters (Claude Code +
  a deterministic mock for tests). One file per CLI, resolved by a registry; auth via
  env-by-name, never hardcoded.
- **Deploy targets** (`src/deploy/`) — the *same* adapter pattern for shipping:
  `detect → generateConfig → deploy → verify → rollback`. Adding a target is one file.
- **Skills** (`src/skills/`) — markdown+frontmatter playbooks with an append-only
  outcome log and a Wilson-confidence score; retrieved into agent overlays, distilled
  by a gated AI step from work that passed.
- **State** — everything lives under `.agentplate/` (config, worktrees, specs, skills,
  and SQLite DBs for mail/sessions/events/merge/deploys). Secrets are gitignored.

All built on Bun + TypeScript (strict), formatted/linted with
[Biome](https://biomejs.dev), tested with `bun test` (real temp git repos and SQLite,
not mocks).

## Development

```bash
bun test          # run tests
bun run lint      # biome check .
bun run typecheck # tsc --noEmit
bun run check     # all three
bun run build:ui  # build the web UI into ui/dist
```

## Contributing

Contributions welcome — see [CONTRIBUTING.md](./CONTRIBUTING.md) and
[SECURITY.md](./SECURITY.md). Agentplate is MIT-licensed.

## License

[MIT](./LICENSE) © Agentplate contributors
