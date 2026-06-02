/**
 * Secret storage.
 *
 * Secrets (API keys, deploy tokens) are stored as `ENV_VAR_NAME: value` pairs in
 * `.agentplate/secrets.local.yaml`, which is gitignored and never committed. The
 * rest of Agentplate references secrets only by their env-var *name*; values are
 * read here at the moment they are needed and injected into a child process env.
 *
 * Resolution order for {@link getSecret}: the secrets file first, then
 * `process.env` (so CI can supply credentials via the environment without a
 * file).
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import yaml from "js-yaml";
import { AGENTPLATE_DIR } from "./config.ts";
import { ConfigError } from "./errors.ts";

/** Filename of the gitignored secrets store. */
export const SECRETS_FILE = "secrets.local.yaml";

/** Absolute path to the secrets file for a project root. */
export function secretsPath(root: string): string {
	return join(root, AGENTPLATE_DIR, SECRETS_FILE);
}

/** Load all stored secrets for a project root (empty object if none). */
export function loadSecrets(root: string): Record<string, string> {
	const path = secretsPath(root);
	if (!existsSync(path)) return {};
	let parsed: unknown;
	try {
		parsed = yaml.load(readFileSync(path, "utf8"));
	} catch (error) {
		throw new ConfigError(`Invalid YAML in ${path}: ${(error as Error).message}`);
	}
	if (parsed === null || parsed === undefined) return {};
	if (typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new ConfigError(`Expected a mapping in ${path}`);
	}
	const result: Record<string, string> = {};
	for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
		if (typeof value === "string") result[key] = value;
	}
	return result;
}

/**
 * Persist a secret under an env-var name. Writes the gitignored secrets file
 * with restrictive (0600) permissions.
 */
export function setSecret(root: string, key: string, value: string): void {
	const path = secretsPath(root);
	const current = loadSecrets(root);
	current[key] = value;
	const header =
		"# Agentplate secrets — gitignored, never commit this file.\n" +
		"# Maps ENV_VAR_NAME: value. Values are injected into agent/deploy processes on demand.\n";
	writeFileSync(path, header + yaml.dump(current, { indent: 2 }), { mode: 0o600 });
}

/**
 * Read a secret by env-var name. Checks the secrets file, then `process.env`.
 * Returns `undefined` if neither has it.
 */
export function getSecret(root: string, key: string): string | undefined {
	const fromFile = loadSecrets(root)[key];
	if (fromFile !== undefined && fromFile !== "") return fromFile;
	const fromEnv = process.env[key];
	if (fromEnv !== undefined && fromEnv !== "") return fromEnv;
	return undefined;
}

/** True if a secret is available (file or env) for the given env-var name. */
export function hasSecret(root: string, key: string): boolean {
	return getSecret(root, key) !== undefined;
}
