/**
 * Tests for the session/run store.
 *
 * Per project policy we never mock the database: every test runs against a real
 * bun:sqlite handle. We default to an in-memory DB (`:memory:`) for speed and
 * isolation, plus one file-backed case to prove parent-directory creation and
 * cross-reopen persistence.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentSession, SessionState } from "../types.ts";
import { createSessionStore, type SessionStore } from "./store.ts";

/**
 * Build a fully-populated AgentSession with sensible defaults; pass `overrides`
 * to vary the fields a given test cares about. Centralizing this keeps each test
 * focused on the behavior under exercise rather than on boilerplate.
 */
function makeSession(overrides: Partial<AgentSession> = {}): AgentSession {
	const now = new Date().toISOString();
	return {
		id: crypto.randomUUID(),
		agentName: `agent-${crypto.randomUUID().slice(0, 4)}`,
		capability: "builder",
		taskId: "task-1",
		runId: "run-test",
		worktreePath: "/tmp/wt",
		branchName: "feature/x",
		state: "booting",
		parentAgent: null,
		depth: 0,
		pid: null,
		runtimeSessionId: null,
		startedAt: now,
		lastActivity: now,
		...overrides,
	};
}

describe("createSessionStore — runs", () => {
	let store: SessionStore;

	beforeEach(() => {
		store = createSessionStore(":memory:");
	});

	afterEach(() => {
		store.close();
	});

	test("createRun returns an active run with a run- prefixed id", () => {
		const run = store.createRun("nightly");
		expect(run.id).toMatch(/^run-[0-9a-f]{8}$/);
		expect(run.label).toBe("nightly");
		expect(run.status).toBe("active");
		// createdAt should be a valid ISO-8601 timestamp.
		expect(Number.isNaN(Date.parse(run.createdAt))).toBe(false);
	});

	test("createRun without a label omits the label field", () => {
		const run = store.createRun();
		expect(run.label).toBeUndefined();
		const fetched = store.getRun(run.id);
		expect(fetched?.label).toBeUndefined();
	});

	test("getRun returns null for an unknown id", () => {
		expect(store.getRun("run-missing")).toBeNull();
	});

	test("getRun round-trips a created run", () => {
		const run = store.createRun("label-a");
		const fetched = store.getRun(run.id);
		expect(fetched).toEqual(run);
	});

	test("listRuns returns newest first and honors the limit", () => {
		const a = store.createRun("a");
		// Distinct createdAt values guarantee a stable DESC ordering.
		Bun.sleepSync(2);
		const b = store.createRun("b");
		Bun.sleepSync(2);
		const c = store.createRun("c");

		const all = store.listRuns();
		expect(all.map((r) => r.id)).toEqual([c.id, b.id, a.id]);

		const limited = store.listRuns(2);
		expect(limited.map((r) => r.id)).toEqual([c.id, b.id]);
	});

	test("completeRun flips status to completed", () => {
		const run = store.createRun();
		expect(store.getRun(run.id)?.status).toBe("active");
		store.completeRun(run.id);
		expect(store.getRun(run.id)?.status).toBe("completed");
	});
});

