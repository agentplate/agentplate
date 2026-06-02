import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sessionsDbPath } from "../paths.ts";
import type { AgentSession } from "../types.ts";
import { reapIdleSessions, selectIdleSessions } from "./reaper.ts";
import { createSessionStore } from "./store.ts";

const NOW = Date.parse("2026-06-01T12:00:00.000Z");
const IDLE_MS = 10 * 60_000;

/** ISO timestamp `n` minutes before NOW. */
function minsAgo(n: number): string {
	return new Date(NOW - n * 60_000).toISOString();
}

function mk(overrides: Partial<AgentSession>): AgentSession {
	return {
		id: `s-${overrides.agentName ?? "a"}`,
		agentName: "a",
		capability: "builder",
		taskId: "t",
		runId: "r1",
		// Not under .agentplate/worktrees, so the removable-worktree guard skips git.
		worktreePath: "/tmp/not-managed/a",
		branchName: "agentplate/a",
		state: "idle",
		parentAgent: null,
		depth: 1,
		pid: null,
		runtimeSessionId: null,
		startedAt: minsAgo(60),
		lastActivity: minsAgo(60),
		...overrides,
	};
}

describe("selectIdleSessions", () => {
	test("reaps an active session idle past the window", () => {
		const out = selectIdleSessions([mk({ agentName: "old", lastActivity: minsAgo(11) })], {
			idleMs: IDLE_MS,
			now: NOW,
		});
		expect(out.map((s) => s.agentName)).toEqual(["old"]);
	});

	test("keeps a session active within the window", () => {
		const out = selectIdleSessions([mk({ agentName: "fresh", lastActivity: minsAgo(5) })], {
			idleMs: IDLE_MS,
			now: NOW,
		});
		expect(out).toEqual([]);
	});

	test("reaps exactly at the boundary", () => {
		const out = selectIdleSessions([mk({ agentName: "edge", lastActivity: minsAgo(10) })], {
			idleMs: IDLE_MS,
			now: NOW,
		});
		expect(out.map((s) => s.agentName)).toEqual(["edge"]);
	});

	test("reaps stalled working/booting sessions too (no activity = idle)", () => {
		const sessions = [
			mk({ agentName: "hung", state: "working", lastActivity: minsAgo(20) }),
			mk({ agentName: "boot", state: "booting", lastActivity: minsAgo(20) }),
		];
		expect(
			selectIdleSessions(sessions, { idleMs: IDLE_MS, now: NOW })
				.map((s) => s.agentName)
				.sort(),
		).toEqual(["boot", "hung"]);
	});

	test("skips terminal states", () => {
		const sessions = [
			mk({ agentName: "done", state: "completed", lastActivity: minsAgo(60) }),
			mk({ agentName: "failed", state: "failed", lastActivity: minsAgo(60) }),
			mk({ agentName: "stopped", state: "stopped", lastActivity: minsAgo(60) }),
		];
		expect(selectIdleSessions(sessions, { idleMs: IDLE_MS, now: NOW })).toEqual([]);
	});

	test("excludes the coordinator by default", () => {
		const coord = mk({
			agentName: "coordinator",
			capability: "coordinator",
			state: "working",
			lastActivity: minsAgo(60),
		});
		expect(selectIdleSessions([coord], { idleMs: IDLE_MS, now: NOW })).toEqual([]);
	});

	test("honors a custom exclude list", () => {
		const lead = mk({ agentName: "l", capability: "lead", lastActivity: minsAgo(60) });
		expect(
			selectIdleSessions([lead], { idleMs: IDLE_MS, now: NOW, excludeCapabilities: ["lead"] }),
		).toEqual([]);
	});

	test("skips sessions with an unparseable lastActivity", () => {
		const bad = mk({ agentName: "bad", lastActivity: "not-a-date" });
		expect(selectIdleSessions([bad], { idleMs: IDLE_MS, now: NOW })).toEqual([]);
	});
});

describe("reapIdleSessions", () => {
	let root: string;
	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "ap-reap-"));
	});
	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	test("marks idle sessions stopped, leaves fresh ones, and reports what it reaped", async () => {
		const store = createSessionStore(sessionsDbPath(root));
		try {
			const run = store.createRun("r");
			store.upsertSession(
				mk({ id: "s-old", agentName: "old", runId: run.id, lastActivity: minsAgo(30) }),
			);
			store.upsertSession(
				mk({ id: "s-fresh", agentName: "fresh", runId: run.id, lastActivity: minsAgo(2) }),
			);

			const reaped = await reapIdleSessions(store, root, { idleMs: IDLE_MS, now: NOW });

			expect(reaped.map((r) => r.agentName)).toEqual(["old"]);
			expect(reaped[0]?.idleMs).toBe(30 * 60_000);
			// `old` is now stopped; `fresh` keeps running.
			expect(store.getSessionByAgent("old")?.state).toBe("stopped");
			expect(store.getSessionByAgent("fresh")?.state).toBe("idle");
		} finally {
			store.close();
		}
	});

	test("never touches the coordinator even when long-idle", async () => {
		const store = createSessionStore(sessionsDbPath(root));
		try {
			const run = store.createRun("r");
			store.upsertSession(
				mk({
					id: "s-coord",
					agentName: "coordinator",
					capability: "coordinator",
					state: "working",
					worktreePath: root, // coordinator runs at the project root
					runId: run.id,
					lastActivity: minsAgo(120),
				}),
			);
			const reaped = await reapIdleSessions(store, root, { idleMs: IDLE_MS, now: NOW });
			expect(reaped).toEqual([]);
			expect(store.getSessionByAgent("coordinator")?.state).toBe("working");
		} finally {
			store.close();
		}
	});
});
