/**
 * Runtime registry — the single place that knows about concrete adapter classes.
 *
 * Everything else resolves a runtime by name through {@link getRuntime} and then
 * talks only to the {@link AgentRuntime} interface, so adding a new runtime is a
 * one-line registration here plus its adapter file. Resolution is deliberately
 * tiny: an explicit name, else a caller-supplied fallback, else `"claude"`.
 */

import { ValidationError } from "../errors.ts";
import { ClaudeRuntime } from "./claude.ts";
import { CodexRuntime } from "./codex.ts";
import { CursorRuntime } from "./cursor.ts";
import { GeminiRuntime } from "./gemini.ts";
import { MockRuntime } from "./mock.ts";
import { OpenCodeRuntime } from "./opencode.ts";
import type { AgentRuntime } from "./types.ts";

/**
 * Name → factory map. Factories return a *fresh* instance per call so adapters
 * can never accidentally share mutable state between resolutions. Insertion
 * order here defines the order reported by {@link getRuntimeNames} and in error
 * messages.
 */
const runtimes = new Map<string, () => AgentRuntime>([
	["claude", () => new ClaudeRuntime()],
	["codex", () => new CodexRuntime()],
	["gemini", () => new GeminiRuntime()],
	["cursor", () => new CursorRuntime()],
	["opencode", () => new OpenCodeRuntime()],
	["mock", () => new MockRuntime()],
]);

/**
 * Resolve a runtime adapter by name.
 *
 * Lookup order:
 *   1. explicit `name` (e.g. from `--runtime`),
 *   2. `fallback` (typically `config.runtime.default`),
 *   3. `"claude"` (the built-in default).
 *
 * Throws {@link ValidationError} listing the valid names when the resolved name
 * is unknown, so a typo at the CLI yields an actionable message rather than a
 * bare `undefined`.
 */
export function getRuntime(name?: string, fallback?: string): AgentRuntime {
	const resolved = name ?? fallback ?? "claude";
	const factory = runtimes.get(resolved);
	if (!factory) {
		throw new ValidationError(
			`Unknown runtime: "${resolved}". Valid runtimes: ${getRuntimeNames().join(", ")}`,
		);
	}
	return factory();
}

/**
 * Names of all registered runtimes, in registration order. Used to validate a
 * user-supplied runtime name and to render the choices in help / errors.
 */
export function getRuntimeNames(): string[] {
	return [...runtimes.keys()];
}
