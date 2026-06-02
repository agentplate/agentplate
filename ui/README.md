# Agentplate UI

A small React + TypeScript single-page app (built with Vite) that renders the
live operator dashboard for **Agentplate**. It is served as static files by
`agentplate serve` from `ui/dist`, and talks to the server's read-only REST API
(`/api/*`) plus the live `/ws` snapshot feed.

## Screens

- **Overview** — project / runtime / provider / model / deploy-target cards and
  agent counts, driven by the live WebSocket snapshot (falls back to polling
  `/api/overview` when the socket is offline).
- **Fleet** — live table of agents (name, capability, colored state badge, task,
  branch) from the WS snapshot.
- **Skills** — the self-improving skill library: title/goal, status badge,
  confidence bar, and applied/success counts.
- **Deploy** — registered deploy targets (id, label, stability, capabilities)
  and the append-only deploy audit history.
- **Mail** — recent inter-agent mail bus messages (from→to, type badge, subject,
  time).

The header shows a live `● connected` / `○ offline` WebSocket indicator.

## Develop

Run the Agentplate server in one terminal (default port `7551`):

```bash
agentplate serve
```

Then start the Vite dev server in another:

```bash
bun install      # first time only
bun run dev
```

Vite serves the app with hot-reload and proxies `/api`, `/healthz`, and `/ws`
(WebSocket upgrade included) through to `http://127.0.0.1:7551`, so the live
dashboard works end-to-end without CORS or port juggling. Open the URL Vite
prints (typically http://localhost:5173).

## Build

```bash
bun install      # first time only
bun run build
```

This emits a production bundle to `ui/dist/` (with `base: "./"`, so the assets
resolve no matter what path the SPA is mounted under). `agentplate serve` then
serves `ui/dist/index.html` with SPA fallback. Preview the built bundle locally
with `bun run preview`.

## Notes

- No component library, no CSS framework, no router, no state library — just
  React, React DOM, and a single hand-written stylesheet (`src/index.css`,
  dark slate theme with a forge/amber accent).
- The app imports no server code; API shapes are mirrored in `src/types.ts`.
- All API paths are relative, so the same build works whether it is served by
  `agentplate serve`, the Vite dev proxy, or a sub-path mount.
