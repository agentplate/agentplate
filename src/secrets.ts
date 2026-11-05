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

import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import yaml from "js-yaml";
import { AGENTPLATE_DIR } from "./config.ts";
import { ConfigError } from "./errors.ts";
import { createLogger } from "./logging/logger.ts";

const log = createLogger({ scope: "secrets" });

/** Filename of the gitignored secrets store. */
export const SECRETS_FILE = "secrets.local.yaml";

/** Absolute path to the secrets file for a project root. */
export function secretsPath(root: string): string {
	return join(root, AGENTPLATE_DIR, SECRETS_FILE);
}

/**
 * YAML schema for the secrets file: every scalar is kept as its literal text
 * (the FAILSAFE schema), except that an empty value / `~` / `null` is a null.
 * The default schema would coerce an unquoted `PIN: 0123` to the number 123,
 * `TOKEN: 0x1f` to 31 and `FLAG: true` to a boolean — a token that merely looks
 * numeric must survive verbatim, not be mangled or dropped.
 */
const SECRETS_SCHEMA = yaml.FAILSAFE_SCHEMA.extend({
	implicit: [
		// YAML's core null (`NAME:`, `~`, `null`); quoted `'null'` stays a string.
		new yaml.Type("tag:yaml.org,2002:null", {
			kind: "scalar",
			resolve: (data: string | null) =>
				data === null || data === "~" || data === "null" || data === "Null" || data === "NULL",
			construct: () => null,
		}),
	],
});

/** Invalid entries already warned about (`path\0key`), so each warns once per process. */
const warnedInvalid = new Set<string>();

/**
 * Parse the secrets file into `name → value`, where `null` is an entry with no
 * value (`NAME:` left blank). A nested mapping or list cannot be a secret:
 *
 * - `mode: "read"` (lookups) skips that entry with a one-time warning naming
 *   the key, so one bad entry cannot break every other secret lookup.
 * - `mode: "write"` (before {@link setSecret} rewrites the file) raises a
 *   {@link ConfigError} naming the key instead — the rewrite would otherwise
 *   silently erase it from disk.
 */
function readSecretsFile(path: string, mode: "read" | "write"): Record<string, string | null> {
	if (!existsSync(path)) return {};
	let parsed: unknown;
	try {
		parsed = yaml.load(readFileSync(path, "utf8"), { schema: SECRETS_SCHEMA });
	} catch (error) {
		throw new ConfigError(`Invalid YAML in ${path}: ${(error as Error).message}`);
	}
	if (parsed === null || parsed === undefined) return {};
	if (typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new ConfigError(`Expected a mapping in ${path}`);
	}
	const result: Record<string, string | null> = {};
	for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
		if (typeof value !== "string" && value !== null) {
			// Under SECRETS_SCHEMA the only other node kinds are mappings and lists.
			const kind = Array.isArray(value) ? "list" : "mapping";
			const problem = `Secret ${key} in ${path} must be a plain string value, not a ${kind}.`;
			if (mode === "write") throw new ConfigError(`${problem} Fix or remove that entry.`);
			const warnKey = `${path}\0${key}`;
			if (!warnedInvalid.has(warnKey)) {
				warnedInvalid.add(warnKey);
				log.warn(`${problem} Ignoring it; fix or remove that entry.`);
			}
			continue;
		}
		result[key] = value;
	}
	return result;
}

/** Load all stored secrets for a project root (empty object if none). */
export function loadSecrets(root: string): Record<string, string> {
	const result: Record<string, string> = {};
	for (const [key, value] of Object.entries(readSecretsFile(secretsPath(root), "read"))) {
		if (value !== null) result[key] = value;
	}
	return result;
}

/**
 * Persist a secret under an env-var name. Writes the gitignored secrets file
 * with restrictive (0600) permissions. Every existing entry — including a
 * value-less `NAME:` placeholder — is preserved.
 */
export function setSecret(root: string, key: string, value: string): void {
	const path = secretsPath(root);
	const current = readSecretsFile(path, "write");
	current[key] = value;
	const header =
		"# Agentplate secrets — gitignored, never commit this file.\n" +
		"# Maps ENV_VAR_NAME: value. Values are injected into agent/deploy processes on demand.\n";
	// writeFileSync's `mode` only applies when it CREATES the file: an existing
	// file (hand-made, copied in, restored from backup) keeps its old, possibly
	// group/world-readable mode. Tighten it before writing so the new value never
	// lands in a loose file, and re-assert after so every write leaves 0600.
	if (existsSync(path)) chmodSync(path, 0o600);
	writeFileSync(path, header + yaml.dump(current, { indent: 2 }), { mode: 0o600 });
	chmodSync(path, 0o600);
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
