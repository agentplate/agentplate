/**
 * AI skill distiller.
 *
 * The distiller closes Agentplate's learning loop at session-end: it shows a model
 * the change a worker just made (the git diff), a cheap digest of which files
 * moved, the task spec, and the skills that were applied during the session, then
 * asks it to decide whether the work is worth crystallizing into a reusable
 * {@link Skill}. The model answers with one of three actions:
 *
 *  - **create** — this session discovered a repeatable playbook; mint a new skill.
 *  - **update** — an applied skill was extended/corrected; bump that skill.
 *  - **skip**   — trivial / one-off work that should NOT mint a skill (the common,
 *                 correct answer — skill spam is the failure mode we guard against).
 *
 * This module is the orchestration glue plus the two pure halves that bracket the
 * model call:
 *
 *  - {@link buildDistillerPrompt} renders the instruction text (pure).
 *  - {@link parseDistillerOutput} tolerantly extracts a {@link SkillDraft} from
 *    the model's stdout — code fences, surrounding prose, or a bare object all
 *    parse; anything malformed or actionless returns `null` (pure).
 *  - {@link distillSkill} wires them to the real world: gather the diff via git,
 *    run a one-shot model call through the runtime's `buildPrintCommand`, scrub
 *    the draft with {@link sanitizeSkillDraft}, and persist via the store.
 *
 * Every untrusted output path is fail-safe: a missing/garbage/`skip` draft, an
 * empty diff, or a fatal safety violation all resolve to `{ action: "skipped" }`
 * rather than minting a hazardous or noise skill.
 */

import type { AgentRuntime } from "../runtimes/types.ts";
import { resolveArgv } from "../utils/detect.ts";
import { sanitizeSkillDraft } from "./safety.ts";
import type { createSkillStore } from "./store.ts";
import type { Skill, SkillDraft, SkillProvenance } from "./types.ts";

/** The skill store handle produced by {@link createSkillStore}. */
type SkillStoreHandle = ReturnType<typeof createSkillStore>;

/** Context assembled for {@link buildDistillerPrompt}. */
export interface DistillerPromptContext {
	/** The full `git diff baseRef..HEAD` for the session's work. */
	diff: string;
	/** A short summary of which files changed and by how much (diff --stat style). */
	insightDigest: string;
	/** The task spec text, or "" when no spec was attached. */
	specText: string;
	/** The skills that were injected into the session (so the model can UPDATE one). */
	appliedSkills: Skill[];
}

/** Arguments for {@link distillSkill}. */
export interface DistillSkillArgs {
	/** Skill store rooted at the main project (NOT the throwaway worktree). */
	store: SkillStoreHandle;
	/** Runtime adapter providing the one-shot `buildPrintCommand`. */
	runtime: AgentRuntime;
	/** Main project root (for provenance / future use). */
	root: string;
	/** The agent's worktree (cwd for git + the model call). */
	worktreePath: string;
	/** Git ref the worktree branched from; the diff base. */
	baseRef: string;
	/** Task id this work belongs to, or null. */
	taskId: string | null;
	/** Name of the agent whose work is being distilled. */
	agentName: string;
	/** The agent's capability (builder / lead / …); carried for context. */
	capability: string;
	/** Slugs of skills that were applied during the session. */
	appliedSlugs: string[];
	/** Optional model override for the one-shot call. */
	model?: string;
}

/** Result of a distillation attempt. */
export interface DistillResult {
	action: "created" | "updated" | "skipped";
	/** The slug created/updated; absent when skipped. */
	slug?: string;
}

/** Max characters of diff embedded in the prompt — a huge diff is truncated. */
const MAX_DIFF_CHARS = 24_000;

// ---------------------------------------------------------------------------
// Prompt construction (pure)
// ---------------------------------------------------------------------------

/**
 * Render one applied skill as a compact reference block the model can target for
 * an UPDATE. Only the identifying/decision-relevant fields are included (slug,
 * title, goal, when-to-use) — the full body is omitted to keep the prompt lean.
 */
