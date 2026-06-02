# Changelog

All notable changes to Agentplate are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/), and the project aims to adhere to
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- **Full purge of reaped agents** (`agentplate reap --purge`, `agentplate stop
  <agent> --purge`) — beyond stopping an agent and removing its worktree, purge
  erases every trace it left behind: mail, events, queued merges, the on-disk
  `.agentplate/agents/<name>/` state dir, the task spec (only once no sibling
  session still references it), and the session row itself. A `PurgeReport` records
  what was removed.
- **`agents.purgeOnReap`** (default `false`) — when set, the `agentplate serve`
  idle-reaper loop purges idle agents automatically (not just marks them stopped).
  Surfaced as a gated toggle in `agentplate setup`.
- **Store deletion APIs** backing the purge: `SessionStore.deleteSession`,
  `EventStore.deleteByAgent`, and `MergeQueue.deleteByAgent`.

### Changed

- Plain `reap` / `serve` behavior is unchanged — reaping still keeps records for
  history by default. Full erasure is strictly opt-in via `--purge` / `purgeOnReap`.

## [1.3.0] — 2026-06-02

### Added

- **`agentplate watch`** — the mail pump that makes warm-start automatic: it
  advances every **idle** agent with unread mail to its next (resumed) turn,
  driving eligible agents concurrently up to `agents.maxConcurrent`. Modes:
  `--once`, `--until-idle`, or loop until Ctrl-C.
- **Hard per-turn timeout** (`agents.turnTimeoutMinutes`, 0 = off) — kills a turn
  that runs past the cap even while still streaming (idle reaping only catches
  inactivity).
- **Per-capability runtime** — `runtime.capabilities[capability]` now selects the
  runtime adapter per role (previously defined but unused).
- **Speed shortcuts** — `agents.skipScout` / `skipReview` (surfaced as lead overlay
  constraints) and `agents.skipGates` / `skipSkills` (honored on the turn path).
- **Wizard** — a gated "advanced limits" step (concurrency, turn-timeout, skips).

### Changed

- The turn path is shared via `driveTurn` / `driveAgentTurn`, used by `sling`
  (turn 1), `agentplate turn` (single follow-up), and `agentplate watch`.

## [1.2.0] — 2026-06-02

### Added

- **Auto-merge** (`merge.autoMerge`: `off` / `on-gates-pass` / `on-complete`,
  default `off`). When enabled, a completed worker's branch lands on the canonical
  branch automatically (queue + lock + tiered resolve), reporting `merged` /
  `merge_failed` mail. Configured in `ap setup`.
- **`agentplate turn <agent>`** — runs the next turn for an idle agent, **resuming**
  the runtime session (warm start) instead of cold-starting. The shared `driveTurn`
  core backs both the first turn (`sling`) and follow-ups.
- **Per-capability model tiering** — `providers[id].models` lets a faster/cheaper
  model drive read-only roles (scout, reviewer) while the strong model handles the
  rest. Optional prompt in `ap setup`.
- **Quality-gates prompt in `ap setup`** — detected from `package.json` scripts.

### Changed

- **Quality gates run concurrently** (was sequential); the outcome is reused for
  both skill distillation and auto-merge.
- **Orchestration limits are now enforced.** `agents.maxConcurrent`,
  `maxAgentsPerLead`, and `maxDepth` were validated but ignored; `sling` now
  refuses a spawn that would exceed them with a typed `CapacityError`.

## [1.1.0] — 2026-06-02

### Added

- **`agentplate spec` command** (`write` / `show` / `list` / `path`) — a
  first-class, role-clean way to author the dispatch **contract** a lead or worker
  launches with, written to `.agentplate/specs/<taskId>.md`.

### Fixed

- **Coordinator→lead contract race.** A slung agent reads its inbox once at launch
  and starts immediately, so a brief mailed *after* `sling` arrived too late and the
  agent worked from inherited (wrong) branch content. Contracts are now delivered
  **in-band at launch**: `sling --spec` validates the spec exists and is non-empty
  (failing loudly otherwise) and **inlines** its content into the agent's first
  prompt. Coordinator/lead guidance now requires authoring the spec before slinging
  and forbids delivering a contract by mail afterward.

### Changed

- Updated root dependencies to current majors (`@clack/prompts` 1.x, `commander`
  15, `typescript` 6, `biome` 2.4). Dependabot now batches only minor/patch updates,
  so majors arrive as individual reviewable PRs.
- Repository hardening for public contributions: Code of Conduct, CODEOWNERS,
  Dependabot config, and branch protection on `main`.

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
