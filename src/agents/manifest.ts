/**
 * Agent manifest: the static registry of capabilities.
 *
 * The manifest answers "what kinds of agents can Agentplate spawn, and with what
 * powers?" — the *HOW* of each role (model tier, allowed tools, spawn rights,
 * hard constraints). It is the Layer-1 base; the per-task overlay (see
 * {@link OverlayConfig}) supplies the Layer-2 *WHAT*.
 *
 * Each {@link AgentDefinition} is keyed by the single {@link Capability} it
 * provides, so the manifest is a direct `Capability -> definition` map. The
 * {@link AgentManifest.capabilityIndex} therefore maps every capability to the
 * (one-element) list of capabilities that satisfy it — trivial today, but the
 * indirection keeps the lookup shape stable if a future definition ever
 * advertises more than one capability.
 *
 * Models are stored as aliases ("opus"/"sonnet"/"haiku") rather than concrete
 * ids; the runtime/provider bridge resolves an alias to a real model at spawn
 * time, so the manifest never goes stale when model names change.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { ConfigError, NotFoundError } from "../errors.ts";
import type { AgentDefinition, AgentManifest, Capability } from "../types.ts";

/** Manifest schema version. Bump when the on-disk shape changes incompatibly. */
export const MANIFEST_VERSION = "1";

/**
 * Read-only tool set: inspect the repo without mutating it. Used by scout and
 * reviewer, whose contract is "look, report, never change files".
 */
const READ_ONLY_TOOLS: readonly string[] = ["Read", "Glob", "Grep", "Bash"];

/**
 * Full write-capable tool set for roles that author code or resolve conflicts.
 * Includes the read-only tools plus Edit/Write so a worker can both understand
 * and modify the tree.
 */
const FULL_TOOLS: readonly string[] = ["Read", "Glob", "Grep", "Edit", "Write", "Bash"];

/**
 * Build the default manifest shipped with a freshly initialized project.
 *
 * Ten capabilities are defined: the six orchestration-core roles plus the four
 * delivery-pipeline roles (`architect`/`devops`/`deployer`/`verifier`). Only
 * `lead` and `coordinator` may spawn children — every other role, including all
 * four pipeline roles, is a leaf, which is what bounds delegation depth. A fresh
 * array/object is allocated on each call so callers can mutate the result (e.g.
 * before {@link writeManifest}) without aliasing module state.
 */
export function buildDefaultManifest(): AgentManifest {
	// One definition per capability. Constraints are injected verbatim into the
	// overlay, so they are phrased as direct instructions to the agent.
	const definitions: Partial<Record<Capability, AgentDefinition>> = {
		scout: {
			file: "scout.md",
			// Sonnet: exploration needs solid reasoning but not the priciest tier.
			model: "sonnet",
			tools: [...READ_ONLY_TOOLS],
			capabilities: ["scout"],
			canSpawn: false,
			constraints: [
				"Read-only: never edit, write, or delete files.",
				"Produce a findings report; do not attempt to implement changes.",
				"Stay within the assigned task scope; do not explore unrelated areas.",
			],
		},
		builder: {
			file: "builder.md",
			// Sonnet: the implementation workhorse — capable and cost-effective.
			model: "sonnet",
			tools: [...FULL_TOOLS],
			capabilities: ["builder"],
			canSpawn: false,
			constraints: [
				"Modify only files within your assigned FILE_SCOPE.",
				"Run the project's quality gates before reporting done.",
				"Do not spawn other agents; you are a leaf worker.",
			],
		},
		reviewer: {
			file: "reviewer.md",
			// Haiku: review is high-volume pattern-matching; the cheap tier suffices.
			model: "haiku",
			tools: [...READ_ONLY_TOOLS],
			capabilities: ["reviewer"],
			canSpawn: false,
			constraints: [
				"Read-only: never edit, write, or delete files.",
				"Report findings as pass/fail with specific, actionable feedback.",
				"Do not implement fixes; flag issues for the builder to address.",
			],
		},
		lead: {
			file: "lead.md",
			// Opus: a lead plans and decomposes work, which rewards stronger reasoning.
			model: "opus",
			tools: [...FULL_TOOLS],
			capabilities: ["lead"],
			canSpawn: true,
			constraints: [
				"Decompose the task and delegate to scout/builder/reviewer workers.",
				"Respect the configured maxAgentsPerLead and maxDepth limits.",
				"Aggregate worker results before reporting completion upward.",
			],
		},
		merger: {
			file: "merger.md",
			// Opus: conflict resolution is delicate and benefits from the top tier.
			model: "opus",
			tools: [...FULL_TOOLS],
			capabilities: ["merger"],
			canSpawn: false,
			constraints: [
				"Resolve conflicts by preserving the intent of every contributing branch.",
				"Run quality gates after merging; never report a merge that breaks them.",
				"Do not spawn other agents; you are a leaf worker.",
			],
		},
		coordinator: {
			file: "coordinator.md",
			// Opus: the top of the tree owns the whole plan and orchestration loop.
			model: "opus",
			tools: [...FULL_TOOLS],
			capabilities: ["coordinator"],
			canSpawn: true,
			constraints: [
				"Spawn leads (and workers) to drive the project to completion.",
				"Coordinate via the mail bus; track progress and unblock stalled agents.",
				"Respect the configured maxConcurrent and maxDepth limits.",
			],
		},
		architect: {
			file: "architect.md",
			// Opus: deployment planning is high-stakes recon that rewards top-tier reasoning.
			model: "opus",
			tools: [...READ_ONLY_TOOLS],
			capabilities: ["architect"],
			canSpawn: false,
			constraints: [
				"Read-only: never edit, write, or delete files; this is reconnaissance.",
				"Emit a deploy-plan describing target, environments, gates, and required infra.",
				"Do not spawn other agents; you are a leaf worker.",
			],
		},
		devops: {
			file: "devops.md",
			// Sonnet: authoring infra config is solid mechanical work, not top-tier reasoning.
			model: "sonnet",
			tools: [...FULL_TOOLS],
			capabilities: ["devops"],
			canSpawn: false,
			constraints: [
				"Author only infrastructure files (CI/CD, manifests, Dockerfiles); touch nothing else.",
				"Never apply or push changes to any environment; you author config only.",
				"Never inline secrets; reference them by env-var binding instead.",
				"Do not spawn other agents; you are a leaf worker.",
			],
		},
		deployer: {
			file: "deployer.md",
			// Opus: executing a deploy is delicate and irreversible — use the top tier.
			model: "opus",
			tools: [...FULL_TOOLS],
			capabilities: ["deployer"],
			canSpawn: false,
			constraints: [
				"Deploy only when the environment's gate is satisfied; otherwise wait or escalate.",
				"Never log, echo, or persist secrets; reference them by binding only.",
				"Do not spawn other agents; you are a leaf worker.",
			],
		},
		verifier: {
			file: "verifier.md",
			// Sonnet: probing a live deployment needs reliable reasoning at moderate cost.
			model: "sonnet",
			tools: [...READ_ONLY_TOOLS],
			capabilities: ["verifier"],
			canSpawn: false,
			constraints: [
				"Read-only: never edit, write, or delete files.",
				"Actually probe the deployment (health checks, endpoints); never report a false green.",
				"Report pass/fail with the concrete evidence that backs the verdict.",
				"Do not spawn other agents; you are a leaf worker.",
			],
		},
	};

	// Each capability is provided by exactly the definition keyed under it, so the
	// index maps every capability to a single-element list containing itself.
	const capabilityIndex: Partial<Record<Capability, Capability[]>> = {};
	const agents: Partial<Record<Capability, AgentDefinition>> = {};
	for (const [cap, def] of Object.entries(definitions) as [Capability, AgentDefinition][]) {
		agents[cap] = def;
		for (const provided of def.capabilities) {
			const existing = capabilityIndex[provided];
			if (existing) {
				existing.push(cap);
			} else {
				capabilityIndex[provided] = [cap];
			}
		}
	}

	return { version: MANIFEST_VERSION, agents, capabilityIndex };
}