function renderAppliedSkill(skill: Skill): string {
	const when = skill.whenToUse.length > 0 ? skill.whenToUse.join("; ") : "(none)";
	return [
		`- slug: ${skill.slug}`,
		`  title: ${skill.title}`,
		`  goal: ${skill.goal}`,
		`  whenToUse: ${when}`,
	].join("\n");
}

/**
 * Build the distiller instruction prompt.
 *
 * The prompt frames the decision (create / update / skip), hammers on "skip is
 * usually correct" to prevent skill spam, pins the STRICT JSON output contract
 * (a single object, no prose, no code fence), and specifies the markdown body
 * structure (`## Steps` / `## Gotchas` / `## Verification`). The diff is embedded
 * last (after the instructions) and truncated to {@link MAX_DIFF_CHARS} so an
 * enormous changeset cannot blow the context.
 */
export function buildDistillerPrompt(ctx: DistillerPromptContext): string {
	const diff =
		ctx.diff.length > MAX_DIFF_CHARS
			? `${ctx.diff.slice(0, MAX_DIFF_CHARS)}\n…[diff truncated]…`
			: ctx.diff;

	const appliedBlock =
		ctx.appliedSkills.length > 0
			? ctx.appliedSkills.map(renderAppliedSkill).join("\n")
			: "(no skills were applied this session)";

	const specBlock = ctx.specText.trim() !== "" ? ctx.specText.trim() : "(no spec provided)";

	return `You are Agentplate's skill distiller. A worker agent just finished a task. Your job
is to decide whether this work is worth crystallizing into a REUSABLE skill — a
playbook a future agent could follow to do similar work faster.

You have three possible actions:

  - "create": this session discovered a repeatable, generalizable technique that
    is NOT already captured by an applied skill. Mint a new skill.
  - "update": an applied skill was extended, corrected, or sharpened by this work.
    Improve that skill in place (set targetSlug to its slug).
  - "skip": the work was trivial, one-off, project-specific boilerplate, or a
    minor edit with no transferable lesson. Do NOT mint a skill.

IMPORTANT: "skip" is the RIGHT ANSWER for the large majority of sessions. A skill
must earn its place — only create or update when there is a genuinely reusable,
non-obvious lesson that would help a different agent on a different task. When in
doubt, skip. Minting low-value skills (skill spam) is worse than missing one.

A good skill body is concrete and actionable markdown with exactly these sections:

  ## Steps
  - Ordered, concrete steps. Include the actual commands to run (in \`bash\` code
    fences) — generalized, with no secrets and no machine-specific absolute paths.

  ## Gotchas
  - The non-obvious pitfalls, edge cases, and mistakes to avoid that this session
    revealed.

  ## Verification
  - How to confirm the work is correct (the concrete test/lint/build commands).

OUTPUT CONTRACT — read carefully:
Respond with STRICT JSON: a SINGLE JSON object and nothing else. No prose before
or after, no markdown code fence around the JSON. The object shape is:

{
  "action": "create" | "update" | "skip",
  "targetSlug": "<existing-slug>",          // REQUIRED only when action is "update"
  "title": "<short imperative skill title>", // required for create
  "goal": "<one sentence: what applying this skill accomplishes>",
  "whenToUse": ["<retrieval signal>", "..."],
  "filePatterns": ["src/**/*.ts", "..."],    // globs this skill is relevant to
  "tags": ["<tag>", "..."],
  "body": "## Steps\\n...\\n## Gotchas\\n...\\n## Verification\\n..."
}

For action "skip", a bare {"action":"skip"} is sufficient — omit the other fields.

--- TASK SPEC ---
${specBlock}

--- SKILLS APPLIED THIS SESSION (candidates for "update") ---
${appliedBlock}

--- CHANGE DIGEST ---
${ctx.insightDigest.trim() === "" ? "(no digest)" : ctx.insightDigest.trim()}

--- DIFF (baseRef..HEAD) ---
${diff.trim() === "" ? "(empty diff)" : diff}
`;
}

// ---------------------------------------------------------------------------
// Output parsing (pure, tolerant)
// ---------------------------------------------------------------------------

/** The three valid actions, as a runtime-checkable set. */
const VALID_ACTIONS = new Set(["create", "update", "skip"]);

