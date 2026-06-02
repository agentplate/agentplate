// Typed fetch client for the Agentplate server API.
//
// Every REST response is wrapped in `{ ok: true, data }` (or `{ ok: false,
// error }`). `getJson` unwraps the envelope and throws on failure or non-2xx, so
// callers always receive the bare `data` payload typed as `T`. All paths are
// relative, so the app works whether it is served by `agentplate serve`, by the
// Vite dev server (which proxies /api + /ws), or from a sub-path mount.

import type {
	AgentDetail,
	AgentSession,
	DeployAuditRow,
	DeployTargetSummary,
	FeedItem,
	CostsReport,
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

/** Fetch `path` and unwrap the `{ ok, data }` envelope, throwing on failure. */
export async function getJson<T>(path: string): Promise<T> {
	const res = await fetch(path, {
		headers: { accept: "application/json" },
	});
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

export const getOverview = (): Promise<Overview> => getJson<Overview>("/api/overview");
export const getRuns = (): Promise<RunRecord[]> => getJson<RunRecord[]>("/api/runs");
export const getAgents = (): Promise<AgentSession[]> => getJson<AgentSession[]>("/api/agents");
export const getSkills = (): Promise<SkillSummary[]> => getJson<SkillSummary[]>("/api/skills");
export const getDeployTargets = (): Promise<DeployTargetSummary[]> =>
	getJson<DeployTargetSummary[]>("/api/deploy/targets");
export const getDeployHistory = (): Promise<DeployAuditRow[]> =>
	getJson<DeployAuditRow[]>("/api/deploy/history");
export const getFeed = (limit = 60): Promise<FeedItem[]> =>
	getJson<FeedItem[]>(`/api/feed?limit=${encodeURIComponent(String(limit))}`);
export const getAgentDetail = (name: string): Promise<AgentDetail> =>
	getJson<AgentDetail>(`/api/agents/${encodeURIComponent(name)}`);
export const getHandoffs = (limit = 100): Promise<Handoff[]> =>
	getJson<Handoff[]>(`/api/handoffs?limit=${encodeURIComponent(String(limit))}`);
export const getTasks = (): Promise<TaskItem[]> => getJson<TaskItem[]>("/api/tasks");
export const getSystem = (): Promise<SystemMetrics> => getJson<SystemMetrics>("/api/system");
export const getCosts = (): Promise<CostsReport> => getJson<CostsReport>("/api/costs");

/** POST a JSON body to `path`, unwrapping the `{ ok, data }` envelope. */
async function postJson<T>(path: string, body: unknown): Promise<T> {
	const res = await fetch(path, {
		method: "POST",
		headers: { "content-type": "application/json", accept: "application/json" },
		body: JSON.stringify(body),
	});
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
	if (!res.ok) throw new Error(`HTTP ${res.status} from ${path}`);
	return parsed as T;
}

/** Message the coordinator (chat). */
export const postChat = (message: string): Promise<{ sent: MailMessage }> =>
	postJson<{ sent: MailMessage }>("/api/chat", { message });

/** Submit a task — spawns a worker. */
export const postTask = (input: {
	prompt: string;
	capability?: string;
	taskId?: string;
}): Promise<{ accepted: boolean; taskId: string; capability: string }> =>
	postJson("/api/tasks", input);

/** Handle returned by {@link connectWs}; call `close()` to stop reconnecting. */
export interface WsHandle {
	close(): void;
}

/** Connection-state callbacks for the WS indicator in the header. */
export interface WsCallbacks {
	onSnapshot(snapshot: Snapshot): void;
	onStatus?(connected: boolean): void;
}

/**
 * Open a WebSocket to `/ws` and invoke `onSnapshot` for each parsed snapshot
 * frame. Derives ws:// or wss:// from the current page origin so it follows the
 * scheme/host the SPA is served from. Auto-reconnects with a short backoff after
 * any close/error until the returned handle's `close()` is called.
 */
export function connectWs(callbacks: WsCallbacks): WsHandle {
	const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
	const url = `${proto}//${window.location.host}/ws`;

	let socket: WebSocket | null = null;
	let reconnectTimer: number | undefined;
	let closed = false;

	const setStatus = (connected: boolean) => callbacks.onStatus?.(connected);

	const open = () => {
		if (closed) return;
		let ws: WebSocket;
		try {
			ws = new WebSocket(url);
		} catch {
			scheduleReconnect();
			return;
		}
		socket = ws;

		ws.onopen = () => setStatus(true);

		ws.onmessage = (event) => {
			let data: unknown;
			try {
				data = JSON.parse(String(event.data));
			} catch {
				return;
			}
			if (data && typeof data === "object" && (data as Snapshot).type === "snapshot") {
				callbacks.onSnapshot(data as Snapshot);
			}
		};

		ws.onerror = () => {
			// onclose fires after onerror; let it drive reconnect to avoid double timers.
			setStatus(false);
		};

		ws.onclose = () => {
			setStatus(false);
			scheduleReconnect();
		};
	};

	const scheduleReconnect = () => {
		if (closed || reconnectTimer !== undefined) return;
		reconnectTimer = window.setTimeout(() => {
			reconnectTimer = undefined;
			open();
		}, 2000);
	};

	open();

	return {
		close() {
			closed = true;
			if (reconnectTimer !== undefined) {
				window.clearTimeout(reconnectTimer);
				reconnectTimer = undefined;
			}
			if (socket) {
				socket.onclose = null;
				socket.onerror = null;
				socket.close();
				socket = null;
			}
		},
	};
}
