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
 * Request guard (the API can spawn bypass-permission agents, so a browser must
 * never be able to drive it from a foreign page):
 *   - Host header pinned to the bound authority when bound to loopback (blocks
 *     DNS rebinding, which would otherwise make a foreign site same-origin).
 *   - Origin allowlist (the server's own loopback origins on its port, plus any
 *     explicit `allowedOrigins`) on every non-GET request AND the /ws upgrade;
 *     a request with no Origin is a non-browser client and is allowed.
 *   - POST requires `content-type: application/json` (forces a CORS preflight the
 *     server never approves), a body under MAX_BODY_BYTES, and a JSON object.
 *   - Bearer token on every /api/* and /ws request when bound off loopback (a
 *     per-launch random token unless one is supplied). Sent as
 *     `Authorization: Bearer <token>` or, where a browser can't set headers (the
 *     /ws handshake, the first page load), a `?token=` query param. Loopback binds
 *     stay token-free; /healthz and the static SPA are never gated.
 *
 * The WS broadcaster polls the stores on an interval and sends snapshots to all
 * connected clients — simple, store-agnostic, and good enough for a local
 * operator dashboard without a change-feed.
 */

import { createHash, timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";
import { join, normalize } from "node:path";
import type { Server, ServerWebSocket } from "bun";
import { loadConfig } from "../config.ts";
import { isAgentplateError, ValidationError } from "../errors.ts";
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

/** Largest request body accepted (bytes); Bun answers 413 above this. */
export const MAX_BODY_BYTES = 1_000_000;

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
	/**
	 * Extra browser origins trusted for writes + /ws (e.g. the Vite dev server,
	 * `http://localhost:5173`). The server's own loopback origins are always allowed.
	 */
	allowedOrigins?: readonly string[];
	/**
	 * Bearer token required on /api/* and /ws. Omitted → a random per-launch
	 * token when `host` is not loopback, none on loopback. `null` → never require one.
	 */
	authToken?: string | null;
}

