// Tests for the events SQLite store.
//
// We use a real in-memory SQLite database (":memory:") per test — no mocks. The
// store's only side effects are SQL writes, so an in-memory DB exercises the
// real code path (schema creation, inserts, filtered SELECTs) with no cleanup.

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_LIST_LIMIT } from "../db/sqlite.ts";
import type { EventStore } from "./store.ts";
import { createEventStore, EVENTS_MIGRATIONS } from "./store.ts";

describe("createEventStore", () => {
	let store: EventStore;

	beforeEach(() => {
		store = createEventStore(":memory:");
	});

	afterEach(() => {
		store.close();
	});

	test("record assigns an id and createdAt and echoes input fields", () => {
		const rec = store.record({
			agentName: "builder-1",
			runId: "run-abc",
			type: "tool-start",
			tool: "Bash",
			detail: "ls -la",
		});

		// id should be a UUID-shaped string.
		expect(typeof rec.id).toBe("string");
		expect(rec.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);

		// createdAt should be a valid ISO-8601 timestamp.
		expect(typeof rec.createdAt).toBe("string");
		expect(new Date(rec.createdAt).toISOString()).toBe(rec.createdAt);

		// Input fields round-trip.
		expect(rec.agentName).toBe("builder-1");
		expect(rec.runId).toBe("run-abc");
		expect(rec.type).toBe("tool-start");
		expect(rec.tool).toBe("Bash");
		expect(rec.detail).toBe("ls -la");
	});

	test("record normalises omitted optional fields to null", () => {
		const rec = store.record({ agentName: "scout-1", type: "session-start" });

		expect(rec.runId).toBeNull();
		expect(rec.tool).toBeNull();
		expect(rec.detail).toBeNull();
	});

	test("record assigns unique ids across calls", () => {
		const a = store.record({ agentName: "a", type: "x" });
		const b = store.record({ agentName: "a", type: "x" });
		expect(a.id).not.toBe(b.id);
	});

	test("list returns events newest first", () => {
		// Insert in a known order; the third insert is the most recent.
		store.record({ agentName: "a", type: "first" });
		store.record({ agentName: "a", type: "second" });
		store.record({ agentName: "a", type: "third" });

		const events = store.list();
		expect(events.length).toBe(3);
		// Newest first => reverse of insertion order.
		expect(events.map((e) => e.type)).toEqual(["third", "second", "first"]);

		// createdAt should be monotonically non-increasing down the list.
		for (let i = 1; i < events.length; i++) {
			const prev = events[i - 1];
			const curr = events[i];
			expect(prev).toBeDefined();
			expect(curr).toBeDefined();
			if (prev && curr) {
				expect(prev.createdAt >= curr.createdAt).toBe(true);
			}
		}
	});

	test("list filters by agentName", () => {
		store.record({ agentName: "builder", type: "t" });
		store.record({ agentName: "scout", type: "t" });
		store.record({ agentName: "builder", type: "t" });

		const builderEvents = store.list({ agentName: "builder" });
		expect(builderEvents.length).toBe(2);
		expect(builderEvents.every((e) => e.agentName === "builder")).toBe(true);

		const scoutEvents = store.list({ agentName: "scout" });
		expect(scoutEvents.length).toBe(1);
		expect(scoutEvents[0]?.agentName).toBe("scout");
	});

	test("list filters by runId", () => {
		store.record({ agentName: "a", runId: "run-1", type: "t" });
		store.record({ agentName: "a", runId: "run-2", type: "t" });
		store.record({ agentName: "a", runId: "run-1", type: "t" });

		const run1 = store.list({ runId: "run-1" });
		expect(run1.length).toBe(2);
		expect(run1.every((e) => e.runId === "run-1")).toBe(true);
	});

	test("list filters by type", () => {
		store.record({ agentName: "a", type: "tool-start" });
		store.record({ agentName: "a", type: "tool-end" });
		store.record({ agentName: "a", type: "tool-start" });

		const starts = store.list({ type: "tool-start" });
		expect(starts.length).toBe(2);
		expect(starts.every((e) => e.type === "tool-start")).toBe(true);
	});

	test("list combines multiple filters with AND", () => {
		store.record({ agentName: "builder", runId: "run-1", type: "tool-start" });
		store.record({ agentName: "builder", runId: "run-1", type: "tool-end" });
		store.record({ agentName: "builder", runId: "run-2", type: "tool-start" });
		store.record({ agentName: "scout", runId: "run-1", type: "tool-start" });

		const matched = store.list({
			agentName: "builder",
			runId: "run-1",
			type: "tool-start",
		});
		expect(matched.length).toBe(1);
		expect(matched[0]?.agentName).toBe("builder");
		expect(matched[0]?.runId).toBe("run-1");
		expect(matched[0]?.type).toBe("tool-start");
	});

	test("list applies a positive limit and keeps newest-first ordering", () => {
		store.record({ agentName: "a", type: "1" });
		store.record({ agentName: "a", type: "2" });
		store.record({ agentName: "a", type: "3" });
		store.record({ agentName: "a", type: "4" });

		const limited = store.list({ limit: 2 });
		expect(limited.length).toBe(2);
		// The two newest events.
		expect(limited.map((e) => e.type)).toEqual(["4", "3"]);
	});

	test("list with a limit larger than the row count returns all rows", () => {
		store.record({ agentName: "a", type: "1" });
		store.record({ agentName: "a", type: "2" });

		const events = store.list({ limit: 100 });
		expect(events.length).toBe(2);
	});

	test("list treats an invalid limit as the default cap, never as no limit", () => {
		const total = DEFAULT_LIST_LIMIT + 5;
		for (let i = 0; i < total; i++) store.record({ agentName: "a", type: String(i) });

		// 0 / negative / NaN neither truncate to nothing nor dump the whole log.
		for (const limit of [0, -1, -5, Number.NaN]) {
			const rows = store.list({ limit });
			expect(rows.length).toBe(DEFAULT_LIST_LIMIT);
			expect(rows[0]?.type).toBe(String(total - 1)); // still newest first
		}
		// Omitting the limit is the explicit "every row" request.
		expect(store.list().length).toBe(total);
	});

	test("list on an empty store returns an empty array", () => {
		expect(store.list()).toEqual([]);
		expect(store.list({ agentName: "nobody" })).toEqual([]);
	});

	test("filter + limit compose correctly", () => {
		// 3 builder events, 1 scout event interleaved.
		store.record({ agentName: "builder", type: "a" });
		store.record({ agentName: "scout", type: "a" });
		store.record({ agentName: "builder", type: "b" });
		store.record({ agentName: "builder", type: "c" });

		const limited = store.list({ agentName: "builder", limit: 2 });
		expect(limited.length).toBe(2);
		expect(limited.every((e) => e.agentName === "builder")).toBe(true);
		// Newest two builder events.
		expect(limited.map((e) => e.type)).toEqual(["c", "b"]);
	});

	test("deleteByAgent removes only that agent's rows and returns the count", () => {
		store.record({ agentName: "builder", type: "a" });
		store.record({ agentName: "builder", type: "b" });
		store.record({ agentName: "scout", type: "a" });

		expect(store.deleteByAgent("builder")).toBe(2);
		expect(store.list({ agentName: "builder" })).toEqual([]);
		expect(store.list({ agentName: "scout" }).length).toBe(1);
	});

	test("deleteByAgent scoped to a run leaves the agent's other runs intact", () => {
		store.record({ agentName: "builder", runId: "r1", type: "a" });
		store.record({ agentName: "builder", runId: "r2", type: "b" });

		expect(store.deleteByAgent("builder", "r1")).toBe(1);
		expect(store.list({ agentName: "builder" }).map((e) => e.runId)).toEqual(["r2"]);
	});

	test("deleteByAgent on an unknown agent returns 0", () => {
		expect(store.deleteByAgent("nobody")).toBe(0);
	});

	test("usageTotals is empty when no usage has been recorded", () => {
		store.record({ agentName: "a", type: "assistant" });
		expect(store.usageTotals()).toEqual([]);
	});
});

