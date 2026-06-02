/**
 * Dynamic overlay generator.
 *
 * Every spawned agent gets two instruction layers: a reusable base `.md`
 * definition (the HOW) and a per-task overlay (the WHAT). This module renders the
 * overlay by substituting `{{PLACEHOLDER}}` tokens in
 * `templates/overlay.md.tmpl` with values from an {@link OverlayConfig}, then
 * writes the result into the agent's worktree at the runtime's instruction path.
 *
 * Design notes:
 * - Rendering is pure and synchronous: read template, substitute, return string.
 *   This keeps `generateOverlay` trivial to unit-test and free of side effects.
 * - List-shaped fields (file scope, constraints, quality gates, siblings) are
 *   rendered as readable markdown so the agent reads prose, not raw arrays. Empty
 *   lists collapse to a clear "(none)" sentinel rather than a blank section.
 * - `writeOverlay` refuses any target that is not under `/.agentplate/worktrees/`.
 *   Writing an overlay to a real project root would clobber the operator's own
 *   instruction file (e.g. `.claude/CLAUDE.md`); the guard makes that impossible
 *   regardless of caller mistakes.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ValidationError } from "../errors.ts";
import type { OverlayConfig, QualityGate } from "../types.ts";

/** Path segment that marks a directory as a Agentplate-managed worktree. */
const WORKTREE_MARKER = "/.agentplate/worktrees/";

/** Sentinel rendered for any list-shaped field that is empty. */
const NONE = "(none)";

/**
 * Resolve the overlay template path relative to THIS module.
 *
 * `import.meta.dir` is `<repo>/src/agents`; the template lives at
 * `<repo>/templates/overlay.md.tmpl`, i.e. two levels up. Resolving relative to
 * the module (rather than `process.cwd()`) keeps rendering correct no matter
 * where `agentplate` is invoked from.
 */
function templatePath(): string {
	return join(import.meta.dir, "..", "..", "templates", "overlay.md.tmpl");
}

/**
 * Render a list of strings as a markdown bullet list, or the `(none)` sentinel
 * when the list is empty. Each entry is wrapped in backticks because these are
 * always machine-ish tokens (file paths / agent names).
 */
function renderBullets(items: readonly string[]): string {
	if (items.length === 0) return NONE;
	return items.map((item) => `- \`${item}\``).join("\n");
}

/**
 * Render sibling agent names as a bullet list with rebase guidance, or `(none)`.
 *
 * Parallel siblings branch off the same pre-merge base, so whoever merges second
 * carries a stale base unless they rebase first. We surface that here so the
 * agent rebases BEFORE signalling it is ready to merge.
 */
function renderSiblings(siblings: readonly string[] | undefined): string {
	if (!siblings || siblings.length === 0) return NONE;
	const bullets = siblings.map((name) => `- ${name}`).join("\n");
	return [
		"The following sibling agents are working in parallel and may touch nearby code:",
		"",
		bullets,
		"",
		"Rebase your branch onto the latest canonical branch and re-run the quality",
		"gates BEFORE you send your terminal mail — a sibling's work may have landed",
		"while you were busy, and merging from a stale base can revert it.",
	].join("\n");
}

/**
 * Render the quality gates as a numbered checklist, or `(none)` when no gates are
 * configured. Each gate shows its name, the exact command to run, and (when
 * present) its description.
 */
function renderQualityGates(gates: readonly QualityGate[]): string {
	if (gates.length === 0) return NONE;
	return gates
		.map((gate, i) => {
			const suffix = gate.description ? ` — ${gate.description}` : "";
			return `${i + 1}. **${gate.name}:** \`${gate.command}\`${suffix}`;
		})
		.join("\n");
}

/**
 * Render the can-spawn section. Spawners get a concrete `agentplate sling` example
 * (with the depth pre-incremented); leaf agents get an explicit prohibition so
 * there is no ambiguity.
 */
function renderCanSpawn(config: OverlayConfig): string {
	if (!config.canSpawn) {
		return "You may NOT spawn sub-workers. You are a leaf agent.";
	}
	return [
		"You may spawn sub-workers with `agentplate sling`. Example:",
		"",
		"```bash",
		"agentplate sling <task-id> --capability builder --name <worker-name> \\",
		`  --parent ${config.agentName} --depth ${config.depth + 1}`,
		"```",
	].join("\n");
}

/**
 * Render the spec line shown in the assignment header: the path when one was
 * provided, otherwise an explicit `(none)` so the agent knows to ask for detail.
 */
