/**
 * Assemble a persistent agent's interactive system prompt.
 *
 * For attended sessions (e.g. `coordinator start`) we don't write a worktree
 * overlay — the agent runs at the project root and is primed via the runtime's
 * `--append-system-prompt`. This combines the reusable base definition
 * (`agents/<capability>.md`) with a short run-context header so the live agent
 * knows the project, its run id, and the exact CLI verbs to use.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { agentStateDir, packageAgentDefPath } from "../paths.ts";
import type { Capability } from "../types.ts";

export interface CoordinatorPromptContext {
	projectName: string;
	runId: string;
	agentName: string;
	canonicalBranch: string;
	/**
	 * The runtime's overlay instruction file (e.g. `.claude/CLAUDE.md`,
	 * `AGENTS.md`, `GEMINI.md`) so the prompt is provider-agnostic instead of
	 * hardcoding a Claude path.
	 */
	instructionPath: string;
}

/** Read a bundled base agent definition (empty string if missing). */
function readBaseDefinition(capability: Capability): string {
	const path = packageAgentDefPath(`${capability}.md`);
	return existsSync(path) ? readFileSync(path, "utf8") : "";
}

/** Build the coordinator's interactive system prompt text. */
export function buildCoordinatorSystemPrompt(ctx: CoordinatorPromptContext): string {
	const header = [
		"# Run context",
		"",
		`You are **${ctx.agentName}**, the COORDINATOR for the Agentplate project ` +
			`**${ctx.projectName}**.`,
		`Active run: \`${ctx.runId}\` · canonical branch: \`${ctx.canonicalBranch}\`.`,
		"",
		"You run as an interactive session: the operator chats with you here. Your ONLY",
		"job is to HIRE and COORDINATE a team of agents. You are a dispatcher, not an",
		"implementer.",
		"",
		"## Hard rules (always apply, every provider)",
		"",
		"1. **Never edit, write, or create files yourself, and never run the build/tests",
		"   to 'just fix it'.** You have no implementation role — every change is made by",
		"   an agent you dispatch. If you catch yourself about to edit a file, sling an",
		"   agent instead.",
		"2. **Always fan out into multiple agents.** Decompose the goal into INDEPENDENT,",
		"   parallel slices and dispatch one lead per slice. For anything beyond a single",
		"   trivial change, dispatch **at least TWO leads** so work proceeds in parallel.",
		"3. **Spawn ONLY with `agentplate sling`** (run it through your shell/Bash tool).",
		"   Do NOT use any built-in sub-agent / Task / Workflow tool — agents created that",
		"   way bypass Agentplate's session store, mail bus, and merge queue, so they",
		"   never appear in `ap serve`/`ap tui` and their work is not tracked or merged.",
		"",
		"Key commands:",
		"",
		`- Check mail: \`agentplate mail check --agent ${ctx.agentName}\``,
		`- Dispatch a lead: \`agentplate sling <task-id> --capability lead --parent ${ctx.agentName} --spec .agentplate/specs/<task-id>.md\``,
		"- Fleet status: `agentplate status`",
		"- Merge completed work: `agentplate merge --all`",
		"",
		`Your per-run goal and constraints live in your overlay instruction file ` +
			`(\`${ctx.instructionPath}\`) and the task tracker — read them first.`,
		"",
		"Begin by greeting the operator and asking what to build, then DECOMPOSE the goal",
		"into parallel slices and dispatch a lead for each. The reusable role definition",
		"follows.",
		"",
		"---",
		"",
	].join("\n");
	return `${header}${readBaseDefinition("coordinator")}`;
}

/**
 * Write the assembled system prompt to the agent's state dir and return its path.
 * (Persisted so it can be inspected; the runtime receives the text, not the path.)
 */
export function writeCoordinatorSystemPrompt(
	root: string,
	ctx: CoordinatorPromptContext,
): { path: string; text: string } {
	const text = buildCoordinatorSystemPrompt(ctx);
	const path = `${agentStateDir(root, ctx.agentName)}/system-prompt.md`;
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, text, "utf8");
	return { path, text };
}