describe("createSessionStore — sessions", () => {
	let store: SessionStore;

	beforeEach(() => {
		store = createSessionStore(":memory:");
	});

	afterEach(() => {
		store.close();
	});

	test("upsertSession inserts and getSession round-trips every field", () => {
		const session = makeSession({
			parentAgent: "lead-1",
			depth: 2,
			pid: 4242,
			runtimeSessionId: "rt-123",
		});
		store.upsertSession(session);
		const fetched = store.getSession(session.id);
		expect(fetched).toEqual(session);
	});

	test("upsertSession preserves null fields", () => {
		const session = makeSession({
			parentAgent: null,
			pid: null,
			runtimeSessionId: null,
		});
		store.upsertSession(session);
		const fetched = store.getSession(session.id);
		expect(fetched?.parentAgent).toBeNull();
		expect(fetched?.pid).toBeNull();
		expect(fetched?.runtimeSessionId).toBeNull();
	});

	test("upsertSession on the same id updates fields but keeps startedAt", () => {
		const original = makeSession({ state: "booting", capability: "scout" });
		store.upsertSession(original);

		// Re-upsert with the same id but a later startedAt and changed fields;
		// startedAt must NOT be overwritten (sessions keep their birth time).
		const mutated: AgentSession = {
			...original,
			state: "working",
			capability: "builder",
			pid: 99,
			startedAt: new Date(Date.parse(original.startedAt) + 60_000).toISOString(),
			lastActivity: new Date(Date.parse(original.lastActivity) + 60_000).toISOString(),
		};
		store.upsertSession(mutated);

		const fetched = store.getSession(original.id);
		expect(fetched?.state).toBe("working");
		expect(fetched?.capability).toBe("builder");
		expect(fetched?.pid).toBe(99);
		expect(fetched?.startedAt).toBe(original.startedAt);
		expect(fetched?.lastActivity).toBe(mutated.lastActivity);

		// Still exactly one row for that id.
		expect(store.listSessions().length).toBe(1);
	});

	test("getSession returns null for an unknown id", () => {
		expect(store.getSession("nope")).toBeNull();
	});

	test("getSessionByAgent returns the most recent session for a name", () => {
		const olderId = crypto.randomUUID();
		const newerId = crypto.randomUUID();
		const t0 = new Date().toISOString();
		store.upsertSession(makeSession({ id: olderId, agentName: "dup", startedAt: t0 }));
		const t1 = new Date(Date.parse(t0) + 1000).toISOString();
		store.upsertSession(makeSession({ id: newerId, agentName: "dup", startedAt: t1 }));

		const fetched = store.getSessionByAgent("dup");
		expect(fetched?.id).toBe(newerId);
	});

	test("getSessionByAgent returns null when no session matches", () => {
		expect(store.getSessionByAgent("ghost")).toBeNull();
	});

	test("setRuntimeSessionId persists the id and bumps lastActivity", () => {
		const past = new Date(Date.now() - 60_000).toISOString();
		const session = makeSession({ runtimeSessionId: null, lastActivity: past, startedAt: past });
		store.upsertSession(session);

		store.setRuntimeSessionId(session.id, "rt-xyz");
		const fetched = store.getSession(session.id);
		expect(fetched?.runtimeSessionId).toBe("rt-xyz");
		expect(Date.parse(fetched?.lastActivity ?? "")).toBeGreaterThan(Date.parse(past));
	});

	test("touch refreshes lastActivity without changing state", () => {
		const past = new Date(Date.now() - 60_000).toISOString();
		const session = makeSession({ state: "idle", lastActivity: past, startedAt: past });
		store.upsertSession(session);

		store.touch(session.id);
		const fetched = store.getSession(session.id);
		expect(fetched?.state).toBe("idle");
		expect(Date.parse(fetched?.lastActivity ?? "")).toBeGreaterThan(Date.parse(past));
	});
});

describe("createSessionStore — state transitions", () => {
	let store: SessionStore;

	beforeEach(() => {
		store = createSessionStore(":memory:");
	});

	afterEach(() => {
		store.close();
	});

	test("updateSessionState walks a session through its lifecycle", () => {
		const past = new Date(Date.now() - 60_000).toISOString();
		const session = makeSession({ state: "booting", lastActivity: past, startedAt: past });
		store.upsertSession(session);

		const order: SessionState[] = ["working", "idle", "working", "completed"];
		for (const next of order) {
			store.updateSessionState(session.id, next);
			expect(store.getSession(session.id)?.state).toBe(next);
		}

		// The transitions must also have advanced lastActivity past its seed.
		const fetched = store.getSession(session.id);
		expect(Date.parse(fetched?.lastActivity ?? "")).toBeGreaterThan(Date.parse(past));
	});
});