function renderSpecPath(specPath: string | undefined): string {
	return specPath && specPath.length > 0 ? specPath : NONE;
}

/**
 * Generate a per-task overlay by substituting every `{{PLACEHOLDER}}` token in
 * the template.
 *
 * @param config - The overlay inputs (the WHAT) for this agent/task.
 * @returns The fully rendered overlay markdown.
 */
export function generateOverlay(config: OverlayConfig): string {
	const template = readTemplate();

	// Map of placeholder -> replacement. Every `{{TOKEN}}` in the template MUST
	// have an entry here; the loop below replaces all occurrences of each.
	const replacements: Record<string, string> = {
		AGENT_NAME: config.agentName,
		CAPABILITY: config.capability,
		TASK_ID: config.taskId,
		BRANCH_NAME: config.branchName,
		WORKTREE_PATH: config.worktreePath,
		PARENT_AGENT: config.parentAgent ?? "coordinator",
		DEPTH: String(config.depth),
		FILE_SCOPE: renderBullets(config.fileScope),
		SPEC_PATH: renderSpecPath(config.specPath),
		CAN_SPAWN: renderCanSpawn(config),
		QUALITY_GATES: renderQualityGates(config.qualityGates),
		CONSTRAINTS: renderBullets(config.constraints),
		SIBLINGS: renderSiblings(config.siblings),
		// The skills block is self-contained (it carries its own "## Applicable
		// Skills" heading). When no skills were retrieved, render that heading with
		// a friendly placeholder so the section is always present and consistent.
		SKILLS: config.skillsOverlay ?? "## Applicable Skills\n\n(none yet)",
		BASE_DEFINITION: config.baseDefinition,
	};

	let result = template;
	for (const [token, value] of Object.entries(replacements)) {
		// Replace ALL occurrences — some tokens (e.g. AGENT_NAME, WORKTREE_PATH)
		// appear more than once. A global string split/join avoids regex-escaping
		// the value (replacement text may contain `$` from commands/paths).
		result = result.split(`{{${token}}}`).join(value);
	}

	return result;
}

/**
 * Generate the overlay and write it into the agent's worktree at
 * `<worktreePath>/<instructionPath>`, creating parent directories as needed.
 *
 * Guard: refuses any `worktreePath` that is not a Agentplate worktree (does not
 * contain `/.agentplate/worktrees/`). This prevents the overlay from ever
 * overwriting an instruction file at a real project root.
 *
 * @param config - The overlay inputs for this agent/task.
 * @param instructionPath - Relative path within the worktree to write to
 *   (e.g. the runtime's `.claude/CLAUDE.md`).
 * @returns The absolute path of the file that was written.
 * @throws {ValidationError} If `worktreePath` is not under `/.agentplate/worktrees/`.
 */
export function writeOverlay(config: OverlayConfig, instructionPath: string): string {
	// Normalize separators so the marker check works on any platform's paths.
	const normalizedWorktree = config.worktreePath.replaceAll("\\", "/");
	if (!normalizedWorktree.includes(WORKTREE_MARKER)) {
		throw new ValidationError(
			`Refusing to write overlay outside a Agentplate worktree: "${config.worktreePath}" ` +
				`does not contain "${WORKTREE_MARKER}". Overlays must target an agent worktree, ` +
				"never a real project root (it would overwrite the operator's instruction file).",
		);
	}

	const content = generateOverlay(config);
	const outputPath = join(config.worktreePath, instructionPath);
	// writeFileSync does not create intermediate directories, so make them first.
	// Synchronous I/O keeps writeOverlay's contract simple (returns the path, no
	// Promise) and matches the rest of Agentplate's file handling (config, secrets).
	mkdirSync(dirname(outputPath), { recursive: true });
	writeFileSync(outputPath, content);
	return outputPath;
}

/**
 * Read the overlay template from disk synchronously.
 *
 * Separated from {@link generateOverlay} so the (rare) missing-template failure
 * surfaces as a typed {@link ValidationError} with the resolved path, which is
 * far easier to diagnose than a raw ENOENT. A synchronous `readFileSync` keeps
 * the whole generator synchronous; the template is a small committed asset that
 * always exists in a real install.
 */
function readTemplate(): string {
	const path = templatePath();
	if (!existsSync(path)) {
		throw new ValidationError(`Overlay template not found: ${path}`);
	}
	return readFileSync(path, "utf8");
}
