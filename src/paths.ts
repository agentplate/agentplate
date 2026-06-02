/**
 * Canonical filesystem paths for Agentplate state, derived from a project root.
 * Centralized so every command/store agrees on where things live.
 */

import { join } from "node:path";
import { AGENTPLATE_DIR } from "./config.ts";

export const sessionsDbPath = (root: string): string => join(root, AGENTPLATE_DIR, "sessions.db");
export const eventsDbPath = (root: string): string => join(root, AGENTPLATE_DIR, "events.db");
export const mailDbPath = (root: string): string => join(root, AGENTPLATE_DIR, "mail.db");
export const mergeDbPath = (root: string): string => join(root, AGENTPLATE_DIR, "merge-queue.db");
export const deploysDbPath = (root: string): string => join(root, AGENTPLATE_DIR, "deploys.db");
export const manifestFilePath = (root: string): string =>
	join(root, AGENTPLATE_DIR, "agent-manifest.json");
export const currentRunPath = (root: string): string =>
	join(root, AGENTPLATE_DIR, "current-run.txt");
export const worktreesDir = (root: string): string => join(root, AGENTPLATE_DIR, "worktrees");
export const agentDefsDir = (root: string): string => join(root, AGENTPLATE_DIR, "agent-defs");
export const skillsDir = (root: string): string => join(root, AGENTPLATE_DIR, "skills");
export const agentStateDir = (root: string, agentName: string): string =>
	join(root, AGENTPLATE_DIR, "agents", agentName);
export const appliedSkillsPath = (root: string, agentName: string): string =>
	join(agentStateDir(root, agentName), "applied-skills.json");
export const specPath = (root: string, taskId: string): string =>
	join(root, AGENTPLATE_DIR, "specs", `${taskId}.md`);

/**
 * Path to a bundled base agent definition shipped with the package
 * (`<package>/agents/<file>`). Resolved relative to this module (src/paths.ts).
 */
export const packageAgentDefPath = (file: string): string =>
	join(import.meta.dir, "..", "agents", file);

/** The package root (one level above src/). Used to locate bundled ui/dist. */
export const packageRootDir = (): string => join(import.meta.dir, "..");
