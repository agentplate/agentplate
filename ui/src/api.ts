// Typed fetch client for the Agentplate server API.
//
// Every REST response is wrapped in `{ ok: true, data }` (or `{ ok: false,
// error }`). `getJson` unwraps the envelope and throws on failure or non-2xx, so
// callers always receive the bare `data` payload typed as `T`.
//
// All endpoint paths are app-relative ("api/overview", "ws") and resolved against
// `document.baseURI`, so the same build works when served by `agentplate serve`
// at the root, by the Vite dev server (which proxies /api + /ws), or under a
// reverse-proxy sub-path mount (https://host/agentplate/).
//
// Auth: a non-loopback `agentplate serve` requires a per-launch bearer token. It
// prints a URL carrying `?token=…`; the SPA keeps that token in sessionStorage
// (stripping it from the address bar) and sends it as `Authorization: Bearer` on
// REST calls and as a `token` query param on the WS handshake.

import type {
	AgentDetail,
	AgentSession,
	CostsReport,
	DeployAuditRow,
	DeployTargetSummary,
	FeedItem,
	Handoff,
	JsonEnvelope,
	MailMessage,
	Overview,
	RunRecord,
	SkillSummary,
	Snapshot,
	SystemMetrics,
	TaskItem,
} from "./types.ts";
import { authHeaders, captureToken, resolveUrl, resolveWsUrl } from "./urls.ts";
import { openLiveSocket, type WsCallbacks, type WsHandle } from "./ws.ts";

export type { WsHandle } from "./ws.ts";

function sessionStore(): Storage | null {
	try {
		return window.sessionStorage;
	} catch {
		return null;
	}
}

let cachedToken: string | null | undefined;

/** The bearer token for this tab (captured once from `?token=`, else sessionStorage). */
function authToken(): string | null {
	if (cachedToken !== undefined) return cachedToken;
	const { token, cleanHref } = captureToken(window.location.href, sessionStore());
	if (cleanHref !== null) {
		try {
			window.history.replaceState(window.history.state, "", cleanHref);
		} catch {
			// Non-fatal: the token just stays visible in the address bar.
		}
	}
	cachedToken = token;
	return token;
}

/** Resolve an app-relative endpoint path against the page's base URL. */
const endpoint = (path: string): string => resolveUrl(path, document.baseURI);

/** Unwrap the `{ ok, data }` envelope from a fetch response, throwing on failure. */
async function unwrap<T>(res: Response, path: string): Promise<T> {
	if (res.status === 401) {
		throw new Error(
			"Unauthorized: open the tokenized URL printed by `agentplate serve` (…/?token=…).",
		);
	}
	let parsed: unknown;
	try {
		parsed = await res.json();
	} catch {
		throw new Error(`Invalid JSON from ${path} (HTTP ${res.status})`);
	}
	const envelope = parsed as JsonEnvelope<T>;
	if (envelope && typeof envelope === "object" && "ok" in envelope) {
		if (envelope.ok) return envelope.data;
		throw new Error(envelope.error?.message ?? `Request failed: ${path}`);
	}
	// Defensive: an un-enveloped body still surfaces a useful error rather than
	// silently returning the wrong shape.
	if (!res.ok) throw new Error(`HTTP ${res.status} from ${path}`);
	return parsed as T;
}

/** Fetch app-relative `path` and unwrap the `{ ok, data }` envelope, throwing on failure. */
export async function getJson<T>(path: string): Promise<T> {
	const res = await fetch(endpoint(path), {
		headers: authHeaders(authToken(), { accept: "application/json" }),
	});
	return unwrap<T>(res, path);
}

export const getOverview = (): Promise<Overview> => getJson<Overview>("api/overview");
export const getRuns = (): Promise<RunRecord[]> => getJson<RunRecord[]>("api/runs");
export const getAgents = (): Promise<AgentSession[]> => getJson<AgentSession[]>("api/agents");
export const getSkills = (): Promise<SkillSummary[]> => getJson<SkillSummary[]>("api/skills");
export const getDeployTargets = (): Promise<DeployTargetSummary[]> =>
	getJson<DeployTargetSummary[]>("api/deploy/targets");
export const getDeployHistory = (): Promise<DeployAuditRow[]> =>
	getJson<DeployAuditRow[]>("api/deploy/history");
export const getFeed = (limit = 60): Promise<FeedItem[]> =>
	getJson<FeedItem[]>(`api/feed?limit=${encodeURIComponent(String(limit))}`);
export const getAgentDetail = (name: string): Promise<AgentDetail> =>
	getJson<AgentDetail>(`api/agents/${encodeURIComponent(name)}`);
export const getHandoffs = (limit = 100): Promise<Handoff[]> =>
	getJson<Handoff[]>(`api/handoffs?limit=${encodeURIComponent(String(limit))}`);
export const getTasks = (): Promise<TaskItem[]> => getJson<TaskItem[]>("api/tasks");
export const getSystem = (): Promise<SystemMetrics> => getJson<SystemMetrics>("api/system");
export const getCosts = (): Promise<CostsReport> => getJson<CostsReport>("api/costs");

/** POST a JSON body to app-relative `path`, unwrapping the `{ ok, data }` envelope. */
async function postJson<T>(path: string, body: unknown): Promise<T> {
	const res = await fetch(endpoint(path), {
		method: "POST",
		headers: authHeaders(authToken(), {
			"content-type": "application/json",
			accept: "application/json",
		}),
		body: JSON.stringify(body),
	});
	return unwrap<T>(res, path);
}

/** Message the coordinator (chat). */
export const postChat = (message: string): Promise<{ sent: MailMessage }> =>
	postJson<{ sent: MailMessage }>("api/chat", { message });

/** Submit a task — spawns a worker. */
export const postTask = (input: {
	prompt: string;
	capability?: string;
	taskId?: string;
}): Promise<{ accepted: boolean; taskId: string; capability: string }> =>
	postJson("api/tasks", input);

/**
 * Open the live `/ws` snapshot feed (ws:// or wss:// following the page, under
 * the same base path, token attached when one is held). Self-heals: reconnects
 * with backoff after a close and after 15s of silence (see ws.ts).
 */
export function connectWs(callbacks: WsCallbacks<Snapshot>): WsHandle {
	return openLiveSocket<Snapshot>(resolveWsUrl("ws", document.baseURI, authToken()), callbacks);
}
