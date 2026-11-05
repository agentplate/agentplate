# Agentplate UI

The "agent OS" web dashboard for **Agentplate**: a React + TypeScript single-page
app built with Vite. `agentplate serve` serves it as static files from `ui/dist`.
It talks to the server's REST API (`/api/*`) and the live `/ws` snapshot feed.

## Screens

The left rail has 13 screens. ⌘K / Ctrl+K opens a command palette that jumps to
any screen or agent.

- **Dashboard**: mission control, with project/runtime/provider cards, agent
  status counts and the fleet board.
- **System**: host CPU, memory, disk and uptime (`/api/system`).
- **Agents**: one card per agent in the current run.
- **Office**: a 3D office (three.js) where agents act out their work by role.
  Orbit or FPS (WASD + pointer lock) camera.
- **Tasks**: tasks derived from specs and sessions, with rolled-up status.
- **Handoffs**: protocol handoff mail between agents.
- **Activity**: a terminal-style stream of tool calls and mail.
- **Runs**: run and session history in a sortable, filterable table.
- **Skills**: the self-improving skill library, showing confidence, applied and
  success counts.
- **Costs**: token and cost usage per agent (recharts).
- **Chat**: message the coordinator (`POST /api/chat`) or submit a task that
  spawns a worker (`POST /api/tasks`).
- **Deploy**: registered deploy targets and the deploy audit history.
- **Settings**: a read-only view of the project, runtime and provider settings.

Click any agent, or focus it and press Enter, to open its detail drawer. The
drawer shows session metadata, handoff mail, spawned children and recent events.
Escape closes it.

The status bar shows host metrics and a **LIVE / OFFLINE** indicator for the
WebSocket. The server pushes a snapshot every 5 s. If 15 s pass with no frame,
the client marks the socket stale and reconnects with backoff. Until it
reconnects, it falls back to polling the REST endpoints.

## Develop

Run the Agentplate server in one terminal (default port `7551`). Trust the Vite
dev origin so that proxied writes (`POST /api/*`) and `/ws` pass the server's
Origin allowlist. The proxy rewrites `Host` but keeps
`Origin: http://localhost:5173`.

```bash
agentplate serve --allow-origin http://localhost:5173
```

Then start the Vite dev server in another terminal:

```bash
bun install      # first time only
bun run dev
```

Vite serves the app with hot reload. It proxies `/api`, `/healthz` and `/ws`
(including the WebSocket upgrade) to `http://127.0.0.1:7551`. Open the URL Vite
prints, usually http://localhost:5173.

## Build

```bash
bun install      # first time only
bun run typecheck
bun run build
```

This writes a production bundle to `ui/dist/`. The Office screen (three.js and
@react-three) and the Costs screen (recharts) are code-split. Their chunks load
on first visit, so the initial chunk stays small. Preview the build locally with
`bun run preview`.

The UI is linted and formatted by the repo-root Biome config (`biome check .`).
Pure modules (`urls.ts`, `ws.ts`, `fpsKeys.ts`, `keys.ts`) have colocated
`*.test.ts` files, which run with `bun test` from `ui/` (they need `ui/node_modules`; CI runs them in the `ui` job).

## Serving under a sub-path

The build uses `base: "./"`. Every API and WebSocket URL is app-relative
(`api/overview`, `ws`) and resolves against `document.baseURI`. So the same
build works at the root, through the Vite proxy, or behind a reverse proxy that
mounts it at a prefix such as `https://host/agentplate/`. The proxy must strip
the prefix before forwarding, and the page URL needs its trailing slash.

## Remote access (bearer token)

On loopback (the default `127.0.0.1`), `agentplate serve` needs no token. With a
non-loopback `--host` it generates a random token at each launch and prints a
URL that carries it:

```
agentplate serve → http://0.0.0.0:7551/?token=…
```

Open that URL. The SPA stores the token in `sessionStorage` for the tab and
removes it from the address bar. It then sends the token as
`Authorization: Bearer <token>` on every `/api` call and as `?token=` on the
`/ws` handshake. Restarting the server issues a new token. Non-browser clients
send the same header:

```bash
curl -H "Authorization: Bearer $TOKEN" http://host:7551/api/overview
```

## Notes

- Dependencies: React and React DOM, lucide-react (icons), recharts (Costs),
  and three with @react-three/fiber and drei (Office). There is no router, no
  state library and no CSS framework. All styling lives in one hand-written
  stylesheet, `src/theme.css`.
- The app imports no server code. API shapes are mirrored in `src/types.ts`.
