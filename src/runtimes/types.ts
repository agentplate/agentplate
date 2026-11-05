/**
 * Runtime adapter contract.
 *
 * A *runtime* is the coding-agent CLI that drives a worker (Claude Code, Codex,
 * …). Agentplate is headless-first: workers run as spawn-per-turn subprocesses, so
 * the core method is {@link AgentRuntime.buildDirectSpawn}, which returns the
 * argv for a single turn. Adapters are stateless; one file per CLI, resolved by
 * the registry. Auth flows through {@link AgentRuntime.buildEnv} — never
 * hardcoded.
 */

import type { ResolvedModel } from "../types.ts";

/** A normalized event parsed from a runtime's headless event stream. */
export interface AgentEvent {
	/** Coarse event kind: "assistant" | "tool_use" | "tool_result" | "result" | "session" | "error". */
	type: string;
	/** Tool name for tool events. */
	tool?: string;
	/** Runtime session id (emitted once near the start; used for --resume). */
	sessionId?: string;
	/**
	 * Token usage + USD cost, when the runtime reports it (e.g. a Claude Code
	 * `result` event carries `usage` + `total_cost_usd`). Recorded into the event
	 * store so the Costs page can aggregate real per-agent spend.
	 */
	usage?: { tokens: number; costUsd: number };
	/**
	 * Human-readable error message when this is an error event (e.g. OpenCode's
	 * `error.data.message`, a Claude error result). Recorded into the event store
	 * so a failed agent's reason is visible in the feed/logs instead of a blank
	 * "error" with no detail.
	 */
	error?: string;
	/** The raw parsed JSON line, for callers that need more detail. */
	raw: unknown;
}

/** Options for a single headless turn. */
export interface DirectSpawnOpts {
	/** Working directory (the worktree path). */
	cwd: string;
	/** Concrete model id. */
	model: string;
	/** Relative path to the instruction file within the worktree. */
	instructionPath: string;
	/** Resume a prior turn's session (omit for the first turn). */
	resumeSessionId?: string;
	/** Extra env vars (merged over the allowlisted parent env by the caller). */
	env?: Record<string, string>;
	/**
	 * Initial user-turn text (the prompt for this turn). A runtime whose
	 * {@link AgentRuntime.promptInput} is `"stdin"` leaves it OUT of argv — the
	 * caller writes it to the child's stdin instead.
	 */
	prompt?: string;
}

/**
 * How a runtime's CLI receives the prompt of a headless turn
 * ({@link AgentRuntime.buildDirectSpawn}) and of a one-shot call
 * ({@link AgentRuntime.buildPrintCommand}):
 *
 * - `"stdin"` — the argv carries NO prompt; the caller writes it to the
 *   child's stdin. A prompt of any size works: one argv element is capped at
 *   128 KiB on Linux (`E2BIG`) and a Windows `.cmd` shim's whole command line at
 *   8191 chars, and a turn prompt is all of an agent's unread mail.
 * - `"argv"` — the prompt is an argv element (a CLI with no stdin prompt
 *   mode); the child's stdin is closed.
 */
export type PromptInput = "stdin" | "argv";

/** Options for an attended (foreground, stdio-inherited) interactive session. */
export interface InteractiveSpawnOpts {
	/** Concrete model id. */
	model: string;
	/** System prompt text to append (the agent's role definition). */
	systemPrompt?: string;
	/** Permission posture: "default" (prompts) | "bypass" (unattended). */
	permissionMode?: "default" | "bypass";
	/** A first user message to seed the session with (non-empty → seeded). */
	initialMessage?: string;
}

/** The contract every runtime adapter implements. */
export interface AgentRuntime {
	/** Unique adapter id (e.g. "claude"). */
	id: string;
	/** Stability tier. */
	readonly stability: "stable" | "beta" | "experimental";
	/** Relative path where the overlay instructions are written in the worktree. */
	readonly instructionPath: string;

	/** How the turn / one-shot prompt reaches the CLI (default `"argv"`). */
	readonly promptInput?: PromptInput;

	/**
	 * Parent env vars this runtime's CLI needs beyond the base allowlist (its own
	 * config dir, login and feature flags), as exact names or `PREFIX_*`
	 * patterns. Agent-facing children never inherit the whole parent env — see
	 * `agentChildEnv` in `src/utils/child-process.ts`.
	 */
	readonly envPassthrough?: readonly string[];

	/** Build argv for a single headless turn (run via Bun.spawn). */
	buildDirectSpawn(opts: DirectSpawnOpts): string[];

	/**
	 * Build argv for an ATTENDED interactive session (foreground, stdio inherited).
	 * Used by `coordinator start` to hand the terminal to a live agent chat.
	 * Optional: runtimes that cannot run interactively omit it.
	 */
	buildInteractiveSpawn?(opts: InteractiveSpawnOpts): string[];

	/** Build provider env vars (API keys, base URLs) for the resolved model. */
	buildEnv(model: ResolvedModel): Record<string, string>;

	/**
	 * Build argv for a one-shot non-interactive call (used by the skill
	 * distiller). A `promptInput: "stdin"` runtime leaves `prompt` out of argv;
	 * the caller pipes it on stdin.
	 */
	buildPrintCommand(prompt: string, model?: string): string[];

	/** Parse a headless stdout byte stream into normalized events. */
	parseEvents?(stream: ReadableStream<Uint8Array>): AsyncIterable<AgentEvent>;

	/** Deploy any runtime-specific guards/config into the worktree before spawn. */
	deployConfig?(worktreePath: string): Promise<void>;
}
