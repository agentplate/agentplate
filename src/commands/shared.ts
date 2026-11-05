/**
 * Small helpers shared by the CLI commands.
 */

import { existsSync, readFileSync } from "node:fs";
import { findProjectRoot, isInitialized } from "../config.ts";
import { ValidationError } from "../errors.ts";
import { currentRunPath } from "../paths.ts";

/** The project root, or a ValidationError when the project is not initialized. */
export function requireInit(): string {
	const root = findProjectRoot();
	if (!isInitialized(root)) {
		throw new ValidationError("Not initialized. Run `agentplate setup` first.");
	}
	return root;
}

/** The active run id from `.agentplate/current-run.txt`, or null when unset or unreadable. */
export function readCurrentRun(root: string): string | null {
	const path = currentRunPath(root);
	if (!existsSync(path)) return null;
	try {
		return readFileSync(path, "utf8").trim() || null;
	} catch {
		return null;
	}
}
