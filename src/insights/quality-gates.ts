/**
 * Quality gates — run the project's configured test/lint/typecheck commands and
 * fold their results into a single {@link OutcomeStatus}.
 *
 * The status threads through the self-improving loop: skills are only distilled
 * from work that passed, and applied-skill outcomes are scored by it, so the
 * confidence track record reflects whether changes actually held up.
 */

import type { OutcomeStatus, QualityGate } from "../types.ts";

export interface GateResult {
	name: string;
	command: string;
	passed: boolean;
	exitCode: number;
	durationMs: number;
}

export interface QualityGateOutcome {
	status: OutcomeStatus;
	results: GateResult[];
	totalDurationMs: number;
}

/**
 * Run each gate as a shell command in `cwd`. A gate passes on exit code 0.
 * Aggregate status: all pass → success, all fail → failure, mixed → partial.
 * Returns null when there are no gates configured (nothing to score).
 */
export async function runQualityGates(
	gates: QualityGate[],
	cwd: string,
): Promise<QualityGateOutcome | null> {
	if (gates.length === 0) return null;

	// Gates are independent checks, so run them concurrently and measure the
	// outcome by wall-clock — `totalDurationMs` is the elapsed time of the whole
	// batch (the slowest gate), not the sum of all gates.
	const overallStart = performance.now();
	const results: GateResult[] = await Promise.all(
		gates.map(async (gate): Promise<GateResult> => {
			const started = performance.now();
			let exitCode = 1;
			try {
				// Run the gate through the platform shell: `cmd /c` on Windows (no bash
				// there), `bash -lc` elsewhere. `.cmd` shims (biome/tsc) resolve under both.
				const shellArgv =
					process.platform === "win32"
						? ["cmd", "/d", "/s", "/c", gate.command]
						: ["bash", "-lc", gate.command];
				const proc = Bun.spawn(shellArgv, { cwd, stdout: "pipe", stderr: "pipe" });
				exitCode = await proc.exited;
			} catch {
				exitCode = 1;
			}
			return {
				name: gate.name,
				command: gate.command,
				passed: exitCode === 0,
				exitCode,
				durationMs: Math.round(performance.now() - started),
			};
		}),
	);
	const total = Math.round(performance.now() - overallStart);

	const passed = results.filter((r) => r.passed).length;
	const status: OutcomeStatus =
		passed === results.length ? "success" : passed === 0 ? "failure" : "partial";
	return { status, results, totalDurationMs: total };
}
