/**
 * Minimal structured logger.
 *
 * Phase 0 provides a lightweight, dependency-free logger that writes
 * human-readable lines to stderr and respects the global redaction setting.
 * Later phases can extend this with NDJSON file sinks per agent without changing
 * the call sites.
 */

import { sanitize } from "./sanitizer.ts";

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = {
	debug: 10,
	info: 20,
	warn: 30,
	error: 40,
};

export interface LoggerOptions {
	/** Minimum level to emit. */
	level?: LogLevel;
	/** Redact secrets from messages before writing. */
	redact?: boolean;
	/** Component name prefixed to each line. */
	scope?: string;
}

export interface Logger {
	debug(message: string): void;
	info(message: string): void;
	warn(message: string): void;
	error(message: string): void;
	child(scope: string): Logger;
}

/** Create a logger. Defaults: `info` level, redaction on, no scope. */
export function createLogger(options: LoggerOptions = {}): Logger {
	const level: LogLevel = options.level ?? "info";
	const redact = options.redact ?? true;
	const scope = options.scope;
	const threshold = LEVEL_ORDER[level];

	function emit(messageLevel: LogLevel, message: string): void {
		if (LEVEL_ORDER[messageLevel] < threshold) return;
		const text = redact ? sanitize(message) : message;
		const prefix = scope ? `[${scope}] ` : "";
		process.stderr.write(`${messageLevel.toUpperCase()} ${prefix}${text}\n`);
	}

	return {
		debug: (message) => emit("debug", message),
		info: (message) => emit("info", message),
		warn: (message) => emit("warn", message),
		error: (message) => emit("error", message),
		child: (childScope) =>
			createLogger({ level, redact, scope: scope ? `${scope}:${childScope}` : childScope }),
	};
}
