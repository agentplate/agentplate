/**
 * Tests for the Costs report (`buildCosts`, served at /api/costs).
 *
 * Uses a real temp project with a file-backed events.db. Filler events are bulk
 * inserted in one SQL statement so the log can outgrow any "newest N" window
 * quickly.
 */

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEventStore } from "../events/store.ts";
import { eventsDbPath } from "../paths.ts";
import { buildCosts } from "./api.ts";

let root: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "agentplate-costs-"));
	mkdirSync(join(root, ".agentplate"), { recursive: true });
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

/** Append `count` usage-free streamed events (tool_use etc.) in one statement. */
function addFillerEvents(count: number): void {
	const db = new Database(eventsDbPath(root));
	db.query(
		`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?)
		 INSERT INTO events (id, agent_name, run_id, type, tool, detail, created_at)
		 SELECT 'filler-' || i, 'builder-1', 'r1', 'tool_use', 'Bash', NULL, '2026-03-02T09:00:00.000Z'
		 FROM n`,
	).run(count);
	db.close();
}

describe("buildCosts", () => {
	test("counts usage from turns older than the newest 5000 events", () => {
		const store = createEventStore(eventsDbPath(root));
		store.record({
			agentName: "scout-1",
			runId: "r1",
			type: "result",
			detail: JSON.stringify({ tokens: 1000, cost: 0.25 }),
		});
		store.close();
		// Backdate the early turn so it lands on its own day in the trend.
		const db = new Database(eventsDbPath(root));
		db.exec("UPDATE events SET created_at = '2026-03-01T08:00:00.000Z'");
		db.close();

		// A busy day of streamed tool events pushes that turn far out of any
		// newest-5000 window...
		addFillerEvents(6000);
		// ...followed by a newer turn.
		const later = createEventStore(eventsDbPath(root));
		later.record({
			agentName: "builder-1",
			runId: "r1",
			type: "result",
			detail: JSON.stringify({ tokens: 10, cost: 0.01 }),
		});
		later.close();

		const report = buildCosts({ root });
		expect(report.hasData).toBe(true);
		expect(report.totalTokens).toBe(1010);
		expect(report.totalCostUsd).toBeCloseTo(0.26, 4);
		expect(report.byAgent.map((a) => a.agent)).toEqual(["scout-1", "builder-1"]);
		expect(report.byAgent[0]).toEqual({ agent: "scout-1", tokens: 1000, costUsd: 0.25 });
		expect(report.daily[0]).toEqual({ date: "2026-03-01", costUsd: 0.25, tokens: 1000 });
		expect(report.daily).toHaveLength(2);
	});

	test("reports hasData:false on an empty log", () => {
		const report = buildCosts({ root });
		expect(report).toEqual({
			hasData: false,
			totalTokens: 0,
			totalCostUsd: 0,
			daily: [],
			byAgent: [],
		});
	});
});