/**
 * Write a manifest to `path` as pretty-printed JSON (2-space indent, trailing
 * newline) so the file is diff-friendly and matches editor-on-save formatting.
 *
 * Uses a synchronous write (matching `setSecret` in secrets.ts) so the file is
 * on disk before this function returns — a synchronous {@link loadManifest}
 * immediately afterward is guaranteed to see it, with no Promise to await.
 */
export function writeManifest(path: string, manifest: AgentManifest): void {
	writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
}

/**
 * Load and parse a manifest from disk.
 *
 * Validates only the top-level shape (a non-empty `version` plus `agents` and
 * `capabilityIndex` objects). Deep per-field validation of each definition is
 * intentionally omitted: Agentplate keeps load lean and trusts {@link writeManifest}
 * to emit well-formed files; a stricter validator, if ever needed, belongs here.
 *
 * @throws {NotFoundError} if no file exists at `path`.
 * @throws {ConfigError} if the file is unreadable, not valid JSON, or not a
 *   well-formed manifest object.
 */
export function loadManifest(path: string): AgentManifest {
	// Distinguish "missing" (a NotFoundError the caller can handle by writing a
	// default) from "present but broken" (a ConfigError the caller must surface).
	if (!existsSync(path)) {
		throw new NotFoundError(`Agent manifest not found: ${path}`);
	}

	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch (error) {
		throw new ConfigError(`Failed to read agent manifest ${path}: ${(error as Error).message}`);
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (error) {
		throw new ConfigError(`Invalid JSON in agent manifest ${path}: ${(error as Error).message}`);
	}

	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new ConfigError(`Agent manifest ${path} must be a JSON object`);
	}

	const obj = parsed as Record<string, unknown>;
	if (typeof obj.version !== "string" || obj.version.length === 0) {
		throw new ConfigError(`Agent manifest ${path} is missing a non-empty "version"`);
	}
	if (obj.agents === null || typeof obj.agents !== "object" || Array.isArray(obj.agents)) {
		throw new ConfigError(`Agent manifest ${path} is missing an "agents" object`);
	}
	if (
		obj.capabilityIndex === null ||
		typeof obj.capabilityIndex !== "object" ||
		Array.isArray(obj.capabilityIndex)
	) {
		throw new ConfigError(`Agent manifest ${path} is missing a "capabilityIndex" object`);
	}

	return parsed as AgentManifest;
}

/**
 * Look up the definition for a capability.
 *
 * @throws {NotFoundError} if the manifest has no definition for `capability`.
 */
export function getDefinition(manifest: AgentManifest, capability: Capability): AgentDefinition {
	const def = manifest.agents[capability];
	if (!def) {
		throw new NotFoundError(`No agent definition for capability "${capability}" in manifest`);
	}
	return def;
}
