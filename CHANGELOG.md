# Changelog

All notable changes to Agentplate are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/), and the project aims to adhere to
[Semantic Versioning](https://semver.org/).

## [1.0.0] — 2026-06-01

Initial public release of Agentplate as `@agentplate/cli`.

### Highlights

- **Swarm orchestration.** Turn a single coding-agent session into a multi-agent
  team — spawn workers in isolated git worktrees, coordinate them over a custom
  SQLite mail bus, and merge their work back with tiered conflict resolution.
- **Hierarchical agents.** Coordinator → leads → specialist workers
  (builder / scout / reviewer / merger), with a configurable delegation depth. The
  coordinator is a dispatch-only orchestrator: it decomposes a goal into parallel
  slices and hires a lead per slice via `agentplate sling` rather than editing files
  itself.
- **Headless spawn-per-turn engine.** Each agent turn is a fresh runtime subprocess
  driven by the mail bus — no long-lived process, no tmux.
- **Web UI (`agentplate serve`).** A control center with a Mission Control
  dashboard, a live host **System Monitor**, an animated **3D Office**, **Costs**,
  **Tasks**, **Handoffs**, an activity feed, per-agent detail drawers, a notification
  center, and a ⌘K command palette.
- **Observability.** `ap status`, `dashboard`, `inspect`, `trace`, `feed`, `logs`,
  `errors`, `replay`, `costs`, and `metrics` over shared SQLite event/session stores.
- **Build → CI/CD → deploy.** Pipeline agents and pluggable deploy-target adapters
  with an append-only audit trail and explicit production gates.
- **Self-improving skills.** Distill reusable skills from successful tasks, ranked by
  Wilson-confidence and retrieved into agent overlays, safety-scrubbed before any write.

### Runtimes & providers

- **Runtime adapters** for Claude Code, Codex, OpenCode, Gemini (beta), and Cursor
  (beta) — each driving its CLI headless and reusing the CLI's own OAuth login when
  the provider uses `subscription` auth.
- **Provider-agnostic prompts** that reference the runtime's own overlay file
  (`CLAUDE.md` / `AGENTS.md` / `GEMINI.md`).
- **Curated, current model catalogs** with a setup wizard that always allows a custom
  model id.
- **Cross-platform.** Validated on macOS/Linux with guarded Windows code paths for
  runtime CLI detection and spawning.

### Lifecycle & safety

- **Sling-only spawning.** Agentplate-driven sessions disable a runtime's native
  sub-agent tools so every teammate is spawned through `agentplate sling` and tracked.
- **Idle-agent reaper.** Workers idle past `agents.idleTimeoutMinutes` (default 10) are
  terminated and cleaned up; runs while `ap serve` is up and on demand via
  `agentplate reap`. The coordinator is never reaped.
- **Secrets by env-var name only** — values resolved at point-of-use, never written to
  config, mail, audit, logs, or a skill.