describe("usageTotals (file-backed, explicit timestamps)", () => {
	let dir: string;
	let path: string;
	let store: EventStore;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "agentplate-events-"));
		path = join(dir, "events.db");
		store = createEventStore(path);
	});

	afterEach(() => {
		store.close();
		rmSync(dir, { recursive: true, force: true });
	});

	/** Insert a row with a chosen created_at (the store always stamps "now"). */
	function insert(agent: string, createdAt: string, detail: string | null, type = "result"): void {
		const db = new Database(path);
		db.query(
			"INSERT INTO events (id, agent_name, run_id, type, tool, detail, created_at) VALUES (?, ?, NULL, ?, NULL, ?, ?)",
		).run(crypto.randomUUID(), agent, type, detail, createdAt);
		db.close();
	}

	test("sums by agent and day, oldest day first, ignoring rows without numeric usage", () => {
		insert("builder", "2026-03-01T10:00:00.000Z", JSON.stringify({ tokens: 100, cost: 0.02 }));
		insert("builder", "2026-03-01T23:59:59.999Z", JSON.stringify({ tokens: 50, cost: 0.01 }));
		insert("builder", "2026-03-02T00:00:00.000Z", JSON.stringify({ tokens: 7, costUsd: 0.5 }));
		insert("scout", "2026-03-01T12:00:00.000Z", JSON.stringify({ tokens: 30 }));
		// `cost` wins over `costUsd` when both are numeric (same as the old JS reader).
		insert("scout", "2026-03-02T12:00:00.000Z", JSON.stringify({ cost: 1, costUsd: 99 }));
		// None of these carry usage: they must not throw or contribute.
		insert("scout", "2026-03-01T12:00:00.000Z", "not json {", "error");
		insert("scout", "2026-03-01T12:00:00.000Z", null, "assistant");
		insert("scout", "2026-03-01T12:00:00.000Z", "[1, 2, 3]", "assistant");
		insert("scout", "2026-03-01T12:00:00.000Z", "42", "assistant");
		insert("scout", "2026-03-01T12:00:00.000Z", "null", "assistant");
		insert("scout", "2026-03-01T12:00:00.000Z", JSON.stringify({ tokens: "9", cost: true }));
		insert("idle", "2026-03-01T12:00:00.000Z", JSON.stringify({ tokens: 0, cost: 0 }));

		const buckets = store.usageTotals();
		expect(buckets.map((b) => ({ ...b, costUsd: Math.round(b.costUsd * 1e6) / 1e6 }))).toEqual([
			{ agentName: "builder", day: "2026-03-01", tokens: 150, costUsd: 0.03 },
			{ agentName: "scout", day: "2026-03-01", tokens: 30, costUsd: 0 },
			{ agentName: "builder", day: "2026-03-02", tokens: 7, costUsd: 0.5 },
			{ agentName: "scout", day: "2026-03-02", tokens: 0, costUsd: 1 },
		]);
	});

	test("an existing pre-versioning events.db keeps its rows and is stamped at the newest version", () => {
		store.record({ agentName: "a", type: "kept" });
		store.close();
		// Simulate a DB written before schema versioning existed.
		const raw = new Database(path);
		raw.exec("PRAGMA user_version = 0");
		raw.close();

		store = createEventStore(path);
		expect(store.list().map((e) => e.type)).toEqual(["kept"]);
		const check = new Database(path);
		const { user_version } = check.query("PRAGMA user_version").get() as { user_version: number };
		check.close();
		expect(user_version).toBe(EVENTS_MIGRATIONS.at(-1)?.version ?? -1);
	});
});
