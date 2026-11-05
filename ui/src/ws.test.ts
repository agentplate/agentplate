// Runs under the root `bun test` against a real Bun.serve WebSocket server.
// Excluded from the UI tsconfig (its CI job has no bun types).

import { afterEach, describe, expect, test } from "bun:test";
import type { Server } from "bun";
import { backoffDelay, openLiveSocket, type WsHandle } from "./ws.ts";

interface Snap {
	type: "snapshot";
	n: number;
}

let server: Server<undefined> | null = null;
let handle: WsHandle | null = null;

afterEach(() => {
	handle?.close();
	handle = null;
	server?.stop(true);
	server = null;
});

/** A server that sends one snapshot on open, then goes silent (a "dead" socket). */
function silentAfterFirstFrame(): { url: string; opens: () => number } {
	let opens = 0;
	server = Bun.serve<undefined>({
		port: 0,
		hostname: "127.0.0.1",
		fetch(req, srv) {
			return srv.upgrade(req, { data: undefined })
				? undefined
				: new Response("no", { status: 400 });
		},
		websocket: {
			open(ws) {
				opens++;
				ws.send(JSON.stringify({ type: "snapshot", n: opens }));
			},
			message() {},
		},
	});
	return { url: `ws://127.0.0.1:${server.port}/ws`, opens: () => opens };
}

function waitFor(cond: () => boolean, timeoutMs = 3000): Promise<void> {
	const start = Date.now();
	return new Promise((resolve, reject) => {
		const tick = () => {
			if (cond()) return resolve();
			if (Date.now() - start > timeoutMs) return reject(new Error("timed out"));
			setTimeout(tick, 10);
		};
		tick();
	});
}

describe("openLiveSocket liveness watchdog", () => {
	test("silence past staleMs reports disconnected (REST fallback) and reconnects", async () => {
		const srv = silentAfterFirstFrame();
		const statuses: boolean[] = [];
		const snaps: Snap[] = [];
		handle = openLiveSocket<Snap>(
			srv.url,
			{ onSnapshot: (s) => snaps.push(s), onStatus: (c) => statuses.push(c) },
			{ staleMs: 150, baseDelayMs: 20, maxDelayMs: 40, random: () => 0 },
		);
		await waitFor(() => snaps.length >= 1);
		expect(statuses[0]).toBe(true);
		// The socket stays OPEN but no frame arrives: the watchdog must flip to offline…
		await waitFor(() => statuses.includes(false));
		// …and open a fresh connection, which delivers a new snapshot.
		await waitFor(() => srv.opens() >= 2 && snaps.length >= 2);
		expect(snaps[1]?.n).toBe(2);
	});

	test("frames arriving within staleMs keep the connection (no false reconnects)", async () => {
		let opens = 0;
		server = Bun.serve<undefined>({
			port: 0,
			hostname: "127.0.0.1",
			fetch(req, srv) {
				return srv.upgrade(req, { data: undefined })
					? undefined
					: new Response("no", { status: 400 });
			},
			websocket: {
				open(ws) {
					opens++;
					const t = setInterval(() => {
						try {
							ws.send(JSON.stringify({ type: "snapshot", n: 0 }));
						} catch {
							clearInterval(t);
						}
					}, 40);
				},
				close() {},
				message() {},
			},
		});
		const statuses: boolean[] = [];
		handle = openLiveSocket<Snap>(
			`ws://127.0.0.1:${server.port}/ws`,
			{ onSnapshot: () => {}, onStatus: (c) => statuses.push(c) },
			{ staleMs: 200 },
		);
		await new Promise((r) => setTimeout(r, 600));
		expect(opens).toBe(1);
		expect(statuses).toEqual([true]);
	});

	test("close() stops reconnecting", async () => {
		const srv = silentAfterFirstFrame();
		handle = openLiveSocket<Snap>(
			srv.url,
			{ onSnapshot: () => {} },
			{ staleMs: 50, baseDelayMs: 10, random: () => 0 },
		);
		await waitFor(() => srv.opens() >= 1);
		handle.close();
		await new Promise((r) => setTimeout(r, 200));
		expect(srv.opens()).toBe(1);
	});
});

describe("backoffDelay", () => {
	test("doubles per attempt, caps at max, jitters to 50–100%", () => {
		expect(backoffDelay(0, 1000, 30_000, () => 0.999999)).toBe(1000);
		expect(backoffDelay(1, 1000, 30_000, () => 0.999999)).toBe(2000);
		expect(backoffDelay(3, 1000, 30_000, () => 0)).toBe(4000);
		expect(backoffDelay(20, 1000, 30_000, () => 0.999999)).toBe(30_000);
		expect(backoffDelay(20, 1000, 30_000, () => 0)).toBe(15_000);
	});
});
