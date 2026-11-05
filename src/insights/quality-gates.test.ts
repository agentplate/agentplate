/**
 * Tests for runQualityGates. Real subprocesses (no mocks) — gates are shell
 * commands, so we use `true`/`false`/`sleep` to exercise pass/fail/partial, to
 * prove the gates run concurrently (wall-clock < sum of durations), that a hung
 * gate is killed with its process tree, and that gates get the allowlisted env.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { QualityGate } from "../types.ts";
import { DEFAULT_GATE_TIMEOUT_MINUTES, runQualityGates } from "./quality-gates.ts";

const gate = (name: string, command: string): QualityGate => ({ name, command });

describe("runQualityGates", () => {
	test("returns null when there are no gates", async () => {
		expect(await runQualityGates([], process.cwd())).toBeNull();
	});

	test("all passing → success", async () => {
		const out = await runQualityGates([gate("a", "true"), gate("b", "true")], process.cwd());
		expect(out?.status).toBe("success");
		expect(out?.results.every((r) => r.passed)).toBe(true);
	});

	test("all failing → failure", async () => {
		const out = await runQualityGates([gate("a", "false"), gate("b", "false")], process.cwd());
		expect(out?.status).toBe("failure");
	});

	test("mixed → partial", async () => {
		const out = await runQualityGates([gate("ok", "true"), gate("bad", "false")], process.cwd());
		expect(out?.status).toBe("partial");
		// Order is preserved across the concurrent run.
		expect(out?.results.map((r) => r.name)).toEqual(["ok", "bad"]);
	});

	test("gates run concurrently (wall-clock well under the sum)", async () => {
		const gates = [gate("s1", "sleep 0.3"), gate("s2", "sleep 0.3"), gate("s3", "sleep 0.3")];
		const out = await runQualityGates(gates, process.cwd());
		expect(out?.status).toBe("success");
		// Sequential would be ~900ms; concurrent should be well under that.
		expect(out?.totalDurationMs ?? Number.POSITIVE_INFINITY).toBeLessThan(700);
	});
});

describe("runQualityGates — time limit", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "agentplate-gates-"));
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	test("a hung gate is killed at its timeoutMinutes and fails (the batch still resolves)", async () => {
		const hung: QualityGate = { name: "hang", command: "sleep 30", timeoutMinutes: 0.005 }; // 300ms
		const started = performance.now();
		const out = await runQualityGates([gate("ok", "true"), hung], dir, { killGraceMs: 200 });
		expect(performance.now() - started).toBeLessThan(4000);
		expect(out?.status).toBe("partial");
		const result = out?.results.find((r) => r.name === "hang");
		expect(result?.timedOut).toBe(true);
		expect(result?.passed).toBe(false);
		expect(out?.results.find((r) => r.name === "ok")?.timedOut).toBe(false);
	});

	test("the timeout kills the gate's whole process tree, not just the shell", async () => {
		// The test runner under `bash -lc` (here a backgrounded subshell) must die
		// with the gate; otherwise a hung `bun test` lingers after every turn.
		const marker = join(dir, "orphan-ran");
		const out = await runQualityGates(
			[
				{
					name: "tree",
					command: `(sleep 1 && touch '${marker}') & sleep 30`,
					timeoutMinutes: 0.005,
				},
			],
			dir,
			{ killGraceMs: 200 },
		);
		expect(out?.results[0]?.timedOut).toBe(true);
		await Bun.sleep(1500);
		expect(existsSync(marker)).toBe(false);
	});

	test("timeoutMinutes: 0 disables the cap", async () => {
		const out = await runQualityGates(
			[{ name: "slowish", command: "sleep 0.2", timeoutMinutes: 0 }],
			dir,
		);
		expect(out?.status).toBe("success");
		expect(out?.results[0]?.timedOut).toBe(false);
	});

	test("the default cap is 30 minutes", () => {
		expect(DEFAULT_GATE_TIMEOUT_MINUTES).toBe(30);
	});
});

describe("runQualityGates — environment", () => {
	const SECRET = ["ghp", "gatefixture0123456789abcdefABCDEF"].join("_");
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "agentplate-gates-env-"));
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	test("gates (code an agent wrote) never see deploy secrets, but keep PATH/HOME", async () => {
		// The secret must be in agentplate's STARTUP environment, as in CI — a
		// spawn without an explicit `env` inherits that, not runtime mutations of
		// process.env — so the gates run inside a fresh `bun` that starts with it.
		const script = join(dir, "run-gates.ts");
		const noSecret = `test -z "\${GHCR_TOKEN-}"`;
		const hasBasics = 'test -n "$PATH" && test -n "$HOME" && command -v git >/dev/null';
		writeFileSync(
			script,
			[
				`import { runQualityGates } from ${JSON.stringify(join(import.meta.dir, "quality-gates.ts"))};`,
				"const out = await runQualityGates([",
				`  { name: "no-secret", command: ${JSON.stringify(noSecret)} },`,
				`  { name: "has-basics", command: ${JSON.stringify(hasBasics)} },`,
				"], process.cwd());",
				"process.stdout.write(JSON.stringify(out?.results.map((r) => [r.name, r.passed])));",
			].join("\n"),
		);
		const proc = Bun.spawn([process.execPath, script], {
			cwd: dir,
			env: { ...process.env, GHCR_TOKEN: SECRET },
			stdout: "pipe",
			stderr: "pipe",
		});
		const stdout = await new Response(proc.stdout).text();
		expect(await proc.exited).toBe(0);
		expect(JSON.parse(stdout)).toEqual([
			["no-secret", true],
			["has-basics", true],
		]);
	});
});
