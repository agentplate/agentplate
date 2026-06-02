/**
 * Skill retrieval + overlay formatting.
 *
 * Given the *already-loaded* set of skills (the CLI / sling layer reads them via
 * the {@link import("./store.ts").SkillStore}), this module ranks them against a
 * spawn's context — the files an agent will own, the task text, and the
 * capability — then greedily packs the best ones into an overlay budget. The
 * highest-scoring skills are injected with their FULL body; the rest are listed
 * as one-line summaries that point at `agentplate skill show <slug>`.
 *
 * Everything here is PURE: it takes plain {@link Skill} objects and returns plain
 * data + a markdown string, so ranking/packing/formatting are trivially unit
 * testable with no filesystem, SQLite, or subprocess. The score is a fixed
 * weighted blend (file overlap dominates, then lexical task match, then earned
 * confidence, then recency), and `quarantined`/`deprecated` skills are excluded
 * outright (they score 0 and are dropped before packing).
 *
 * Scoring weights (sum to 1):
 *   0.45 · fileOverlap   — fraction of the skill's filePatterns that glob-match
 *                          any path in the spawn's file scope.
 *   0.30 · lexical       — Jaccard-ish overlap of the query terms (taskText +
 *                          capability) against the skill's text signals
 *                          (title + goal + whenToUse + tags).
 *   0.15 · confidence    — the skill's earned confidence (0..1, already a Wilson
 *                          lower bound computed by the store).
 *   0.10 · recencyDecay  — exponential decay on the age of `updatedAt`
 *                          (just-updated → 1, ~half-life of 30 days).
 */

import type { RankedSkill, Skill } from "./types.ts";

/** Inputs that describe the spawn we are retrieving skills for. */
export interface SelectOpts {
	/** Files the agent will own (drives the dominant file-overlap signal). */
	fileScope: string[];
	/** Free-text task description (the bulk of the lexical signal). */
	taskText: string;
	/** Capability of the spawn (folded into the lexical query). */
	capability: string;
	/** Max characters of full-body skills to inject (default 6000). */
	budgetChars?: number;
	/** Max number of full-body skills to inject (default 4). */
	maxFull?: number;
}

/** The packing outcome: which skills go in full, which as summaries, + the block. */
export interface SelectResult {
	/** Highest-scoring skills, injected with their full body. */
	full: RankedSkill[];
	/** Remaining ranked skills, injected as one-line summaries. */
	summarized: RankedSkill[];
	/** The rendered "## Applicable Skills" markdown block. */
	overlayMarkdown: string;
}

/** Default characters of full-body skills injected when the caller omits a budget. */
const DEFAULT_BUDGET_CHARS = 6000;
/** Default number of full-body skills injected when the caller omits a cap. */
const DEFAULT_MAX_FULL = 4;

/** Heading of the overlay block this module renders. */
const OVERLAY_HEADING = "## Applicable Skills";
/** Shown when no skill scores above zero. */
const OVERLAY_EMPTY = "(no applicable skills yet)";

// Score component weights (must sum to 1).
const W_FILE = 0.45;
const W_LEXICAL = 0.3;
const W_CONFIDENCE = 0.15;
const W_RECENCY = 0.1;

/** Half-life (in days) of the recency-decay term — a skill this old scores ~0.5. */
const RECENCY_HALF_LIFE_DAYS = 30;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Tiny glob (supports `*`, `**`, and prefix/suffix anchoring)
// ---------------------------------------------------------------------------

/**
 * Match a path against a tiny glob `pattern`.
 *
 * Supported syntax:
 *   - `*`  matches any run of characters within a path segment (no `/`).
 *   - `**` matches any run of characters including `/` (spans segments).
 *   - everything else is a literal (anchored: the whole path must match).
 *
 * A pattern with no wildcards is treated as a substring test rather than an
 * exact-equality test, which is the documented fallback: a bare `commands` hint
 * still matches `src/commands/foo.ts`. Wildcarded patterns ARE anchored so
 * `src/*.ts` does not spuriously match `lib/src/a.ts`.
 */
export function globMatch(pattern: string, path: string): boolean {
	if (pattern === "") return false;
	// No wildcards → substring fallback (lenient, as specified).
	if (!pattern.includes("*")) {
		return path.includes(pattern);
	}
	const regex = globToRegExp(pattern);
	return regex.test(path);
}

/**
 * Compile a tiny-glob pattern into an anchored RegExp. `**` becomes `.*` (crosses
 * `/`); a single `*` becomes `[^/]*` (stays within a segment). All other regex
 * metacharacters are escaped so the pattern matches literally.
 */
