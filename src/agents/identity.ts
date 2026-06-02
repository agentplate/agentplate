/**
 * Persistent agent identity (CV).
 *
 * Each agent accumulates a small "CV" across the sessions it runs: how many it
 * has completed, which expertise domains it has touched, and a rolling list of
 * its most recent tasks. This survives worktree cleanup because it is stored
 * under the *main* project's `.agentplate/` tree (not inside the agent's throwaway
 * worktree), so a long-lived named agent keeps its history run after run.
 *
 * Storage is one YAML file per agent at
 * `<root>/.agentplate/agents/<agentName>/identity.yaml`. We use js-yaml (the same
 * dependency and read/write style as `config.ts` and `secrets.ts`) rather than a
 * hand-rolled serializer so the format stays human-editable and robust.
 *
 * Why local types: {@link AgentIdentity} is not part of the shared `types.ts`
 * surface — it is an implementation detail of this module — so it is declared
 * here to keep the cross-module type barrel lean.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import yaml from "js-yaml";
import { AGENTPLATE_DIR } from "../config.ts";
import { ConfigError } from "../errors.ts";

/** Filename of an agent's CV within its identity directory. */
const IDENTITY_FILENAME = "identity.yaml";

/**
 * Maximum number of recent tasks retained on an identity. Older entries are
 * dropped from the front so the file stays small; the newest task is last.
 */
const MAX_RECENT_TASKS = 20;

/** One entry in an agent's rolling task history. */
export interface RecentTask {
	taskId: string;
	summary: string;
	/** ISO-8601 timestamp of when the task completed. */
	completedAt: string;
}

/** A persistent agent CV. */
export interface AgentIdentity {
	/** Unique agent name (also the directory name under `.agentplate/agents/`). */
	name: string;
	/** The capability this agent was created for (e.g. "builder"). */
	capability: string;
	/** ISO-8601 timestamp of first creation. */
	created: string;
	/** Count of sessions this agent has completed. */
	sessionsCompleted: number;
	/** Distinct expertise domains the agent has worked in. */
	expertiseDomains: string[];
	/** Rolling history of the most recent tasks (newest last), capped at 20. */
	recentTasks: RecentTask[];
}

/** Absolute path to an agent's identity directory under the project root. */
function identityDir(root: string, name: string): string {
	return join(root, AGENTPLATE_DIR, "agents", name);
}

/** Absolute path to an agent's `identity.yaml`. */
function identityPath(root: string, name: string): string {
	return join(identityDir(root, name), IDENTITY_FILENAME);
}

/**
 * Coerce an unknown parsed YAML value into a normalized {@link AgentIdentity}.
 *
 * We do not trust the on-disk shape (it may be hand-edited or written by an
 * older version), so every field is validated/defaulted defensively. Unknown or
 * malformed entries are skipped rather than crashing a long-lived agent.
 */
function coerceIdentity(parsed: unknown, name: string): AgentIdentity {
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new ConfigError(`Expected a mapping in identity file for agent "${name}"`);
	}
	const obj = parsed as Record<string, unknown>;

	const expertiseDomains: string[] = [];
	if (Array.isArray(obj.expertiseDomains)) {
		for (const domain of obj.expertiseDomains) {
			if (typeof domain === "string" && domain !== "") expertiseDomains.push(domain);
		}
	}

	const recentTasks: RecentTask[] = [];
	if (Array.isArray(obj.recentTasks)) {
		for (const entry of obj.recentTasks) {
			if (entry === null || typeof entry !== "object" || Array.isArray(entry)) continue;
			const task = entry as Record<string, unknown>;
			recentTasks.push({
				taskId: typeof task.taskId === "string" ? task.taskId : "",
				summary: typeof task.summary === "string" ? task.summary : "",
				completedAt: typeof task.completedAt === "string" ? task.completedAt : "",
			});
		}
	}

	return {
		// The on-disk name is advisory; the lookup key (`name`) is authoritative.
		name: typeof obj.name === "string" && obj.name !== "" ? obj.name : name,
		capability: typeof obj.capability === "string" ? obj.capability : "",
		created: typeof obj.created === "string" ? obj.created : new Date().toISOString(),
		sessionsCompleted:
			typeof obj.sessionsCompleted === "number" && Number.isFinite(obj.sessionsCompleted)
				? obj.sessionsCompleted
				: 0,
		expertiseDomains,
		recentTasks,
	};
}

