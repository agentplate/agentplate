/**
 * Tests for runTurn — the hard wall-clock cap, how the prompt reaches the
 * runtime (stdin, not argv), and the allowlisted child env. Real subprocesses
 * via the mock runtime (a `bash -lc` snippet), so we exercise true behavior.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
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

describe("runTurn — prompt delivery", () => {
	test("a stdin runtime gets the whole prompt on stdin — 300 KB of mail cannot hit E2BIG", async () => {
		// Linux caps ONE argv element at 128 KiB; a turn prompt is all unread mail.
		const promptFile = join(cwd, "prompt.txt");
		process.env.AGENTPLATE_MOCK_CMD = `cat > '${promptFile}'`;
		const prompt = `You have 40 new message(s):\n\n${"long test log line\n".repeat(16_000)}`;
		expect(prompt.length).toBeGreaterThan(256 * 1024);

		const result = await runTurn({ runtime, worktreePath: cwd, model: "m", prompt });
		expect(result.exitCode).toBe(0);
		expect(readFileSync(promptFile, "utf8")).toBe(prompt);
	});

	test("an argv runtime's child gets a closed stdin (never blocks reading it)", async () => {
		class ArgvRuntime extends MockRuntime {
			override readonly promptInput = "argv" as const;
		}
		const promptFile = join(cwd, "prompt.txt");
		process.env.AGENTPLATE_MOCK_CMD = `cat > '${promptFile}'`;
		const result = await runTurn({
			runtime: new ArgvRuntime(),
			worktreePath: cwd,
			model: "m",
			prompt: "not on stdin",
		});
		expect(result.exitCode).toBe(0);
		expect(readFileSync(promptFile, "utf8")).toBe("");
	});
});

describe("runTurn — environment", () => {
	const SECRET = ["ghp", "turnfixture0123456789abcdefABCDEF"].join("_");
	const saved: Record<string, string | undefined> = {};
	beforeEach(() => {
		for (const name of ["GHCR_TOKEN", "MOCKRT_HOME"]) saved[name] = process.env[name];
		process.env.GHCR_TOKEN = SECRET;
		process.env.MOCKRT_HOME = "/opt/mockrt";
	});
	afterEach(() => {
		for (const [name, value] of Object.entries(saved)) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
	});

	test("the agent sees the allowlist + runtime passthrough + provider env, never deploy secrets", async () => {
		class PassthroughRuntime extends MockRuntime {
			readonly envPassthrough = ["MOCKRT_*"] as const;
		}
		const probe = join(cwd, "env.txt");
		process.env.AGENTPLATE_MOCK_CMD = `printf '%s|%s|%s|%s' "\${GHCR_TOKEN-absent}" "\${PROVIDER_KEY-}" "\${MOCKRT_HOME-}" "\${PATH:+path-ok}" > '${probe}'`;
		const result = await runTurn({
			runtime: new PassthroughRuntime(),
			worktreePath: cwd,
			model: "m",
			prompt: "go",
			env: { PROVIDER_KEY: "provider-key" },
		});
		expect(result.exitCode).toBe(0);
		expect(readFileSync(probe, "utf8")).toBe("absent|provider-key|/opt/mockrt|path-ok");
	});
});
