/**
 * Tests for the sentinel-file merge lock.
 *
 * Uses real temp directories so the O_EXCL filesystem semantics are genuinely
 * exercised (no mocking of fs). Each test works inside a fresh temp root that
 * stands in for a project root containing `.agentplate/`.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { WorktreeError } from "../errors.ts";
import { acquireMergeLock, releaseMergeLock, withMergeLock } from "./lock.ts";

let root: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "agentplate-lock-"));
});

afterEach(() => {
	// Best-effort: drop the lock before removing the tree.
	releaseMergeLock(root);
	rmSync(root, { recursive: true, force: true });
});

describe("acquireMergeLock / releaseMergeLock", () => {
	test("first acquire succeeds and creates the sentinel file", () => {
		expect(acquireMergeLock(root)).toBe(true);
		expect(existsSync(join(root, ".agentplate", "merge.lock"))).toBe(true);
	});

	test("second acquire fails while the lock is held, then succeeds after release", () => {
		expect(acquireMergeLock(root)).toBe(true);
		// Lock is held: a second attempt must report contention (false), not throw.
		expect(acquireMergeLock(root)).toBe(false);

		releaseMergeLock(root);
		// After release the lock is free again.
		expect(acquireMergeLock(root)).toBe(true);
	});

	test("releaseMergeLock is idempotent (no throw when already released)", () => {
		expect(acquireMergeLock(root)).toBe(true);
		releaseMergeLock(root);
		expect(() => releaseMergeLock(root)).not.toThrow();
		expect(existsSync(join(root, ".agentplate", "merge.lock"))).toBe(false);
	});

	test("acquire creates .agentplate/ if it does not exist", () => {
		// Fresh temp root has no .agentplate/ subdir yet.
		expect(existsSync(join(root, ".agentplate"))).toBe(false);
		expect(acquireMergeLock(root)).toBe(true);
		expect(existsSync(join(root, ".agentplate"))).toBe(true);
	});
});

describe("withMergeLock", () => {
	test("runs fn while holding the lock and releases afterward", async () => {
		let observedDuringRun = false;
		const result = await withMergeLock(root, async () => {
			// Inside the critical section the lock is held, so a fresh acquire fails.
			observedDuringRun = acquireMergeLock(root) === false;
			return 42;
		});
		expect(result).toBe(42);
		expect(observedDuringRun).toBe(true);
		// Lock released after the body resolved: it can be taken again.
		expect(acquireMergeLock(root)).toBe(true);
	});

	test("releases the lock even when fn throws", async () => {
		await expect(
			withMergeLock(root, async () => {
				throw new Error("boom");
			}),
		).rejects.toThrow("boom");
		// Despite the throw, the lock must be free.
		expect(acquireMergeLock(root)).toBe(true);
	});

	test("throws WorktreeError if the lock is already held", async () => {
		expect(acquireMergeLock(root)).toBe(true);
		await expect(withMergeLock(root, async () => "unused")).rejects.toBeInstanceOf(WorktreeError);
	});
});
