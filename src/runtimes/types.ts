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
	/** Extra env vars (merged over process.env by the caller). */
	env?: Record<string, string>;
	/** Initial user-turn text (the prompt for this turn). */
	prompt?: string;
}

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

	/** Build argv for a one-shot non-interactive call (used by AI merge/distill later). */
	buildPrintCommand(prompt: string, model?: string): string[];

	/** Parse a headless stdout byte stream into normalized events. */
	parseEvents?(stream: ReadableStream<Uint8Array>): AsyncIterable<AgentEvent>;

	/** Deploy any runtime-specific guards/config into the worktree before spawn. */
	deployConfig?(worktreePath: string): Promise<void>;
}