/**
 * Scan `text` for the first *balanced* top-level JSON object and return its raw
 * substring (braces included), or null if none is found.
 *
 * Tolerant of code fences and surrounding prose: it simply walks characters,
 * tracking brace depth while respecting string literals (so a `}` inside a JSON
 * string does not prematurely close the object) and backslash escapes. The first
 * `{` at depth 0 starts the candidate; the matching `}` that returns depth to 0
 * ends it.
 */
export function extractFirstJsonObject(text: string): string | null {
	let start = -1;
	let depth = 0;
	let inString = false;
	let escaped = false;

	for (let i = 0; i < text.length; i++) {
		const ch = text[i];
		if (ch === undefined) continue;

		if (inString) {
			if (escaped) {
				escaped = false;
			} else if (ch === "\\") {
				escaped = true;
			} else if (ch === '"') {
				inString = false;
			}
			continue;
		}

		if (ch === '"') {
			inString = true;
			continue;
		}
		if (ch === "{") {
			if (depth === 0) start = i;
			depth++;
			continue;
		}
		if (ch === "}") {
			if (depth > 0) {
				depth--;
				if (depth === 0 && start !== -1) {
					return text.slice(start, i + 1);
				}
			}
		}
	}
	return null;
}

/** Coerce an unknown parsed value into a `string[]`, or undefined if not an array. */
function optStringArray(value: unknown): string[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const out: string[] = [];
	for (const item of value) {
		if (typeof item === "string") out.push(item);
	}
	return out;
}

/** Coerce an unknown parsed value into a non-empty string, or undefined. */
function optString(value: unknown): string | undefined {
	return typeof value === "string" && value !== "" ? value : undefined;
}

/**
 * Parse a distiller model's stdout into a {@link SkillDraft}, or null.
 *
 * Tolerant by design — the model may wrap its JSON in a ```json fence or sandwich
 * it in prose. We locate the first balanced JSON object ({@link
 * extractFirstJsonObject}), `JSON.parse` it, and validate:
 *   - the value is a plain object,
 *   - `action` is present and ∈ {create, update, skip}.
 * Returns null on any failure (no object found, parse error, missing/invalid
 * action). Optional fields are copied through only when well-typed, so a
 * malformed `whenToUse` etc. is dropped rather than corrupting the draft.
 */
export function parseDistillerOutput(stdout: string): SkillDraft | null {
	const candidate = extractFirstJsonObject(stdout);
	if (candidate === null) return null;

	let parsed: unknown;
	try {
		parsed = JSON.parse(candidate);
	} catch {
		return null;
	}
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;

	const obj = parsed as Record<string, unknown>;
	const action = obj.action;
	if (typeof action !== "string" || !VALID_ACTIONS.has(action)) return null;

	const draft: SkillDraft = { action: action as SkillDraft["action"] };

	const targetSlug = optString(obj.targetSlug);
	if (targetSlug !== undefined) draft.targetSlug = targetSlug;
	const title = optString(obj.title);
	if (title !== undefined) draft.title = title;
	const goal = optString(obj.goal);
	if (goal !== undefined) draft.goal = goal;
	const whenToUse = optStringArray(obj.whenToUse);
	if (whenToUse !== undefined) draft.whenToUse = whenToUse;
	const filePatterns = optStringArray(obj.filePatterns);
	if (filePatterns !== undefined) draft.filePatterns = filePatterns;
	const tags = optStringArray(obj.tags);
	if (tags !== undefined) draft.tags = tags;
	const body = optString(obj.body);
	if (body !== undefined) draft.body = body;

	return draft;
}

// ---------------------------------------------------------------------------
// Orchestration (impure)
// ---------------------------------------------------------------------------

/** Result of running a git subprocess: trimmed stdout + success flag. */
interface GitResult {
	stdout: string;
	ok: boolean;
}

/**
 * Run a git command in `cwd` and capture stdout. Never throws on a non-zero
 * exit (the distiller is best-effort — a git hiccup must degrade to a skip, not
 * crash session-end); the caller checks `ok` and treats failure as "no diff".
 */
