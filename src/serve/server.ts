/**
 * HTTP + WebSocket server for the web UI, built on Bun's native `Bun.serve`
 * (no server dependencies).
 *
 * Routes:
 *   GET /healthz        → liveness JSON
 *   GET /api/*          → REST handlers (see api.ts), wrapped in the JSON envelope
 *   GET /ws             → WebSocket; pushes a periodic `overview`+`agents` snapshot
 *   GET /*              → static SPA from ui/dist with index.html fallback
 *
 * The WS broadcaster polls the stores on an interval and sends snapshots to all
 * connected clients — simple, store-agnostic, and good enough for a local
 * operator dashboard without a change-feed.
 */

import { existsSync } from "node:fs";
import { join, normalize } from "node:path";
import type { Server, ServerWebSocket } from "bun";
import { loadConfig } from "../config.ts";
import { isAgentplateError } from "../errors.ts";
import { jsonSuccess } from "../json.ts";
import { sessionsDbPath } from "../paths.ts";
import { reapIdleSessions } from "../sessions/reaper.ts";
import { createSessionStore } from "../sessions/store.ts";
import {
	type ApiContext,
	buildFeed,
	buildStatusCounts,
	buildTasks,
	postChat,
	postTask,
	resolveRoute,
} from "./api.ts";
import { collectSystemMetrics } from "./system.ts";
import { fetchWeather } from "./weather.ts";

/** How often the serve loop sweeps for idle agents to reap (ms). */
const REAP_INTERVAL_MS = 60_000;

export interface ServeOptions {
	root: string;
	port: number;
	host: string;
	/** Directory holding the built SPA (ui/dist). */
	uiDir: string;
	/** WS snapshot interval in ms (default 5000 — the standard refresh cadence). */
	wsIntervalMs?: number;
	/** Idle-reaper sweep interval in ms (default 60000). */
	reapIntervalMs?: number;
}

export interface ServeHandle {
	server: Server<WsData>;
	stop: () => void;
	url: string;
}

interface WsData {
	room: string;
}

const CONTENT_TYPES: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".svg": "image/svg+xml",
	".ico": "image/x-icon",
	".png": "image/png",
	".woff2": "font/woff2",
};

function contentTypeFor(path: string): string {
	const dot = path.lastIndexOf(".");
	const ext = dot >= 0 ? path.slice(dot) : "";
	return CONTENT_TYPES[ext] ?? "application/octet-stream";
}

function jsonResponse(data: unknown, status = 200): Response {
	return new Response(`${JSON.stringify(data)}\n`, {
		status,
		headers: { "content-type": "application/json; charset=utf-8" },
	});
}

/**
 * Serve a static file from `uiDir`, with SPA fallback to index.html. Guards
 * against path traversal by normalizing and confining to uiDir.
 */
async function serveStatic(uiDir: string, pathname: string): Promise<Response> {
	if (!existsSync(uiDir)) {
		return new Response(
			"Agentplate UI is not built. Run `bun run build:ui` (or use the CLI / TUI).",
			{
				status: 503,
				headers: { "content-type": "text/plain; charset=utf-8" },
			},
		);
	}
	const rel = normalize(pathname).replace(/^(\.\.(\/|\\|$))+/, "");
	let filePath = join(uiDir, rel);
	if (!filePath.startsWith(uiDir)) filePath = join(uiDir, "index.html");
	if (!existsSync(filePath) || pathname === "/") {
		filePath = join(uiDir, "index.html");
	}
	const file = Bun.file(filePath);
	if (!(await file.exists())) {
		// SPA fallback.
		const index = Bun.file(join(uiDir, "index.html"));
		if (await index.exists()) {
			return new Response(index, { headers: { "content-type": "text/html; charset=utf-8" } });
		}
		return new Response("Not found", { status: 404 });
	}
	return new Response(file, { headers: { "content-type": contentTypeFor(filePath) } });
}

/**
 * Build a live snapshot for WS clients: overview + agents + status counts +
 * the latest feed slice, so the UI updates the status board and activity stream
 * in real time without polling.
 */
function snapshot(ctx: ApiContext): unknown {
	const overviewRoute = resolveRoute("/api/overview");
	const agentsRoute = resolveRoute("/api/agents");
	const query = new URLSearchParams();
	return {
		type: "snapshot",
		overview: overviewRoute?.route.handler(ctx, {}, query) ?? null,
		agents: agentsRoute?.route.handler(ctx, {}, query) ?? [],
		statusCounts: buildStatusCounts(ctx),
		tasks: buildTasks(ctx),
		feed: buildFeed(ctx, 40),
		ts: new Date().toISOString(),
	};
}