function globToRegExp(pattern: string): RegExp {
	let out = "";
	for (let i = 0; i < pattern.length; i++) {
		const ch = pattern[i];
		if (ch === "*") {
			if (pattern[i + 1] === "*") {
				out += ".*";
				i++; // consume the second star
			} else {
				out += "[^/]*";
			}
			continue;
		}
		// Escape anything with special meaning in a RegExp.
		if (ch !== undefined && /[.+?^${}()|[\]\\]/.test(ch)) {
			out += `\\${ch}`;
		} else if (ch !== undefined) {
			out += ch;
		}
	}
	return new RegExp(`^${out}$`);
}

// ---------------------------------------------------------------------------
// Lexical overlap
// ---------------------------------------------------------------------------

/**
 * Tokenize text into a set of lowercase alphanumeric terms (length ≥ 2). Used on
 * both sides of the lexical comparison so the query and the skill's signals are
 * normalized identically.
 */
function tokenize(text: string): Set<string> {
	const terms = new Set<string>();
	for (const raw of text.toLowerCase().split(/[^a-z0-9]+/)) {
		if (raw.length >= 2) terms.add(raw);
	}
	return terms;
}

/**
 * Fraction of the query's terms that also appear in the skill's signal terms.
 *
 * This is a one-directional overlap (query ∩ signal) / |query| rather than a
 * symmetric Jaccard: a skill should rank for *covering the task's vocabulary*,
 * and we don't want to penalize a rich skill whose extra terms aren't in the
 * (typically short) task text. Returns 0 when the query has no usable terms.
 */
function lexicalOverlap(queryTerms: Set<string>, signalTerms: Set<string>): number {
	if (queryTerms.size === 0) return 0;
	let hits = 0;
	for (const term of queryTerms) {
		if (signalTerms.has(term)) hits++;
	}
	return hits / queryTerms.size;
}

// ---------------------------------------------------------------------------
// Recency
// ---------------------------------------------------------------------------

/**
 * Exponential recency decay in `[0, 1]` from an ISO `updatedAt` to `now`:
 * `0.5 ^ (ageDays / halfLife)`. A just-updated skill scores ~1; one a half-life
 * old scores ~0.5. An unparseable/missing timestamp yields 0 (no recency credit
 * rather than a spurious boost). `now` is injectable for deterministic tests.
 */
