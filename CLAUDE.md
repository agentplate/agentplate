# Agentplate

Self-improving multi-agent orchestration + delivery tool. Agentplate spawns AI coding-agent
workers in isolated git worktrees, coordinates them through a SQLite mail bus, merges their
work back with tiered conflict resolution, distills reusable **skills** from successful tasks,
and ships apps through a pluggable **deploy target** pipeline. CLI + live TUI + web UI.

## Tech Stack

- **Runtime:** Bun (runs TypeScript directly, no build step)
- **Language:** TypeScript strict (`noUncheckedIndexedAccess`, no `any`)
- **Lint/format:** Biome (tabs, 100-column width)
- **Runtime deps (lean):** `commander` (CLI), `chalk` (color), `js-yaml` (config),
  `@clack/prompts` (the setup wizard). Everything else uses Bun built-ins (`bun:sqlite`,
  `Bun.spawn`, `Bun.serve`, `Bun.file`).
- **Web UI:** React + Vite (in `ui/`, builds to `ui/dist`, served by `agentplate serve`).
- **Bins:** `agentplate` and `ap`.

## Architecture

- **Orchestration:** `coordinator → lead → workers`. Workers run **headless spawn-per-turn**
  (`src/agents/turn-runner.ts`): each turn is a fresh runtime subprocess; mail drives the next
  turn. No long-lived process, no tmux.
- **Two mirrored adapter contracts** — the core reuse insight:
  - `src/runtimes/` — how to drive a coding agent (`AgentRuntime`: buildDirectSpawn, buildEnv,
    buildPrintCommand, parseEvents). Resolved by `getRuntime()`.
  - `src/deploy/` — how to ship to a target (`DeployTarget`: detect, generateConfig, deploy,
    verify, rollback, buildSecretEnv). Resolved by `getDeployTarget()` (no silent default).
  Both: one file per backend, registry-resolved, secrets via env-by-name (never hardcoded).
- **Self-improving skills** (`src/skills/`): retrieve relevant skills into an agent's overlay →
  track applied → at session-end append outcomes (Wilson confidence) and, gated on quality
  gates passing, run an AI **distiller** to mint/update a skill. Safety-scrubbed before any
  write. Lifecycle glue is in `src/skills/lifecycle.ts`, wired into `src/commands/sling.ts`.
- **Surfaces** (`src/serve/`, `src/commands/{serve,tui}.ts`): `Bun.serve` REST + `/ws` snapshot
  feed + static SPA; a dependency-free ANSI TUI. All read the same SQLite stores.

## Directory Structure

```
src/
  index.ts                  # Commander entry + router
  types.ts                  # ALL shared types
  errors.ts                 # AgentplateError hierarchy
  config.ts                 # 3-layer config merge (defaults ← config.yaml ← config.local.yaml)
  secrets.ts                # gitignored env-by-name secret store
  json.ts paths.ts version.ts
  db/sqlite.ts              # openDatabase (WAL + busy_timeout)
  logging/                  # color, logger, sanitizer (secret redaction)
  providers/                # provider catalog + selection → config
  wizard/                   # interactive setup (@clack)
  runtimes/                 # AgentRuntime adapters + registry (claude, mock)
  worktree/ sessions/ events/ mail/   # engine stores + git worktrees
  agents/                   # manifest, overlay, identity, turn-runner, guard-rules
  merge/                    # queue, resolver (clean/auto), lock
  insights/                 # quality-gates (outcome scoring)
  skills/                   # store, retrieval, distiller, feedback, safety, lifecycle
  deploy/                   # types, registry, context, secrets, audit, targets/docker-gha
  serve/                    # api (REST routes) + server (Bun.serve + ws)
  commands/                 # one file per CLI command
agents/                     # base agent definitions (.md): scout/builder/reviewer/lead/merger/
                            #   coordinator/architect/devops/deployer/verifier
templates/overlay.md.tmpl   # per-task overlay template
ui/                         # React + Vite web UI
```

## Coding Conventions

- Shared types → `src/types.ts`. Error types extend `AgentplateError` in `src/errors.ts`.
- Open SQLite via `openDatabase()` (`src/db/sqlite.ts`) — WAL + busy_timeout, always.
- External tools (`git`, runtime CLIs, deploy CLIs) run via `Bun.spawn` with an **argv array**
  (never a shell string); capture stdout/stderr, check exit codes, throw typed errors.
- IDs via `crypto.randomUUID()`; timestamps via `new Date().toISOString()`.
- `--json` on a subcommand is read via `command.optsWithGlobals().json === true` (the flag is
  both global and per-command, so read the merged value).
- Secrets: only env-var **names** in config; values resolved at point-of-use and injected into a
  child process env. Never write a secret to config, mail, audit, logs, or a skill.

## Testing

- `bun test` (Jest-compatible). Tests colocated as `*.test.ts`.
- **Never mock what you can use for real:** temp git repos (`mkdtempSync` + real `git`),
  `:memory:`/temp-file SQLite, real `Bun.serve` on port 0. Only mock the genuinely unsafe
  (real AI calls, real `docker` — use the mock runtime / dry-run paths).

## Quality Gates

Run all three before committing:

```bash
bun test && biome check . && tsc --noEmit
```

Or: `bun run check`.

## Self-improving skills (dogfooding)

This project can use its own skill library. After completing a non-trivial task whose gates pass,
a skill may be distilled automatically (when running through `agentplate sling`). You can also record
one manually: `agentplate skill record --stdin` with a JSON `SkillDraft`. Inspect with
`agentplate skill list` / `agentplate skill show <slug>`.

## Adding things

- **A new deploy target:** add `src/deploy/targets/<name>.ts` implementing `DeployTarget`, register
  one line in `src/deploy/registry.ts`. Zero pipeline changes.
- **A new runtime:** add `src/runtimes/<name>.ts` implementing `AgentRuntime`, register in
  `src/runtimes/registry.ts`.
- **A new provider:** add an entry to the catalog in `src/providers/registry.ts`.
- **A new command:** `src/commands/<name>.ts` exporting `create<Name>Command(): Command`, register
  in `src/index.ts`.