async function runGit(cwd: string, args: string[]): Promise<GitResult> {
	const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
	const stdout = await new Response(proc.stdout).text();
	const exitCode = await proc.exited;
	return { stdout: stdout.trim(), ok: exitCode === 0 };
}

/** Read the spec markdown for a task id under `<root>/.agentplate/specs/`, or "". */
async function readSpecText(root: string, taskId: string | null): Promise<string> {
	if (taskId === null || taskId === "") return "";
	const specFile = `${root}/.agentplate/specs/${taskId}.md`;
	const file = Bun.file(specFile);
	if (!(await file.exists())) return "";
	try {
		return await file.text();
	} catch {
		return "";
	}
}

/**
 * Distill a worker's session into a skill (or skip).
 *
 * Flow (any failure short-circuits to a safe skip):
 *  1. Gather the session diff (`git diff baseRef..HEAD` in the worktree). An empty
 *     diff means there is nothing to learn from — skip.
 *  2. Build a cheap insight digest from `git diff --stat`, and read the task spec.
 *  3. Resolve the applied skills the store still knows about (dropping any that
 *     have since been removed) so the model can choose to UPDATE one.
 *  4. Render the prompt and make a single one-shot model call via the runtime's
 *     `buildPrintCommand`, capturing stdout.
 *  5. Parse the output. A null parse or an explicit `skip` action → skipped.
 *  6. Scrub the draft ({@link sanitizeSkillDraft}). A FATAL violation (dangerous
 *     command / deploy verb) downgrades the whole draft to a skip — we never
 *     persist a hazardous skill.
 *  7. Persist the redacted draft via `store.upsert` with provenance stamped from
 *     the task / agent / HEAD sha, and report the action + slug.
 */
export async function distillSkill(args: DistillSkillArgs): Promise<DistillResult> {
	const { store, runtime, root, worktreePath, baseRef, taskId, agentName, model } = args;

	// 1. Gather the diff. No diff → nothing to distill.
	const diffResult = await runGit(worktreePath, ["diff", `${baseRef}..HEAD`]);
	if (!diffResult.ok || diffResult.stdout === "") {
		return { action: "skipped" };
	}
	const diff = diffResult.stdout;

	// 2. Cheap digest from --stat (best-effort; empty string if it fails), + spec.
	const statResult = await runGit(worktreePath, ["diff", "--stat", `${baseRef}..HEAD`]);
	const insightDigest = statResult.ok ? statResult.stdout : "";
	const specText = await readSpecText(root, taskId);

	// 3. Resolve applied skills the store still has (skip any since removed).
	const appliedSkills: Skill[] = [];
	for (const slug of args.appliedSlugs) {
		const skill = store.get(slug);
		if (skill !== null) appliedSkills.push(skill);
	}

	// 4. Build the prompt and run a single one-shot model call.
	const prompt = buildDistillerPrompt({ diff, insightDigest, specText, appliedSkills });

	let stdout: string;
	try {
		const proc = Bun.spawn(resolveArgv(runtime.buildPrintCommand(prompt, model)), {
			cwd: worktreePath,
			stdout: "pipe",
			stderr: "pipe",
		});
		stdout = await new Response(proc.stdout).text();
		await proc.exited;
	} catch {
		// The model CLI failed to spawn/run — degrade to a skip rather than crash.
		return { action: "skipped" };
	}

	// 5. Parse. No usable object, or an explicit skip → skipped.
	const draft = parseDistillerOutput(stdout);
	if (draft === null || draft.action === "skip") {
		return { action: "skipped" };
	}

	// 6. Safety scrub. A fatal violation downgrades the draft to a skip.
	const report = sanitizeSkillDraft(draft);
	if (!report.ok) {
		return { action: "skipped" };
	}

	// 7. Persist via the store with provenance from this session.
	const head = await runGit(worktreePath, ["rev-parse", "HEAD"]);
	const provenance: SkillProvenance = {
		taskId,
		agent: agentName,
		commit: head.ok && head.stdout !== "" ? head.stdout : null,
	};

	const result = store.upsert(report.redactedDraft, provenance);
	return { action: result.action, slug: result.skill.slug };
}
