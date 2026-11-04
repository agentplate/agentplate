import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { ValidationError } from "./errors.ts";
import { assertSafeTaskId, isPathInside, isSafeTaskId, specPath, specsDir } from "./paths.ts";

describe("isSafeTaskId", () => {
	test("accepts single-segment ids", () => {
		for (const id of ["task-1", "TASK-1", "ui-mw2q826t", "a", "v1.2_b", "x".repeat(64)]) {
			expect(isSafeTaskId(id)).toBe(true);
		}
	});

	test("rejects traversal, separators, leading dash/dot, and overlong ids", () => {
		for (const id of [
			"",
			"..",
			"../x",
			"../../CLAUDE",
			"a..b",
			"a/b",
			"a\\b",
			"-rf",
			".hidden",
			"a b",
			"x".repeat(65),
		]) {
			expect(isSafeTaskId(id)).toBe(false);
		}
	});

	test("assertSafeTaskId throws a ValidationError", () => {
		expect(() => assertSafeTaskId("../../CLAUDE")).toThrow(ValidationError);
		expect(() => assertSafeTaskId("task-1")).not.toThrow();
	});
});

describe("isPathInside", () => {
	test("confines paths to a directory", () => {
		const root = "/proj";
		expect(isPathInside(specsDir(root), specPath(root, "task-1"))).toBe(true);
		expect(isPathInside(specsDir(root), specPath(root, "../../README"))).toBe(false);
		expect(isPathInside(specsDir(root), specsDir(root))).toBe(false);
		// A sibling dir sharing the prefix is not "inside".
		expect(isPathInside(join(root, "specs"), join(root, "specs-evil", "x.md"))).toBe(false);
	});
});
