/**
 * Custom error types for Agentplate.
 *
 * All Agentplate errors extend {@link AgentplateError}, which carries a stable string
 * `code` (for JSON output / programmatic handling) and an `exitCode` used by the
 * CLI entry point when terminating the process. Throw these from anywhere; the
 * top-level handler in `src/index.ts` formats them consistently.
 */

/** Base class for every error Agentplate raises intentionally. */
export class AgentplateError extends Error {
	/** Stable, machine-readable error code (e.g. "CONFIG_ERROR"). */
	readonly code: string;
	/** Process exit code the CLI should use for this error. */
	readonly exitCode: number;

	constructor(message: string, code = "AGENTPLATE_ERROR", exitCode = 1) {
		super(message);
		this.name = new.target.name;
		this.code = code;
		this.exitCode = exitCode;
		// Maintains a clean stack trace where supported.
		Error.captureStackTrace?.(this, new.target);
	}
}

/** Configuration is missing, malformed, or fails validation. */
export class ConfigError extends AgentplateError {
	constructor(message: string) {
		super(message, "CONFIG_ERROR", 1);
	}
}

/** A user-supplied value (flag, argument, input) is invalid. */
export class ValidationError extends AgentplateError {
	constructor(message: string) {
		super(message, "VALIDATION_ERROR", 2);
	}
}

/** A git worktree operation failed. */
export class WorktreeError extends AgentplateError {
	constructor(message: string) {
		super(message, "WORKTREE_ERROR", 1);
	}
}

/** An external subprocess (git, a runtime CLI, a deploy CLI) failed. */
export class SubprocessError extends AgentplateError {
	/** Exit code reported by the failed subprocess, if known. */
	readonly subprocessExitCode: number | null;

	constructor(message: string, subprocessExitCode: number | null = null) {
		super(message, "SUBPROCESS_ERROR", 1);
		this.subprocessExitCode = subprocessExitCode;
	}
}

/** A requested resource (agent, session, skill, target) could not be found. */
export class NotFoundError extends AgentplateError {
	constructor(message: string) {
		super(message, "NOT_FOUND", 4);
	}
}

/**
 * A spawn was refused because it would exceed a configured orchestration limit
 * (maxConcurrent / maxAgentsPerLead / maxDepth). Distinct exit code so callers
 * (a lead/coordinator) can recognize "at capacity — back off and retry later".
 */
export class CapacityError extends AgentplateError {
	constructor(message: string) {
		super(message, "CAPACITY_EXCEEDED", 5);
	}
}

/** Type guard: is the given value a AgentplateError? */
export function isAgentplateError(value: unknown): value is AgentplateError {
	return value instanceof AgentplateError;
}
