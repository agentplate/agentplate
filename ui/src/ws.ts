// Self-healing WebSocket for the live snapshot feed.
//
// Liveness: the server broadcasts a snapshot every 5s, so silence for
// `staleMs` (default 15s = three missed frames) means the socket is dead even if
// the browser still reports it OPEN (half-open TCP after sleep/resume, a network
// switch, a proxy that drops traffic without closing). The watchdog then reports
// disconnected — which re-enables the REST fallback — and reconnects.
//
// Reconnects use capped exponential backoff with jitter; the attempt counter
// resets only once a frame actually arrives, so a server that accepts the
// upgrade and then stalls doesn't get hammered.

/** Connection-state callbacks for the WS indicator in the header. */
export interface WsCallbacks<T> {
	onSnapshot(snapshot: T): void;
	onStatus?(connected: boolean): void;
}

/** Handle returned by {@link openLiveSocket}; call `close()` to stop reconnecting. */
export interface WsHandle {
	close(): void;
}

export interface LiveSocketOptions {
	/** Silence (ms) after which the socket is declared dead. Default 15000. */
	staleMs?: number;
	/** First reconnect delay (ms) before jitter. Default 1000. */
	baseDelayMs?: number;
	/** Maximum reconnect delay (ms). Default 30000. */
	maxDelayMs?: number;
	/** Jitter source in [0, 1). Default Math.random. */
	random?: () => number;
}

/** Capped exponential backoff, jittered to 50–100% of the nominal delay. */
export function backoffDelay(
	attempt: number,
	baseMs: number,
	maxMs: number,
	random: () => number = Math.random,
): number {
	const nominal = Math.min(maxMs, baseMs * 2 ** Math.max(0, attempt));
	return Math.round(nominal * (0.5 + random() / 2));
}

/** Is `data` an object frame whose `type` is `type`? */
function isTyped<T>(data: unknown, type: string): data is T {
	return data !== null && typeof data === "object" && (data as { type?: unknown }).type === type;
}

/**
 * Open `url` and invoke `onSnapshot` for each parsed `{type: "snapshot"}` frame.
 * Auto-reconnects (backoff + jitter) after a close, an error, or `staleMs` of
 * silence, until the returned handle's `close()` is called.
 */
export function openLiveSocket<T>(
	url: string,
	callbacks: WsCallbacks<T>,
	opts: LiveSocketOptions = {},
): WsHandle {
	const staleMs = opts.staleMs ?? 15_000;
	const baseDelayMs = opts.baseDelayMs ?? 1000;
	const maxDelayMs = opts.maxDelayMs ?? 30_000;
	const random = opts.random ?? Math.random;

	let socket: WebSocket | null = null;
	let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
	let watchdog: ReturnType<typeof setTimeout> | undefined;
	let attempt = 0;
	let closed = false;

	const setStatus = (connected: boolean) => callbacks.onStatus?.(connected);

	const clearWatchdog = () => {
		if (watchdog !== undefined) clearTimeout(watchdog);
		watchdog = undefined;
	};

	/** Detach and close the current socket without triggering its own reconnect. */
	const drop = () => {
		clearWatchdog();
		if (!socket) return;
		const ws = socket;
		socket = null;
		ws.onopen = null;
		ws.onmessage = null;
		ws.onerror = null;
		ws.onclose = null;
		try {
			ws.close();
		} catch {
			// Already closing/closed.
		}
	};

	const scheduleReconnect = () => {
		if (closed || reconnectTimer !== undefined) return;
		const delay = backoffDelay(attempt, baseDelayMs, maxDelayMs, random);
		attempt++;
		reconnectTimer = setTimeout(() => {
			reconnectTimer = undefined;
			open();
		}, delay);
	};

	const armWatchdog = () => {
		clearWatchdog();
		watchdog = setTimeout(() => {
			// No frame for staleMs: the socket is dead even if it still looks OPEN.
			drop();
			setStatus(false);
			scheduleReconnect();
		}, staleMs);
	};

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
		// Armed before the handshake too, so a connect that never completes is caught.
		armWatchdog();

		ws.onopen = () => setStatus(true);

		ws.onmessage = (event) => {
			armWatchdog();
			attempt = 0;
			let data: unknown;
			try {
				data = JSON.parse(String(event.data));
			} catch {
				return;
			}
			if (isTyped<T>(data, "snapshot")) callbacks.onSnapshot(data);
		};

		ws.onerror = () => {
			// onclose fires after onerror; let it drive reconnect to avoid double timers.
			setStatus(false);
		};

		ws.onclose = () => {
			clearWatchdog();
			socket = null;
			setStatus(false);
			scheduleReconnect();
		};
	};

	open();

	return {
		close() {
			closed = true;
			if (reconnectTimer !== undefined) {
				clearTimeout(reconnectTimer);
				reconnectTimer = undefined;
			}
			drop();
		},
	};
}
