/**
 * Spawn-per-turn engine.
 *
 * Runs ONE headless turn of an agent: build the runtime's argv, spawn it in the
 * worktree, drain its output (parsing events when the runtime supports it, so we
 * can capture the resume session id and feed the event store), and return when
 * the process exits. The orchestration layer decides when to run the next turn
 * (driven by mail) — this module owns a single turn only.
 */

import type { AgentEvent, AgentRuntime } from "../runtimes/types.ts";
import { resolveArgv } from "../utils/detect.ts";

export interface RunTurnOptions {
	runtime: AgentRuntime;
	/** Worktree directory the turn runs in. */
	worktreePath: string;
	/** Concrete model id. */
	model: string;
	/** The user-turn text (dispatch/mail/nudge). */
	prompt: string;
	/** Provider env vars (merged over process.env for the child). */
	env?: Record<string, string>;
	/** Prior runtime session id, to resume across turns. */
	resumeSessionId?: string;
	/** Hard wall-clock cap in ms; the child is killed past it. 0/undefined = none. */
	timeoutMs?: number;
	/** Called for each parsed event (e.g. to record tool calls). */
	onEvent?: (event: AgentEvent) => void;
}

export interface TurnResult {
	exitCode: number;
	/** Runtime session id captured from the event stream (for --resume). */
	runtimeSessionId: string | null;
	/** Captured stderr (already bounded by the child). */
	stderr: string;
	/** True if the turn was killed by the wall-clock cap. */
	timedOut: boolean;
}

/** Run a single headless turn and resolve when the child process exits. */
export async function runTurn(opts: RunTurnOptions): Promise<TurnResult> {
	const argv = opts.runtime.buildDirectSpawn({
		cwd: opts.worktreePath,
		model: opts.model,
		instructionPath: opts.runtime.instructionPath,
		resumeSessionId: opts.resumeSessionId,
		prompt: opts.prompt,
		env: opts.env,
	});

	// Let the runtime contribute env beyond the resolved provider key — e.g.
	// OpenCode injects OPENCODE_PERMISSION so an unattended worker auto-approves
	// tool actions instead of deadlocking on a permission prompt. For runtimes that
	// add nothing this equals `opts.env`, so the behavior is unchanged.
	const runtimeEnv = opts.runtime.buildEnv({ model: opts.model, env: opts.env });
	const proc = Bun.spawn(resolveArgv(argv), {
		cwd: opts.worktreePath,
		env: { ...process.env, ...runtimeEnv },
		stdout: "pipe",
		stderr: "pipe",
		stdin: "ignore",
	});

	// Hard wall-clock cap: kill a turn that runs past the limit even if it keeps
	// streaming (idle reaping only catches inactivity). Closing the child's pipes
	// ends the drain/parse loops below, so the turn resolves with a non-zero exit.
	let timedOut = false;
	const timer =
		opts.timeoutMs && opts.timeoutMs > 0
			? setTimeout(() => {
					timedOut = true;
					proc.kill(); // SIGTERM
				}, opts.timeoutMs)
			: null;

	// Read stderr concurrently so a full pipe buffer can't deadlock the child.
	const stderrPromise = new Response(proc.stderr).text();

	let runtimeSessionId: string | null = null;
	if (opts.runtime.parseEvents) {
		for await (const event of opts.runtime.parseEvents(proc.stdout)) {
			if (event.sessionId) runtimeSessionId = event.sessionId;
			opts.onEvent?.(event);
		}
	} else {
		// No event parser (e.g. the mock runtime): just drain stdout.
		await new Response(proc.stdout).text();
	}

	const stderr = await stderrPromise;
	const exitCode = await proc.exited;
	if (timer) clearTimeout(timer);
	return { exitCode, runtimeSessionId, stderr, timedOut };
}
