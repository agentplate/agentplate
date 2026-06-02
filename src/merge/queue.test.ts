/**
 * Tests for the FIFO merge queue.
 *
 * Uses a real on-disk temp-file SQLite database (not `:memory:`) so we exercise
 * the same WAL-mode path production uses; an in-memory DB would skip WAL/journal
 * behavior entirely. Each test gets a fresh temp directory.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { MergeEntry } from "../types.ts";
import { createMergeQueue, type MergeQueue } from "./queue.ts";

let dir: string;
let queue: MergeQueue;

/** Convenience: enqueue with sensible defaults, overridable per field. */
function add(overrides: Partial<Omit<MergeEntry, "id" | "createdAt" | "status">> = {}): MergeEntry {
	return queue.enqueue({
		branchName: overrides.branchName ?? "agent/feature",
		agentName: overrides.agentName ?? "builder-1",
		taskId: overrides.taskId ?? "task-1",
		targetBranch: overrides.targetBranch ?? "main",
	});
}

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "agentplate-queue-"));
	queue = createMergeQueue(join(dir, "merge-queue.db"));
});

afterEach(() => {
	queue.close();
	rmSync(dir, { recursive: true, force: true });
});

describe("createMergeQueue", () => {
	test("enqueue assigns id, createdAt, and pending status", () => {
		const entry = add({ branchName: "agent/a", agentName: "a", taskId: "t-a" });
		expect(entry.id).toBeString();
		expect(entry.id.length).toBeGreaterThan(0);
		expect(entry.status).toBe("pending");
		expect(entry.branchName).toBe("agent/a");
		expect(entry.agentName).toBe("a");
		expect(entry.taskId).toBe("t-a");
		expect(entry.targetBranch).toBe("main");
		// createdAt is an ISO-8601 string round-trippable through Date.
		expect(new Date(entry.createdAt).toISOString()).toBe(entry.createdAt);
	});

	test("each enqueue produces a unique id", () => {
		const a = add();
		const b = add();
		expect(a.id).not.toBe(b.id);
	});

	test("listPending returns only pending entries, oldest first", () => {
		const a = add({ branchName: "agent/a" });
		const b = add({ branchName: "agent/b" });
		const c = add({ branchName: "agent/c" });

		// Mark the middle one merged — it should drop out of listPending.
		queue.markStatus(b.id, "merged");

		const pending = queue.listPending();
		expect(pending.map((e) => e.branchName)).toEqual(["agent/a", "agent/c"]);
		expect(pending.map((e) => e.id)).toEqual([a.id, c.id]);
	});

	test("dequeue removes and returns the oldest pending entry (FIFO)", () => {
		const first = add({ branchName: "agent/first" });
		const second = add({ branchName: "agent/second" });

		const dq1 = queue.dequeue();
		expect(dq1?.id).toBe(first.id);
		expect(dq1?.branchName).toBe("agent/first");

		// It is gone now; the next dequeue yields the second entry.
		const dq2 = queue.dequeue();
		expect(dq2?.id).toBe(second.id);

		expect(queue.dequeue()).toBeNull();
		expect(queue.listPending()).toHaveLength(0);
	});

	test("dequeue skips non-pending entries", () => {
		const a = add({ branchName: "agent/a" });
		const b = add({ branchName: "agent/b" });

		// First entry already failed — dequeue must return the next pending one.
		queue.markStatus(a.id, "failed");

		const dq = queue.dequeue();
		expect(dq?.id).toBe(b.id);
		// The failed entry remains in the table (it was not dequeued).
		expect(queue.listPending()).toHaveLength(0);
	});

	test("dequeue returns null on an empty queue", () => {
		expect(queue.dequeue()).toBeNull();
	});

	test("markStatus updates an entry and removes it from listPending", () => {
		const a = add();
		expect(queue.listPending()).toHaveLength(1);

		queue.markStatus(a.id, "merged");
		expect(queue.listPending()).toHaveLength(0);
	});

	test("markStatus throws NotFoundError for an unknown id", () => {
		expect(() => queue.markStatus("does-not-exist", "merged")).toThrow(
			/No merge queue entry with id/,
		);
	});

	test("queue state persists across reopen (same db file)", () => {
		const a = add({ branchName: "agent/persist" });
		queue.close();

		const reopened = createMergeQueue(join(dir, "merge-queue.db"));
		try {
			const pending = reopened.listPending();
			expect(pending).toHaveLength(1);
			expect(pending[0]?.id).toBe(a.id);
			expect(pending[0]?.branchName).toBe("agent/persist");
		} finally {
			reopened.close();
			// Re-open the module-level handle so afterEach's close() is valid.
			queue = createMergeQueue(join(dir, "merge-queue.db"));
		}
	});
});