function recencyDecay(updatedAt: string, now: number): number {
	const ts = Date.parse(updatedAt);
	if (Number.isNaN(ts)) return 0;
	const ageDays = Math.max(0, (now - ts) / MS_PER_DAY);
	return 0.5 ** (ageDays / RECENCY_HALF_LIFE_DAYS);
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

/**
 * Fraction of a skill's `filePatterns` that glob-match at least one path in the
 * spawn's `fileScope`. A skill with no patterns contributes 0 file signal (it is
 * not file-anchored), leaving the lexical/confidence/recency terms to rank it.
 */
function fileOverlap(patterns: string[], fileScope: string[]): number {
	if (patterns.length === 0 || fileScope.length === 0) return 0;
	let matched = 0;
	for (const pattern of patterns) {
		if (fileScope.some((path) => globMatch(pattern, path))) matched++;
	}
	return matched / patterns.length;
}

/**
 * Confidence of a skill as a relevance score in `[0, 1]`. Computed against a
 * caller-supplied `now` so the recency term is deterministic in tests; the
 * exported {@link scoreSkill} pins `now` to `Date.now()`.
 *
 * `quarantined` and `deprecated` skills are excluded from retrieval and return a
 * hard 0 — callers drop anything that scores ≤ 0, so an inactive skill never
 * reaches an overlay even if its other signals are strong.
 */
function score(skill: Skill, opts: SelectOpts, now: number): number {
	if (skill.status !== "active") return 0;

	const file = fileOverlap(skill.filePatterns, opts.fileScope);

	const queryTerms = tokenize(`${opts.taskText} ${opts.capability}`);
	const signalTerms = tokenize(
		[skill.title, skill.goal, skill.whenToUse.join(" "), skill.tags.join(" ")].join(" "),
	);
	const lexical = lexicalOverlap(queryTerms, signalTerms);

	const confidence = clamp01(skill.confidence);
	const recency = recencyDecay(skill.updatedAt, now);

	return W_FILE * file + W_LEXICAL * lexical + W_CONFIDENCE * confidence + W_RECENCY * recency;
}

/** Clamp a possibly out-of-range number into `[0, 1]` (NaN → 0). */
function clamp01(value: number): number {
	if (!Number.isFinite(value)) return 0;
	return value < 0 ? 0 : value > 1 ? 1 : value;
}

/**
 * Relevance score of a single skill against a spawn context, in `[0, 1]`.
 *
 * PURE except for reading the wall clock for the recency term (`Date.now()`).
 * The blend is `0.45·fileOverlap + 0.30·lexical + 0.15·confidence +
 * 0.10·recencyDecay`. `quarantined`/`deprecated` skills score 0.
 */
export function scoreSkill(skill: Skill, opts: SelectOpts): number {
	return score(skill, opts, Date.now());
}

// ---------------------------------------------------------------------------
// Selection / packing
// ---------------------------------------------------------------------------

/**
 * Rank every skill, drop non-positive scores, then greedily pack the best as
 * FULL until adding the next would exceed `budgetChars` (default 6000) or
 * `maxFull` (default 4) is reached; the remaining ranked skills become
 * SUMMARIZED one-liners. Builds the "## Applicable Skills" overlay via
 * {@link renderSkillsOverlay}.
 *
 * The budget is measured against each candidate's rendered full-skill size (goal
 * + body + tag). A skill too large to ever fit an *empty* budget is not forced in
 * — it falls through to the summarized list — so a tiny budget degrades to
 * all-summaries rather than overflowing. Packing is greedy by score, but a
 * lower-scoring skill that DOES fit may be promoted to full after a higher one
 * was skipped for size, maximizing useful full-body content within the budget.
 *
 * Takes already-loaded skills (the store does the loading) so it stays pure and
 * directly testable.
 */
export function selectSkills(skills: Skill[], opts: SelectOpts): SelectResult {
	const now = Date.now();
	const budget = opts.budgetChars ?? DEFAULT_BUDGET_CHARS;
	const maxFull = opts.maxFull ?? DEFAULT_MAX_FULL;

	// Rank, dropping anything that scores ≤ 0 (includes quarantined/deprecated).
	const ranked: RankedSkill[] = [];
	for (const skill of skills) {
		const s = score(skill, opts, now);
		if (s > 0) ranked.push({ skill, score: s });
	}
	// Highest score first; slug as a stable tiebreak so ordering is deterministic.
	ranked.sort((a, b) => {
		if (a.score !== b.score) return b.score - a.score;
		return a.skill.slug < b.skill.slug ? -1 : a.skill.slug > b.skill.slug ? 1 : 0;
	});

	const full: RankedSkill[] = [];
	const summarized: RankedSkill[] = [];
	let used = 0;

	for (const entry of ranked) {
		if (full.length >= maxFull) {
			summarized.push(entry);
			continue;
		}
		const cost = renderFullSkill(entry.skill).length;
		// Fits if it stays within budget. We test against the running total so the
		// first full skill is admitted whenever it fits an empty budget.
		if (used + cost <= budget) {
			full.push(entry);
			used += cost;
		} else {
			summarized.push(entry);
		}
	}

	const overlayMarkdown = renderSkillsOverlay(
		full.map((r) => r.skill),
		summarized.map((r) => r.skill),
	);
	return { full, summarized, overlayMarkdown };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/**
 * Render one full skill: a `### <title>` header, its goal, the trimmed body, and
 * a `skill: <slug>` tag so the session-end feedback step (and a reader) can map
 * the injected text back to its source skill. This is also the unit the packer
 * measures against the character budget.
 */
function renderFullSkill(skill: Skill): string {
	const parts: string[] = [];
	parts.push(`### ${skill.title}`);
	if (skill.goal.trim() !== "") parts.push(`Goal: ${skill.goal.trim()}`);
	const body = skill.body.trim();
	if (body !== "") parts.push(body);
	parts.push(`skill: ${skill.slug}`);
	return parts.join("\n\n");
}

/**
 * Render one summarized skill as a single bullet line:
 * `- <title> — <goal> (run \`agentplate skill show <slug>\`)`. The goal segment is
 * omitted when the skill has none, so the dash separator never dangles.
 */
function renderSummarizedSkill(skill: Skill): string {
	const goal = skill.goal.trim();
	const head = goal !== "" ? `${skill.title} — ${goal}` : skill.title;
	return `- ${head} (run \`agentplate skill show ${skill.slug}\`)`;
}

/**
 * Build the "## Applicable Skills" overlay block from the selected `full` and
 * `summarized` skills.
 *
 * Full skills are rendered first (header + goal + body + `skill:` tag, separated
 * by blank lines); a "### Related skills" sub-section then lists the summarized
 * one-liners. When neither list has any skill the block is just the heading plus
 * the placeholder, so the overlay always has a stable, self-explanatory section.
 */
export function renderSkillsOverlay(full: Skill[], summarized: Skill[]): string {
	if (full.length === 0 && summarized.length === 0) {
		return `${OVERLAY_HEADING}\n\n${OVERLAY_EMPTY}`;
	}

	const sections: string[] = [OVERLAY_HEADING];

	for (const skill of full) {
		sections.push(renderFullSkill(skill));
	}

	if (summarized.length > 0) {
		const lines = ["### Related skills", ...summarized.map(renderSummarizedSkill)];
		sections.push(lines.join("\n"));
	}

	return sections.join("\n\n");
}