export interface ServeHandle {
	server: Server<WsData>;
	stop: () => void;
	url: string;
	/** The bearer token clients must present, or null when the API is token-free. */
	token: string | null;
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

function errorResponse(message: string, status: number): Response {
	return jsonResponse({ ok: false, error: { message } }, status);
}

/** Lowercase a host and strip IPv6 brackets (`[::1]` → `::1`). */
function bareHost(host: string): string {
	return host
		.trim()
		.toLowerCase()
		.replace(/^\[(.*)\]$/, "$1");
}

/** Format a host for a URL authority (bracket IPv6 literals). */
export function formatHost(host: string): string {
	const h = bareHost(host);
	return h.includes(":") ? `[${h}]` : h;
}

/** Is `host` a loopback address (127.0.0.0/8, ::1, localhost)? */
export function isLoopbackHost(host: string): boolean {
	const h = bareHost(host);
	return h === "localhost" || h === "::1" || /^127(\.\d{1,3}){3}$/.test(h);
}

/** Wildcard binds listen on every interface, so there is no single authority to pin. */
const WILDCARD_HOSTS = new Set(["", "0.0.0.0", "::"]);

/**
 * Normalize an origin (`http(s)://host[:port]`) or throw. Opaque origins
 * ("null", file:) and wildcards can never be trusted.
 */
export function normalizeOrigin(origin: string): string {
	let parsed: URL;
	try {
		parsed = new URL(origin);
	} catch {
		throw new ValidationError(`Invalid origin "${origin}" (expected e.g. http://localhost:5173).`);
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		throw new ValidationError(`Invalid origin "${origin}": must be http(s)://host[:port].`);
	}
	return parsed.origin;
}

interface RequestGuard {
	/** Accepted Host header values, or null when the bind can't be pinned (non-loopback). */
	hosts: Set<string> | null;
	/** Browser origins trusted for writes + /ws. */
	origins: Set<string>;
}

function buildGuard(bindHost: string, port: number, extra: readonly string[]): RequestGuard {
	const names = new Set(["127.0.0.1", "localhost", "[::1]"]);
	if (!WILDCARD_HOSTS.has(bareHost(bindHost))) names.add(formatHost(bindHost));
	const authorities = new Set<string>();
	for (const name of names) {
		authorities.add(`${name}:${port}`);
		if (port === 80) authorities.add(name); // browsers omit the default port
	}
	const origins = new Set([...authorities].map((a) => `http://${a}`));
	for (const o of extra) origins.add(o);
	return { hosts: isLoopbackHost(bindHost) ? authorities : null, origins };
}

/** DNS-rebinding guard: when bound to loopback, the Host must be our own authority. */
function hostAllowed(guard: RequestGuard, req: Request): boolean {
	if (guard.hosts === null) return true;
	return guard.hosts.has((req.headers.get("host") ?? "").toLowerCase());
}

/**
 * CSRF / cross-site WebSocket guard. Browsers always send Origin on non-GET
 * fetches and WS handshakes; its absence means a non-browser client (curl, the
 * CLI, tests), which carries no ambient browser authority to abuse.
 */
function originAllowed(guard: RequestGuard, req: Request): boolean {
	const origin = req.headers.get("origin");
	if (origin === null) return true;
	const o = origin.toLowerCase();
	if (guard.origins.has(o)) return true;
	// Unpinned (non-loopback) bind: fall back to strict same-origin with the Host.
	return guard.hosts === null && o === `http://${(req.headers.get("host") ?? "").toLowerCase()}`;
}

/** Resolve the effective bearer token for a bind (see {@link ServeOptions.authToken}). */
export function resolveAuthToken(host: string, explicit: string | null | undefined): string | null {
	if (explicit === null) return null;
	if (explicit !== undefined) {
		if (explicit.trim() === "") throw new ValidationError("authToken must not be empty.");
		return explicit;
	}
	return isLoopbackHost(host) ? null : crypto.randomUUID();
}

/** Constant-time string compare (hash first so lengths always match). */
function safeEqual(a: string, b: string): boolean {
	const ha = createHash("sha256").update(a).digest();
	const hb = createHash("sha256").update(b).digest();
	return timingSafeEqual(ha, hb);
}

/** Does `req` carry the bearer token (Authorization header or `?token=` query)? */
function tokenAllowed(token: string | null, req: Request, url: URL): boolean {
	if (token === null) return true;
	const auth = req.headers.get("authorization") ?? "";
	const match = /^Bearer\s+(.+)$/i.exec(auth.trim());
	if (match?.[1] !== undefined && safeEqual(match[1], token)) return true;
	const q = url.searchParams.get("token");
	return q !== null && safeEqual(q, token);
}

/** Parse a POST body: JSON content-type, valid JSON, and a plain object. */
async function readJsonObject(req: Request): Promise<Record<string, unknown> | Response> {
	const contentType = req.headers.get("content-type") ?? "";
	if (!/^application\/json\s*(;|$)/i.test(contentType)) {
		return errorResponse("POST body must be sent as content-type: application/json.", 415);
	}
	let body: unknown;
	try {
		body = await req.json();
	} catch {
		return errorResponse("POST body is not valid JSON.", 400);
	}
	if (typeof body !== "object" || body === null || Array.isArray(body)) {
		return errorResponse("POST body must be a JSON object.", 400);
	}
	return body as Record<string, unknown>;
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
	// Validate extra origins up front (throws on garbage) rather than per request.
	const extraOrigins = (opts.allowedOrigins ?? []).map(normalizeOrigin);
	const token = resolveAuthToken(opts.host, opts.authToken);
	// Built lazily from the real bound port (port 0 → OS-assigned).
	let guard: RequestGuard | null = null;

	const server = Bun.serve<WsData>({
		port: opts.port,
		hostname: opts.host,
		maxRequestBodySize: MAX_BODY_BYTES,
		async fetch(req, srv) {
			guard ??= buildGuard(opts.host, srv.port ?? opts.port, extraOrigins);
			if (!hostAllowed(guard, req)) return errorResponse("forbidden host", 403);
			if (req.method !== "GET" && req.method !== "HEAD" && !originAllowed(guard, req)) {
				return errorResponse("cross-origin request refused", 403);
			}

			const url = new URL(req.url);
			const { pathname } = url;

			if (pathname === "/healthz") {
				return jsonResponse(jsonSuccess({ status: "ok", ts: new Date().toISOString() }));
			}

			if ((pathname === "/ws" || pathname.startsWith("/api/")) && !tokenAllowed(token, req, url)) {
				return new Response(
					`${JSON.stringify({ ok: false, error: { message: "unauthorized: missing or invalid bearer token" } })}\n`,
					{
						status: 401,
						headers: {
							"content-type": "application/json; charset=utf-8",
							"www-authenticate": 'Bearer realm="agentplate"',
						},
					},
				);
			}

			if (pathname === "/ws") {
				// WebSockets bypass the same-origin policy, so check Origin explicitly.
				if (!originAllowed(guard, req)) return errorResponse("cross-origin request refused", 403);
				const ok = srv.upgrade(req, { data: { room: "fleet" } });
				return ok ? undefined : new Response("WebSocket upgrade failed", { status: 400 });
			}

			// Write actions (POST): a tight allowlist — message the coordinator or
			// spawn a worker. No deploy/secrets/rollback are writable from the UI.
			if (req.method === "POST" && pathname.startsWith("/api/")) {
				try {
					const body = await readJsonObject(req);
					if (body instanceof Response) return body;
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
		url: `http://${formatHost(opts.host)}:${server.port}`,
		token,
		stop: () => {
			clearInterval(timer);
			if (reapTimer) clearInterval(reapTimer);
			for (const ws of clients) ws.close();
			server.stop(true);
		},
	};
}