/** Start the server. Returns a handle with `stop()`. */
export function startServer(opts: ServeOptions): ServeHandle {
	const ctx: ApiContext = { root: opts.root };
	const clients = new Set<ServerWebSocket<WsData>>();
	const intervalMs = opts.wsIntervalMs ?? 5000;

	const server = Bun.serve<WsData>({
		port: opts.port,
		hostname: opts.host,
		async fetch(req, srv) {
			const url = new URL(req.url);
			const { pathname } = url;

			if (pathname === "/healthz") {
				return jsonResponse(jsonSuccess({ status: "ok", ts: new Date().toISOString() }));
			}

			if (pathname === "/ws") {
				const ok = srv.upgrade(req, { data: { room: "fleet" } });
				return ok ? undefined : new Response("WebSocket upgrade failed", { status: 400 });
			}

			// Write actions (POST): a tight allowlist — message the coordinator or
			// spawn a worker. No deploy/secrets/rollback are writable from the UI.
			if (req.method === "POST" && pathname.startsWith("/api/")) {
				try {
					const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
					if (pathname === "/api/chat") return jsonResponse(jsonSuccess(postChat(ctx, body)));
					if (pathname === "/api/tasks") return jsonResponse(jsonSuccess(postTask(ctx, body)));
					return jsonResponse({ ok: false, error: "not found" }, 404);
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					const status = isAgentplateError(error) ? 400 : 500;
					return jsonResponse({ ok: false, error: { message } }, status);
				}
			}

			// Async GET endpoints (host metrics + weather) — kept out of the sync
			// route table since they await I/O.
			if (req.method === "GET" && pathname === "/api/system") {
				try {
					return jsonResponse(jsonSuccess(await collectSystemMetrics()));
				} catch (error) {
					return jsonResponse({ ok: false, error: String(error) }, 500);
				}
			}
			if (req.method === "GET" && pathname === "/api/weather") {
				try {
					return jsonResponse(jsonSuccess(await fetchWeather(url.searchParams.get("loc"))));
				} catch (error) {
					return jsonResponse({ ok: false, error: String(error) }, 500);
				}
			}

			if (pathname.startsWith("/api/")) {
				if (req.method !== "GET") return jsonResponse({ ok: false, error: "method" }, 405);
				const resolved = resolveRoute(pathname);
				if (!resolved) return jsonResponse({ ok: false, error: "not found" }, 404);
				try {
					const data = resolved.route.handler(ctx, resolved.params, url.searchParams);
					return jsonResponse(jsonSuccess(data));
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					return jsonResponse({ ok: false, error: { message } }, 500);
				}
			}

			return serveStatic(opts.uiDir, pathname);
		},
		websocket: {
			open(ws) {
				clients.add(ws);
				ws.send(JSON.stringify(snapshot(ctx)));
			},
			close(ws) {
				clients.delete(ws);
			},
			message() {
				// Clients are read-only; ignore inbound messages.
			},
		},
	});

	// Idle-agent reaper: terminate workers idle past the configured timeout. Runs
	// independently of connected clients (serve running = reaping active). Disabled
	// when idleTimeoutMinutes is 0. Config is read once at startup.
	const { idleMinutes, purgeOnReap } = (() => {
		try {
			const agents = loadConfig(opts.root).agents;
			return { idleMinutes: agents.idleTimeoutMinutes, purgeOnReap: agents.purgeOnReap };
		} catch {
			return { idleMinutes: 0, purgeOnReap: false };
		}
	})();
	const reapTimer =
		idleMinutes > 0
			? setInterval(() => {
					const store = createSessionStore(sessionsDbPath(opts.root));
					reapIdleSessions(store, opts.root, { idleMs: idleMinutes * 60_000, purge: purgeOnReap })
						.then((reaped) => {
							if (reaped.length > 0) {
								const names = reaped.map((r) => r.agentName).join(", ");
								const how = purgeOnReap ? "reaped + purged" : "reaped";
								console.error(
									`[agentplate] ${how} ${reaped.length} idle agent(s) (>${idleMinutes}m): ${names}`,
								);
							}
						})
						.catch(() => {})
						.finally(() => store.close());
				}, opts.reapIntervalMs ?? REAP_INTERVAL_MS)
			: null;

	// Periodic broadcast loop.
	const timer = setInterval(() => {
		if (clients.size === 0) return;
		let payload: string;
		try {
			payload = JSON.stringify(snapshot(ctx));
		} catch {
			return;
		}
		for (const ws of clients) ws.send(payload);
	}, intervalMs);

	return {
		server,
		url: `http://${opts.host}:${server.port}`,
		stop: () => {
			clearInterval(timer);
			if (reapTimer) clearInterval(reapTimer);
			for (const ws of clients) ws.close();
			server.stop(true);
		},
	};
}
