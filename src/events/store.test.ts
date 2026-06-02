// Tests for the events SQLite store.
//
// We use a real in-memory SQLite database (":memory:") per test — no mocks. The
// store's only side effects are SQL writes, so an in-memory DB exercises the
// real code path (schema creation, inserts, filtered SELECTs) with no cleanup.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { EventStore } from "./store.ts";
import { createEventStore } from "./store.ts";

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

	test("list treats non-positive limit as no limit", () => {
		store.record({ agentName: "a", type: "1" });
		store.record({ agentName: "a", type: "2" });
		store.record({ agentName: "a", type: "3" });

		// 0 and negative should not silently truncate to nothing.
		expect(store.list({ limit: 0 }).length).toBe(3);
		expect(store.list({ limit: -5 }).length).toBe(3);
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
});
