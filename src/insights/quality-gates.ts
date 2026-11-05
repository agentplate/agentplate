/**
 * Quality gates — run the project's configured test/lint/typecheck commands and
 * fold their results into a single {@link OutcomeStatus}.
 *
 * The status threads through the self-improving loop: skills are only distilled
 * from work that passed, and applied-skill outcomes are scored by it, so the
 * confidence track record reflects whether changes actually held up.
 *
 * Gates run code an agent wrote, so each one gets the allowlisted agent env
 * (never the operator's deploy secrets) and a wall-clock cap
 * ({@link QualityGate.timeoutMinutes}, default {@link DEFAULT_GATE_TIMEOUT_MINUTES}):
 * a gate that hangs — `bun test` stuck on an open handle — is killed with its
 * whole process tree and fails, instead of stalling the post-turn pipeline.
 */

import type { OutcomeStatus, QualityGate } from "../types.ts";
import { agentChildEnv, armKillTimer } from "../utils/child-process.ts";

/** Per-gate wall-clock cap when the gate sets no `timeoutMinutes`. */
export const DEFAULT_GATE_TIMEOUT_MINUTES = 30;

export interface GateResult {
	name: string;
	command: string;
	passed: boolean;
	exitCode: number;
	durationMs: number;
	/** True when the gate was killed for exceeding its time limit. */
	timedOut: boolean;
}

export interface QualityGateOutcome {
	status: OutcomeStatus;
	results: GateResult[];
	totalDurationMs: number;
}

/** Options for {@link runQualityGates}. */
export interface RunQualityGatesOptions {
	/** Delay between SIGTERM and SIGKILL for a timed-out gate (tests shorten it). */
	killGraceMs?: number;
}

/**
 * Run each gate as a shell command in `cwd`. A gate passes on exit code 0; one
 * that exceeds its time limit fails. Aggregate status: all pass → success, all
 * fail → failure, mixed → partial. Returns null when there are no gates
 * configured (nothing to score).
 */
export async function runQualityGates(
	gates: QualityGate[],
	cwd: string,
	opts: RunQualityGatesOptions = {},
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
			let timedOut = false;
			try {
				// Run the gate through the platform shell: `cmd /c` on Windows (no bash
				// there), `bash -lc` elsewhere. `.cmd` shims (biome/tsc) resolve under both.
				const shellArgv =
					process.platform === "win32"
						? ["cmd", "/d", "/s", "/c", gate.command]
						: ["bash", "-lc", gate.command];
				const proc = Bun.spawn(shellArgv, {
					cwd,
					env: agentChildEnv(),
					stdout: "pipe",
					stderr: "pipe",
					// Lead a new process group so a timeout kills the gate's children
					// (the test runner under the shell), not just the shell.
					detached: process.platform !== "win32",
				});
				const killTimer = armKillTimer(proc, gateTimeoutMs(gate), {
					group: true,
					graceMs: opts.killGraceMs,
				});
				exitCode = await proc.exited;
				killTimer.clear();
				timedOut = killTimer.timedOut;
			} catch {
				exitCode = 1;
			}
			return {
				name: gate.name,
				command: gate.command,
				passed: exitCode === 0 && !timedOut,
				exitCode,
				durationMs: Math.round(performance.now() - started),
				timedOut,
			};
		}),
	);
	const total = Math.round(performance.now() - overallStart);

	const passed = results.filter((r) => r.passed).length;
	const status: OutcomeStatus =
		passed === results.length ? "success" : passed === 0 ? "failure" : "partial";
	return { status, results, totalDurationMs: total };
}

/** A gate's time limit in ms (`timeoutMinutes`, else the default; `<= 0` → none). */
function gateTimeoutMs(gate: QualityGate): number {
	const minutes = gate.timeoutMinutes ?? DEFAULT_GATE_TIMEOUT_MINUTES;
	return minutes > 0 ? minutes * 60_000 : 0;
}
