import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG, serializeConfig } from "../config.ts";
import { createEventStore } from "../events/store.ts";
import { currentRunPath, eventsDbPath, sessionsDbPath } from "../paths.ts";
import { createSessionStore } from "../sessions/store.ts";
import type { AgentSession } from "../types.ts";
import { matchRoute, resolveRoute } from "./api.ts";
import { type ServeHandle, startServer } from "./server.ts";

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
