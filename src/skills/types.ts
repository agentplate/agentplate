/**
 * Self-improving skills — domain types.
 *
 * A **Skill** is a reusable, versioned, executable playbook distilled from a
 * successful task: a goal, when-to-use signals, ordered steps (prose + concrete
 * command snippets), file-pattern hints, gotchas, and an earned confidence track
 * record. Skills are the unit of Agentplate's closed learning loop:
 *
 *   retrieve (at spawn) → apply (agent uses them) → distill (at session-end,
 *   gated on quality gates) → feedback (append outcome, evolve confidence).
 *
 * On disk each skill is a directory `.agentplate/skills/<slug>/` containing
 * `skill.md` (YAML frontmatter + markdown body — the source of truth) and
 * `outcomes.jsonl` (append-only outcome log). A derived, gitignored SQLite FTS
 * index (`skills.db`) accelerates retrieval and is rebuildable from the files.
 */

import type { OutcomeStatus } from "../types.ts";

/** Lifecycle status. `quarantined`/`deprecated` skills are excluded from retrieval. */
export type SkillStatus = "active" | "deprecated" | "quarantined";

/** Provenance of a distilled skill. */
export interface SkillProvenance {
	taskId: string | null;
	agent: string;
	commit: string | null;
}

/** A reusable, versioned playbook. */
export interface Skill {
	/** Stable content-independent id. */
	id: string;
	/** URL/dir-safe identifier (the directory name). */
	slug: string;
	title: string;
	/** Bumped on every UPDATE distillation. */
	version: number;
	status: SkillStatus;
	/** One-line statement of what applying this skill accomplishes. */
	goal: string;
	/** Preconditions / retrieval signals ("when should an agent use this?"). */
	whenToUse: string[];
	/** Glob patterns of files this skill is relevant to (file-overlap ranking). */
	filePatterns: string[];
	tags: string[];
	created: string;
	updatedAt: string;
	distilledFrom?: SkillProvenance;
	/** Slugs of related skills. */
	relatesTo: string[];
	/** Slugs this skill structurally replaces. */
	supersedes: string[];
	/** Markdown body after the frontmatter (steps / gotchas / verification). */
	body: string;

	// --- derived (computed from outcomes.jsonl; never hand-edited) ---
	/** 0..1 confidence (Wilson lower bound over weighted outcomes). */
	confidence: number;
	appliedCount: number;
	successCount: number;
	lastOutcome: OutcomeStatus | null;
}

/** One appended line in a skill's `outcomes.jsonl`. */
export interface SkillOutcome {
	status: OutcomeStatus;
	agent: string;
	taskId: string | null;
	/** Quality-gate status that produced this outcome (null if gates not run). */
	gates: OutcomeStatus | null;
	ts: string;
	note?: string;
}

/**
 * Output of the AI distiller, pre-validation. `skip` is first-class — most
 * sessions should NOT mint a skill, preventing skill spam.
 */
export interface SkillDraft {
	action: "create" | "update" | "skip";
	/** Required when action is "update": the slug to update. */
	targetSlug?: string;
	title?: string;
	goal?: string;
	whenToUse?: string[];
	filePatterns?: string[];
	tags?: string[];
	body?: string;
}

/** A skill plus its relevance score (retrieval output). */
export interface RankedSkill {
	skill: Skill;
	score: number;
}

/**
 * Written to `.agentplate/agents/<name>/applied-skills.json` at spawn so the
 * session-end feedback step knows which skills to score.
 */
export interface AppliedSkillsRecord {
	taskId: string;
	agent: string;
	capability: string;
	skills: Array<{ id: string; slug: string; injected: "full" | "summary" }>;
}
