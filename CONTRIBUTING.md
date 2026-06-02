# Contributing to Agentplate

Thanks for your interest in improving Agentplate! This project is built in public and
contributions are welcome.

## Development setup

```bash
git clone https://github.com/agentplate/agentplate.git
cd agentplate
bun install
bun run check   # bun test && biome check . && tsc --noEmit
```

You need [Bun](https://bun.sh) `>= 1.0` and `git`.

## Conventions

- **Language:** TypeScript, strict mode. No `any` — use `unknown` and narrow, or define a type.
  Handle possibly-`undefined` values from index access (`noUncheckedIndexedAccess` is on).
- **Formatting & linting:** [Biome](https://biomejs.dev) — tabs, 100-column width. Run
  `bun run lint:fix` before committing.
- **Shared types** go in `src/types.ts`. **Error types** extend `AgentplateError` in `src/errors.ts`.
- **External tools** (`git`, runtime CLIs, deploy CLIs) are invoked via `Bun.spawn`, never imported.
- **Databases** use `bun:sqlite` opened through `src/db/sqlite.ts` (WAL + busy timeout).

## Testing

- Framework: `bun test`. Tests are colocated as `*.test.ts` next to the code.
- **Prefer real implementations over mocks** — temp git repos and in-memory/temp SQLite. Only mock
  things with unacceptable side effects (tmux, network, real AI calls), and document why.

## Pull requests

1. Branch off `main`.
2. Make your change with tests.
3. Ensure `bun run check` passes.
4. Open a PR describing the change and its motivation.

By contributing you agree your contributions are licensed under the project's [MIT License](./LICENSE).
