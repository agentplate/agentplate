/**
 * Tests for runQualityGates. Real subprocesses (no mocks) — gates are shell
 * commands, so we use `true`/`false`/`sleep` to exercise pass/fail/partial and to
 * prove the gates run concurrently (wall-clock < sum of durations).
 */

import { describe, expect, test } from "bun:test";
import type { QualityGate } from "../types.ts";
import { runQualityGates } from "./quality-gates.ts";

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
