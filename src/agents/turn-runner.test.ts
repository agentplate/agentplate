/**
 * Tests for runTurn — focused on the hard wall-clock cap. Real subprocesses via
 * the mock runtime (a `bash -lc` snippet), so we exercise true kill behavior.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockRuntime } from "../runtimes/mock.ts";
import { runTurn } from "./turn-runner.ts";

let cwd: string;
const runtime = new MockRuntime();

beforeEach(() => {
	cwd = mkdtempSync(join(tmpdir(), "agentplate-turnrunner-"));
});
afterEach(() => {
	rmSync(cwd, { recursive: true, force: true });
	process.env.AGENTPLATE_MOCK_CMD = undefined;
});

describe("runTurn — turn timeout", () => {
	test("kills a turn that exceeds timeoutMs and flags timedOut", async () => {
		process.env.AGENTPLATE_MOCK_CMD = "sleep 10"; // would hang well past the cap
		const started = performance.now();
		const result = await runTurn({
			runtime,
			worktreePath: cwd,
			model: "m",
			prompt: "",
			timeoutMs: 200,
		});
		const elapsed = performance.now() - started;

		expect(result.timedOut).toBe(true);
		expect(result.exitCode).not.toBe(0); // killed → non-zero
		expect(elapsed).toBeLessThan(3000); // resolved at the cap, not after 10s
	});

	test("does not flag timedOut when the turn finishes within the cap", async () => {
		process.env.AGENTPLATE_MOCK_CMD = "true"; // instant exit 0
		const result = await runTurn({
			runtime,
			worktreePath: cwd,
			model: "m",
			prompt: "",
			timeoutMs: 5000,
		});
		expect(result.timedOut).toBe(false);
		expect(result.exitCode).toBe(0);
	});

	test("no cap when timeoutMs is omitted/zero", async () => {
		process.env.AGENTPLATE_MOCK_CMD = "true";
		const result = await runTurn({
			runtime,
			worktreePath: cwd,
			model: "m",
			prompt: "",
			timeoutMs: 0,
		});
		expect(result.timedOut).toBe(false);
		expect(result.exitCode).toBe(0);
	});
});