/** Serialize an identity to YAML and write it atomically-ish to disk. */
function writeIdentity(root: string, identity: AgentIdentity): void {
	const path = identityPath(root, identity.name);
	mkdirSync(dirname(path), { recursive: true });
	const header =
		"# Agentplate agent identity (CV). Survives worktree cleanup.\n" +
		"# Managed by src/agents/identity.ts — safe to read, edit with care.\n";
	writeFileSync(path, header + yaml.dump(identity, { indent: 2, sortKeys: false }), "utf8");
}

/**
 * Create an agent identity, or return the existing one if already present.
 *
 * Creating is idempotent: if the identity file already exists it is loaded and
 * returned unchanged (so the agent's accumulated history is never clobbered by a
 * re-spawn). Only the first call writes a fresh CV.
 */
export function createIdentity(root: string, name: string, capability: string): AgentIdentity {
	const existing = loadIdentity(root, name);
	if (existing !== null) return existing;

	const identity: AgentIdentity = {
		name,
		capability,
		created: new Date().toISOString(),
		sessionsCompleted: 0,
		expertiseDomains: [],
		recentTasks: [],
	};
	writeIdentity(root, identity);
	return identity;
}

/**
 * Load an agent's identity, or `null` if it has none yet.
 *
 * @throws ConfigError if the file exists but contains invalid YAML or a
 * non-mapping top level.
 */
export function loadIdentity(root: string, name: string): AgentIdentity | null {
	const path = identityPath(root, name);
	if (!existsSync(path)) return null;

	let parsed: unknown;
	try {
		parsed = yaml.load(readFileSync(path, "utf8"));
	} catch (error) {
		throw new ConfigError(`Invalid YAML in ${path}: ${(error as Error).message}`);
	}
	// An empty file parses to null/undefined — treat it as "no identity".
	if (parsed === null || parsed === undefined) return null;
	return coerceIdentity(parsed, name);
}

/** Fields accepted by {@link updateIdentity}. */
export interface IdentityPatch {
	/** Task id to append to recent history (also required to record a task). */
	taskId?: string;
	/** Human-readable summary of the completed task. */
	summary?: string;
	/** Expertise domains to merge into the CV (deduplicated). */
	domains?: string[];
}

/**
 * Apply a patch to an agent's identity and persist it.
 *
 * Semantics (each is independent):
 * - `sessionsCompleted` is always incremented by one (an update marks the end of
 *   a session of work).
 * - `domains` are merged into `expertiseDomains`, preserving first-seen order and
 *   keeping each domain unique.
 * - A task is appended to `recentTasks` **only if `taskId` is provided**; the
 *   list is then capped at {@link MAX_RECENT_TASKS}, dropping the oldest entries.
 *   `completedAt` is stamped now (ISO-8601).
 *
 * If the agent has no identity yet, one is created on the fly (with an empty
 * capability) so callers never have to pre-create before recording.
 *
 * @throws ConfigError if an existing identity file is unreadable/invalid.
 */
export function updateIdentity(root: string, name: string, patch: IdentityPatch): AgentIdentity {
	const identity = loadIdentity(root, name) ?? createIdentity(root, name, "");

	// A patch represents one completed session of work.
	identity.sessionsCompleted += 1;

	// Merge domains, preserving order and uniqueness.
	if (patch.domains !== undefined && patch.domains.length > 0) {
		const seen = new Set(identity.expertiseDomains);
		for (const domain of patch.domains) {
			if (domain !== "" && !seen.has(domain)) {
				seen.add(domain);
				identity.expertiseDomains.push(domain);
			}
		}
	}

	// Append a task only when a taskId is given (summary is optional).
	if (patch.taskId !== undefined) {
		identity.recentTasks.push({
			taskId: patch.taskId,
			summary: patch.summary ?? "",
			completedAt: new Date().toISOString(),
		});
		if (identity.recentTasks.length > MAX_RECENT_TASKS) {
			// Drop oldest from the front; keep the newest MAX_RECENT_TASKS.
			identity.recentTasks = identity.recentTasks.slice(-MAX_RECENT_TASKS);
		}
	}

	writeIdentity(root, identity);
	return identity;
}
