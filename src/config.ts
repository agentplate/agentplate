/**
 * Configuration loading, defaults, and validation.
 *
 * Resolution order (later overrides earlier):
 *   DEFAULT_CONFIG  ←  .agentplate/config.yaml  ←  .agentplate/config.local.yaml
 *
 * `config.local.yaml` is gitignored and holds machine-specific overrides.
 * Secrets never live in any of these files — only the *names* of env vars that
 * hold them (see {@link ProviderConfig.authTokenEnv}).
 */

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import yaml from "js-yaml";
import { ConfigError } from "./errors.ts";
import type { AgentplateConfig } from "./types.ts";

/** Directory (relative to project root) holding all Agentplate state. */
export const AGENTPLATE_DIR = ".agentplate";
/** Primary committed config file. */
export const CONFIG_FILE = "config.yaml";
/** Gitignored machine-specific overrides. */
export const CONFIG_LOCAL_FILE = "config.local.yaml";

/** Built-in defaults applied beneath any on-disk config. */
export const DEFAULT_CONFIG: AgentplateConfig = {
	project: {
		name: "",
		root: "",
		canonicalBranch: "main",
	},
	runtime: {
		default: "claude",
	},
	activeProvider: "anthropic",
	providers: {
		anthropic: { type: "native", authTokenEnv: "ANTHROPIC_API_KEY" },
	},
	agents: {
		manifestPath: ".agentplate/agent-manifest.json",
		baseDir: ".agentplate/agent-defs",
		maxConcurrent: 10,
		maxDepth: 2,
		maxAgentsPerLead: 5,
		idleTimeoutMinutes: 10,
	},
	merge: {
		aiResolveEnabled: true,
	},
	skills: {
		enabled: true,
		retrieval: {
			budgetChars: 6000,
			maxFull: 4,
		},
		distill: {
			onlyOnGatesPass: true,
			model: null,
		},
		prune: {
			quarantineBelow: 0.25,
			minSamples: 4,
			maxAgeDays: 30,
		},
	},
	deploy: {
		default: "",
		targets: {},
		gates: {
			production: "confirm",
			staging: "auto",
			preview: "auto",
		},
	},
	logging: {
		verbose: false,
		redactSecrets: true,
	},
};

let projectRootOverride: string | null = null;

/** Override project-root auto-detection (used by `--project` and tests). */
export function setProjectRootOverride(root: string | null): void {
	projectRootOverride = root === null ? null : resolve(root);
}

/**
 * Find the project root by walking up from `start` looking for a `.agentplate/`
 * directory. Falls back to the override or the current working directory.
 */
export function findProjectRoot(start: string = process.cwd()): string {
	if (projectRootOverride) return projectRootOverride;
	let dir = resolve(start);
	while (true) {
		if (existsSync(join(dir, AGENTPLATE_DIR))) return dir;
		const parent = resolve(dir, "..");
		if (parent === dir) break;
		dir = parent;
	}
	return resolve(start);
}

/** Has Agentplate been initialized at `root`? */
export function isInitialized(root: string): boolean {
	return existsSync(join(root, AGENTPLATE_DIR, CONFIG_FILE));
}

/** Deep-merge plain objects from `source` into a clone of `base`. */
function deepMerge<T>(base: T, source: unknown): T {
	if (source === null || source === undefined) return base;
	if (typeof base !== "object" || base === null || Array.isArray(base)) {
		return source as T;
	}
	if (typeof source !== "object" || Array.isArray(source)) {
		return source as T;
	}
	const result: Record<string, unknown> = { ...(base as Record<string, unknown>) };
	for (const [key, value] of Object.entries(source as Record<string, unknown>)) {
		const baseValue = (base as Record<string, unknown>)[key];
		result[key] = deepMerge(baseValue, value);
	}
	return result as T;
}

/** Parse a YAML file into a plain object, or return `{}` if it is absent. */
function readYamlIfExists(path: string): Record<string, unknown> {
	if (!existsSync(path)) return {};
	let raw: string;
	try {
		raw = readFileSync(path, "utf8");
	} catch (error) {
		throw new ConfigError(`Failed to read ${path}: ${(error as Error).message}`);
	}
	let parsed: unknown;
	try {
		parsed = yaml.load(raw);
	} catch (error) {
		throw new ConfigError(`Invalid YAML in ${path}: ${(error as Error).message}`);
	}
	if (parsed === null || parsed === undefined) return {};
	if (typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new ConfigError(`Expected a mapping at the top of ${path}`);
	}
	return parsed as Record<string, unknown>;
}

/**
 * Validate a fully-merged config. Throws {@link ConfigError} on the first
 * problem found. Kept intentionally small in Phase 0; extended per phase.
 */
export function validateConfig(config: AgentplateConfig): void {
	if (!config.project || typeof config.project.canonicalBranch !== "string") {
		throw new ConfigError("config.project.canonicalBranch must be a string");
	}
	if (!config.runtime || typeof config.runtime.default !== "string") {
		throw new ConfigError("config.runtime.default must be a string");
	}
	if (typeof config.activeProvider !== "string" || config.activeProvider === "") {
		throw new ConfigError("config.activeProvider must be a non-empty string");
	}
	if (!config.providers[config.activeProvider]) {
		throw new ConfigError(
			`config.activeProvider "${config.activeProvider}" is not present in config.providers`,
		);
	}
	if (config.agents.maxDepth < 0) {
		throw new ConfigError("config.agents.maxDepth must be >= 0");
	}
	if (config.agents.maxConcurrent < 1) {
		throw new ConfigError("config.agents.maxConcurrent must be >= 1");
	}
	if (config.agents.idleTimeoutMinutes < 0) {
		throw new ConfigError(
			"config.agents.idleTimeoutMinutes must be >= 0 (0 disables idle reaping)",
		);
	}
}

/**
 * Load and validate the Agentplate config for the given project root (auto-detected
 * if omitted). Merges defaults ← config.yaml ← config.local.yaml and stamps the
 * resolved `project.root`.
 */
export function loadConfig(root?: string): AgentplateConfig {
	const projectRoot = root ? resolve(root) : findProjectRoot();
	const dir = join(projectRoot, AGENTPLATE_DIR);
	const base = readYamlIfExists(join(dir, CONFIG_FILE));
	const local = readYamlIfExists(join(dir, CONFIG_LOCAL_FILE));

	let merged = deepMerge(DEFAULT_CONFIG, base);
	merged = deepMerge(merged, local);
	merged.project.root = projectRoot;

	validateConfig(merged);
	return merged;
}

/** Serialize a config object to YAML for writing to `config.yaml`. */
export function serializeConfig(config: AgentplateConfig): string {
	return yaml.dump(config, { indent: 2, lineWidth: 100, sortKeys: false });
}
