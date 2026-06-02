/**
 * `agentplate sling` — unit tests for the spec-contract path.
 *
 * These cover the two pure pieces that fix the launch/mail race without spinning
 * up a full spawn: `readSpecContract` (the --spec guard) and `dispatchBody` (which
 * inlines the contract into the agent's first prompt). Real temp files, no mocks.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ValidationError } from "../errors.ts";
import type { OverlayConfig } from "../types.ts";
import { dispatchBody, readSpecContract } from "./sling.ts";

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "agentplate-sling-spec-"));
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe("readSpecContract", () => {
	test("returns empty string when no --spec is given (spec is optional)", () => {
		expect(readSpecContract(undefined, "task-1")).toBe("");
	});

	test("returns the file content when the spec exists and is non-empty", () => {
		const f = join(dir, "task-1.md");
		writeFileSync(f, "Goal: build the thing\n", "utf8");
		expect(readSpecContract(f, "task-1")).toBe("Goal: build the thing\n");
	});

	test("throws when the --spec file is missing (points at `spec write`)", () => {
		const missing = join(dir, "absent.md");
		expect(() => readSpecContract(missing, "task-1")).toThrow(ValidationError);
		try {
			readSpecContract(missing, "task-1");
		} catch (e) {
			expect((e as Error).message).toContain("agentplate spec write task-1");
		}
	});

	test("throws when the --spec file is empty/whitespace (blank contract)", () => {
		const f = join(dir, "blank.md");
		writeFileSync(f, "   \n\t\n", "utf8");
		expect(() => readSpecContract(f, "task-1")).toThrow(ValidationError);
	});
});

const baseCfg: OverlayConfig = {
	agentName: "lead-task-1",
	capability: "lead",
	taskId: "task-1",
	specPath: ".agentplate/specs/task-1.md",
	branchName: "agentplate/lead-task-1",
	worktreePath: "/tmp/wt",
	parentAgent: "coordinator",
	depth: 1,
	fileScope: [],
	baseDefinition: "",
	canSpawn: true,
	qualityGates: [],
	constraints: [],
};

describe("dispatchBody", () => {
	test("inlines the spec contract into the dispatch when present", () => {
		const body = dispatchBody("task-1", "lead", baseCfg, "Goal: build the thing");
		expect(body).toContain("=== SPEC");
		expect(body).toContain("Goal: build the thing");
		expect(body).toContain("Task: task-1");
	});

	test("omits the SPEC block when there is no spec body", () => {
		const body = dispatchBody("task-1", "lead", baseCfg, "");
		expect(body).not.toContain("=== SPEC");
		expect(body).toContain("Task: task-1");
	});
});