describe("createSessionStore — listing and filtering", () => {
	let store: SessionStore;

	beforeEach(() => {
		store = createSessionStore(":memory:");
	});

	afterEach(() => {
		store.close();
	});

	test("listSessions orders by startedAt ascending and filters by run/state", () => {
		const t = (ms: number) => new Date(Date.parse("2026-01-01T00:00:00.000Z") + ms).toISOString();
		// run-a: one working, one completed. run-b: one working.
		store.upsertSession(
			makeSession({ runId: "run-a", state: "working", startedAt: t(0), agentName: "a1" }),
		);
		store.upsertSession(
			makeSession({ runId: "run-a", state: "completed", startedAt: t(10), agentName: "a2" }),
		);
		store.upsertSession(
			makeSession({ runId: "run-b", state: "working", startedAt: t(20), agentName: "b1" }),
		);

		// No filter: all three, ascending by startedAt.
		const all = store.listSessions();
		expect(all.map((s) => s.agentName)).toEqual(["a1", "a2", "b1"]);

		// Filter by runId.
		const runA = store.listSessions({ runId: "run-a" });
		expect(runA.map((s) => s.agentName)).toEqual(["a1", "a2"]);

		// Filter by state.
		const working = store.listSessions({ state: "working" });
		expect(working.map((s) => s.agentName).sort()).toEqual(["a1", "b1"]);

		// Combined filter (AND).
		const runAWorking = store.listSessions({ runId: "run-a", state: "working" });
		expect(runAWorking.map((s) => s.agentName)).toEqual(["a1"]);

		// A filter matching nothing returns an empty array.
		expect(store.listSessions({ runId: "run-zzz" })).toEqual([]);
	});
});

describe("createSessionStore — countActive", () => {
	let store: SessionStore;

	beforeEach(() => {
		store = createSessionStore(":memory:");
	});

	afterEach(() => {
		store.close();
	});

	test("countActive counts booting/working/idle and excludes terminal states", () => {
		// run-1: booting, working, idle (3 active), plus completed/failed/stopped.
		store.upsertSession(makeSession({ runId: "run-1", state: "booting" }));
		store.upsertSession(makeSession({ runId: "run-1", state: "working" }));
		store.upsertSession(makeSession({ runId: "run-1", state: "idle" }));
		store.upsertSession(makeSession({ runId: "run-1", state: "completed" }));
		store.upsertSession(makeSession({ runId: "run-1", state: "failed" }));
		store.upsertSession(makeSession({ runId: "run-1", state: "stopped" }));
		// run-2: one working.
		store.upsertSession(makeSession({ runId: "run-2", state: "working" }));

		// Global active count across both runs: 3 + 1 = 4.
		expect(store.countActive()).toBe(4);
		// Per-run scoping.
		expect(store.countActive("run-1")).toBe(3);
		expect(store.countActive("run-2")).toBe(1);
		// Unknown run -> 0.
		expect(store.countActive("run-none")).toBe(0);
	});

	test("countActive reflects state transitions", () => {
		const s = makeSession({ runId: "run-x", state: "working" });
		store.upsertSession(s);
		expect(store.countActive("run-x")).toBe(1);

		store.updateSessionState(s.id, "completed");
		expect(store.countActive("run-x")).toBe(0);
	});
});

describe("createSessionStore — file-backed database", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "agentplate-sessions-"));
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	test("creates the parent directory and persists across reopen", () => {
		// Point at a NON-existent nested path to exercise the mkdir-parent logic.
		const dbPath = join(dir, "nested", "sessions.db");

		const first = createSessionStore(dbPath);
		const run = first.createRun("persisted");
		const session = makeSession({ runId: run.id, state: "working" });
		first.upsertSession(session);
		first.close();

		// Reopen the same file: data must still be there.
		const second = createSessionStore(dbPath);
		expect(second.getRun(run.id)?.label).toBe("persisted");
		expect(second.getSession(session.id)?.state).toBe("working");
		expect(second.countActive(run.id)).toBe(1);
		second.close();
	});
});
