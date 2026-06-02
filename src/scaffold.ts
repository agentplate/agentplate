/**
 * Project scaffolding — create the `.agentplate/` directory structure and write the
 * initial config. Shared by `agentplate init` (non-interactive) and `agentplate setup`
 * (interactive).
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AGENTPLATE_DIR, CONFIG_FILE, serializeConfig } from "./config.ts";
import type { AgentplateConfig } from "./types.ts";

/** Subdirectories created under `.agentplate/`. */
const SUBDIRS = ["agents", "agent-defs", "worktrees", "specs", "logs", "skills"] as const;

/** The `.agentplate/.gitignore` that keeps runtime state and secrets out of git. */
const AGENTPLATE_GITIGNORE = `# Agentplate runtime state — do not commit.
worktrees/
logs/
*.db
*.db-shm
*.db-wal
config.local.yaml
secrets.local.yaml
agents/*/checkpoint.json
`;

const AGENTPLATE_README = `# .agentplate/

This directory holds Agentplate's per-project state: configuration, agent
definitions, git worktrees for agent workers, task specs, logs, distilled
skills, and SQLite databases (mail, sessions, events, skills, deploys).

Committed: \`config.yaml\`, \`agent-manifest.json\`, \`agent-defs/\`.
Gitignored (see \`.gitignore\` here): \`config.local.yaml\`, \`secrets.local.yaml\`,
\`worktrees/\`, \`logs/\`, and all \`*.db\` files.

Managed by the \`agentplate\` CLI — you generally don't edit these by hand.
`;

/** Create the `.agentplate/` directory tree (idempotent). */
export function ensureAgentplateDirs(root: string): void {
	const base = join(root, AGENTPLATE_DIR);
	mkdirSync(base, { recursive: true });
	for (const sub of SUBDIRS) {
		mkdirSync(join(base, sub), { recursive: true });
	}
}

/** Write `.agentplate/config.yaml`. */
export function writeConfig(root: string, config: AgentplateConfig): void {
	writeFileSync(join(root, AGENTPLATE_DIR, CONFIG_FILE), serializeConfig(config), "utf8");
}

/**
 * Scaffold `.agentplate/` and write the config + supporting files. Idempotent: safe
 * to run on an already-initialized project (it overwrites config.yaml with the
 * provided config and (re)writes the .gitignore/README).
 */
export function scaffoldAgentplateDir(root: string, config: AgentplateConfig): void {
	ensureAgentplateDirs(root);
	writeConfig(root, config);
	const base = join(root, AGENTPLATE_DIR);
	writeFileSync(join(base, ".gitignore"), AGENTPLATE_GITIGNORE, "utf8");
	const readmePath = join(base, "README.md");
	if (!existsSync(readmePath)) {
		writeFileSync(readmePath, AGENTPLATE_README, "utf8");
	}
}
