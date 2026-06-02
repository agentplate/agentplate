/**
 * Skill store — the source of truth plus a derived FTS index.
 *
 * A skill lives on disk as a directory `<root>/.agentplate/skills/<slug>/` holding:
 *   - `skill.md`     — YAML frontmatter (every {@link Skill} field except `body`)
 *                       + a blank line + the markdown body. This is authoritative.
 *   - `outcomes.jsonl` — append-only log of {@link SkillOutcome}s, one JSON per line.
 *
 * A gitignored SQLite FTS5 index (`<root>/.agentplate/skills.db`) accelerates
 * retrieval and is fully rebuildable from the `skill.md` files via {@link reindex}.
 *
 * Derived fields (`confidence`, `appliedCount`, `successCount`, `lastOutcome`)
 * ARE persisted into the frontmatter for cheap reads, but are always recomputed
 * from `outcomes.jsonl` whenever an outcome is appended — they are never trusted
 * as hand-edited input. The recompute is INLINED here (a weighted-count +
 * Wilson lower bound) rather than imported from the sibling feedback module, to
 * keep the store free of a cross-dependency on a module built in parallel.
 *
 * Storage style mirrors the rest of Agentplate: js-yaml for human-editable YAML
 * (as in config.ts / secrets.ts / identity.ts), bun:sqlite via openDatabase for
 * the WAL-mode index, and crypto.randomUUID for ids.
 */

import type { Database } from "bun:sqlite";
import {
	appendFileSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import yaml from "js-yaml";
import { AGENTPLATE_DIR } from "../config.ts";
import { openDatabase } from "../db/sqlite.ts";
import { NotFoundError, ValidationError } from "../errors.ts";
import type { OutcomeStatus } from "../types.ts";
import type { Skill, SkillDraft, SkillOutcome, SkillProvenance, SkillStatus } from "./types.ts";

/** Name of the per-skill source-of-truth file. */
const SKILL_FILE = "skill.md";
/** Name of the per-skill append-only outcome log. */
const OUTCOMES_FILE = "outcomes.jsonl";
/** Name of the derived (gitignored) FTS index. */
const INDEX_FILE = "skills.db";

/**
 * Canonical frontmatter key order. Serialization walks this list so `skill.md`
 * is byte-stable regardless of object construction order, which keeps git diffs
 * small and round-trips deterministic.
 */
const FRONTMATTER_KEYS = [
	"id",
	"slug",
	"title",
	"version",
	"status",
	"goal",
	"whenToUse",
	"filePatterns",
	"tags",
	"created",
	"updatedAt",
	"distilledFrom",
	"relatesTo",
	"supersedes",
	"confidence",
	"appliedCount",
	"successCount",
	"lastOutcome",
] as const;

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested directly)
// ---------------------------------------------------------------------------

/**
 * Lowercase, kebab-case slug. Non-alphanumeric runs become single dashes;
 * leading/trailing dashes are trimmed. An input that reduces to nothing yields
 * the literal `"skill"` so a directory name always exists.
 */
export function slugify(title: string): string {
	const slug = title
		.toLowerCase()
		.normalize("NFKD")
		// Strip combining marks left by normalization (e.g. accents).
		.replace(/[̀-ͯ]/g, "")
		// Any run of non [a-z0-9] becomes a single dash.
		.replace(/[^a-z0-9]+/g, "-")
		// Collapse repeats and trim edges.
		.replace(/-+/g, "-")
		.replace(/^-|-$/g, "");
	return slug === "" ? "skill" : slug;
}

/** Coerce an unknown parsed value into a `string[]`, dropping non-strings. */
function toStringArray(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	const out: string[] = [];
	for (const item of value) {
		if (typeof item === "string") out.push(item);
	}
	return out;
}

/** Coerce an unknown parsed value into `SkillProvenance`, or `undefined`. */
function toProvenance(value: unknown): SkillProvenance | undefined {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
	const obj = value as Record<string, unknown>;
	return {
		taskId: typeof obj.taskId === "string" ? obj.taskId : null,
		agent: typeof obj.agent === "string" ? obj.agent : "",
		commit: typeof obj.commit === "string" ? obj.commit : null,
	};
}

/** Narrow an unknown to a {@link SkillStatus}, defaulting to `"active"`. */
function toStatus(value: unknown): SkillStatus {
	return value === "deprecated" || value === "quarantined" ? value : "active";
}

/** Narrow an unknown to an {@link OutcomeStatus} or `null`. */
function toOutcomeStatus(value: unknown): OutcomeStatus | null {
	return value === "success" || value === "partial" || value === "failure" ? value : null;
}

/** Coerce an unknown to a finite number, falling back to `fallback`. */
function toNumber(value: unknown, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/**
 * Parse a `skill.md` document into a {@link Skill}.
 *
 * Splits the leading `---`-fenced YAML frontmatter from the markdown body that
 * follows it. Every Skill field except `body` comes from the frontmatter; the
 * remainder (after the closing fence and one optional blank line) is the body.
 * Optional arrays default to `[]` and missing scalars to safe defaults so a
 * partially-written or older file never throws.
 */
export function parseSkillMd(text: string): Skill {
	const { frontmatter, body } = splitFrontmatter(text);

	const parsed = yaml.load(frontmatter);
	if (
		parsed === null ||
		parsed === undefined ||
		typeof parsed !== "object" ||
		Array.isArray(parsed)
	) {
		throw new ValidationError("skill.md frontmatter must be a YAML mapping");
	}
	const fm = parsed as Record<string, unknown>;

	return {
		id: typeof fm.id === "string" && fm.id !== "" ? fm.id : crypto.randomUUID(),
		slug: typeof fm.slug === "string" ? fm.slug : "",
		title: typeof fm.title === "string" ? fm.title : "",
		version: toNumber(fm.version, 1),
		status: toStatus(fm.status),
		goal: typeof fm.goal === "string" ? fm.goal : "",
		whenToUse: toStringArray(fm.whenToUse),
		filePatterns: toStringArray(fm.filePatterns),
		tags: toStringArray(fm.tags),
		created: typeof fm.created === "string" ? fm.created : "",
		updatedAt: typeof fm.updatedAt === "string" ? fm.updatedAt : "",
		distilledFrom: toProvenance(fm.distilledFrom),
		relatesTo: toStringArray(fm.relatesTo),
		supersedes: toStringArray(fm.supersedes),
		body,
		confidence: toNumber(fm.confidence, 0),
		appliedCount: toNumber(fm.appliedCount, 0),
		successCount: toNumber(fm.successCount, 0),
		lastOutcome: toOutcomeStatus(fm.lastOutcome),
	};
}

/**
 * Split a `skill.md` into its raw frontmatter YAML and markdown body.
 *
 * Recognizes a leading `---` fence (optionally preceded by whitespace/BOM) and
 * the next line that is exactly `---`. If no fences are present the whole
 * document is treated as the body with empty frontmatter, so plain markdown
 * still parses (yielding a defaults-only Skill).
 */
function splitFrontmatter(text: string): { frontmatter: string; body: string } {
	// Normalize CRLF so the fence regex and line slicing behave identically on
	// Windows-authored files.
	const normalized = text.replace(/\r\n/g, "\n").replace(/^﻿/, "");
	const lines = normalized.split("\n");

	// The first non-empty line must be the opening fence.
	let start = 0;
	while (start < lines.length && lines[start]?.trim() === "") start++;
	if (lines[start]?.trim() !== "---") {
		return { frontmatter: "", body: normalized };
	}

	// Find the closing fence.
	let end = -1;
	for (let i = start + 1; i < lines.length; i++) {
		if (lines[i]?.trim() === "---") {
			end = i;
			break;
		}
	}
	if (end === -1) {
		// Unterminated fence: treat everything after the opener as frontmatter and
		// leave no body, rather than swallowing the document into the body.
		return { frontmatter: lines.slice(start + 1).join("\n"), body: "" };
	}

	const frontmatter = lines.slice(start + 1, end).join("\n");
	// Body is everything after the closing fence. Strip exactly the separators
	// serializeSkillMd writes so a serialize → parse round-trip is the identity:
	// one leading blank line (the fence/body separator) and the single trailing
	// newline that terminates the file.
	let bodyLines = lines.slice(end + 1);
	if (bodyLines[0] === "") bodyLines = bodyLines.slice(1);
	if (bodyLines.length > 0 && bodyLines[bodyLines.length - 1] === "") {
		bodyLines = bodyLines.slice(0, -1);
	}
	return { frontmatter, body: bodyLines.join("\n") };
}

/**
 * Serialize a {@link Skill} into a `skill.md` document: a deterministic
 * `---`-fenced YAML frontmatter (stable key order, omitting only `body`),
 * a single blank line, then the markdown body. Round-trips with
 * {@link parseSkillMd}.
 */
export function serializeSkillMd(skill: Skill): string {
	const record = skill as unknown as Record<string, unknown>;

	// Build the mapping in canonical key order so js-yaml (sortKeys:false) emits
	// a byte-stable document. Optional `distilledFrom` is omitted when absent so
	// the file does not carry a `null` for a field the type marks optional.
	const ordered: Record<string, unknown> = {};
	for (const key of FRONTMATTER_KEYS) {
		if (
			key === "distilledFrom" &&
			(skill.distilledFrom === undefined || skill.distilledFrom === null)
		) {
			continue;
		}
		ordered[key] = record[key];
	}

	const frontmatter = yaml.dump(ordered, { indent: 2, lineWidth: 100, sortKeys: false }).trimEnd();
	// Body is preserved verbatim; ensure a single trailing newline on the file.
	const body = skill.body.replace(/\s+$/, "");
	return `---\n${frontmatter}\n---\n\n${body}\n`;
}

// ---------------------------------------------------------------------------
// Derived-field recompute (inlined; mirrors feedback.computeConfidence)
// ---------------------------------------------------------------------------

/**
 * Per-status success weight used when scoring an outcome line:
 * a full success counts 1, a partial 0.5, a failure 0.
 */
function outcomeWeight(status: OutcomeStatus): number {
	if (status === "success") return 1;
	if (status === "partial") return 0.5;
	return 0;
}

/**
 * Wilson score interval lower bound for a binomial proportion at ~95%
 * confidence (z = 1.96). `successes` may be fractional (weighted partials).
 * Returns 0 when there are no samples — an unproven skill earns no confidence.
 *
 * Inlined here (rather than importing feedback.ts, which is built in parallel)
 * to avoid a cross-module dependency. The formula is the standard Wilson lower
 * bound; the sibling feedback module is expected to compute the same value.
 */
function wilsonLowerBound(successes: number, n: number): number {
	if (n <= 0) return 0;
	const z = 1.96;
	const phat = successes / n;
	const z2 = z * z;
	const denom = 1 + z2 / n;
	const center = phat + z2 / (2 * n);
	const margin = z * Math.sqrt((phat * (1 - phat) + z2 / (4 * n)) / n);
	const lower = (center - margin) / denom;
	// Clamp to [0,1]; weighting can push phat into ranges where the raw bound
	// drifts a hair outside the interval.
	return lower < 0 ? 0 : lower > 1 ? 1 : lower;
}

/** Derived stats recomputed from a skill's full outcome history. */
interface DerivedStats {
	appliedCount: number;
	successCount: number;
	confidence: number;
	lastOutcome: OutcomeStatus | null;
}

/**
 * Fold an ordered list of outcomes into derived stats:
 * - `appliedCount` = number of outcomes (lines),
 * - `successCount` = weighted sum (success 1 / partial 0.5 / failure 0),
 * - `confidence`   = Wilson lower bound of the weighted successes over the count,
 * - `lastOutcome`  = status of the final outcome (null when there are none).
 */
function deriveStats(outcomes: SkillOutcome[]): DerivedStats {
	let successCount = 0;
	for (const outcome of outcomes) {
		successCount += outcomeWeight(outcome.status);
	}
	const appliedCount = outcomes.length;
	const last = outcomes[outcomes.length - 1];
	return {
		appliedCount,
		successCount,
		confidence: wilsonLowerBound(successCount, appliedCount),
		lastOutcome: last ? last.status : null,
	};
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

/** Filters for {@link SkillStore.list}. */
export interface ListSkillsOptions {
	status?: SkillStatus;
}

/** Result of an {@link SkillStore.upsert}. */
export interface UpsertResult {
	action: "created" | "updated";
	skill: Skill;
}

/** Public surface returned by {@link createSkillStore}. */
export interface SkillStore {
	list(opts?: ListSkillsOptions): Skill[];
	get(slug: string): Skill | null;
	upsert(draft: SkillDraft, provenance: SkillProvenance): UpsertResult;
	setStatus(slug: string, status: SkillStatus): void;
	appendOutcome(slug: string, outcome: SkillOutcome): Skill;
	remove(slug: string): void;
	reindex(): number;
	close(): void;
}

/** FTS row shape as stored in the derived index. */
interface IndexRow {
	slug: string;
	title: string;
	goal: string;
	tags: string;
	when_to_use: string;
	file_patterns: string;
	status: string;
	confidence: number;
	updated_at: string;
}

/**
 * Create a skill store rooted at a project directory.
 *
 * `<root>/.agentplate/skills/` holds one directory per skill; `<root>/.agentplate/
 * skills.db` is the derived FTS index (created on open, rebuildable via
 * {@link SkillStore.reindex}). The skills directory is created lazily on first
 * write so opening a store on a fresh project is side-effect free beyond the
 * (gitignored) index file.
 */
export function createSkillStore(root: string): SkillStore {
	const agentplateDir = join(root, AGENTPLATE_DIR);
	const skillsDir = join(agentplateDir, "skills");
	const indexPath = join(agentplateDir, INDEX_FILE);

	// The index lives under .agentplate/, which must exist before SQLite can create
	// the file. Creating it here is safe and idempotent.
	mkdirSync(agentplateDir, { recursive: true });
	const db: Database = openDatabase(indexPath);
	initIndex(db);

	/** Absolute path to a skill's directory. */
	function dirOf(slug: string): string {
		return join(skillsDir, slug);
	}
	/** Absolute path to a skill's `skill.md`. */
	function skillFileOf(slug: string): string {
		return join(dirOf(slug), SKILL_FILE);
	}
	/** Absolute path to a skill's `outcomes.jsonl`. */
	function outcomesFileOf(slug: string): string {
		return join(dirOf(slug), OUTCOMES_FILE);
	}

	/** Read + parse a skill by slug, or null if its `skill.md` is absent. */
	function read(slug: string): Skill | null {
		const file = skillFileOf(slug);
		if (!existsSync(file)) return null;
		const skill = parseSkillMd(readFileSync(file, "utf8"));
		// The directory name is authoritative for the slug — trust it over a stale
		// frontmatter value (e.g. if a directory was renamed by hand).
		skill.slug = slug;
		return skill;
	}

	/**
	 * Write a skill's `skill.md` (creating its directory) and refresh the index row.
	 *
	 * The body is normalized in place to exactly the form that lands on disk
	 * (trailing whitespace trimmed by {@link serializeSkillMd}). Mutating the
	 * passed object here makes it the single normalization point, so the `Skill`
	 * a caller returns is identical to what a later {@link parseSkillMd} reads
	 * back — `upsert(...).skill` equals `get(slug)`.
	 */
	function write(skill: Skill): void {
		skill.body = skill.body.replace(/\s+$/, "");
		mkdirSync(dirOf(skill.slug), { recursive: true });
		writeFileSync(skillFileOf(skill.slug), serializeSkillMd(skill), "utf8");
		upsertIndexRow(db, skill);
	}

	/** Read every outcome line for a skill (skipping malformed lines). */
	function readOutcomes(slug: string): SkillOutcome[] {
		const file = outcomesFileOf(slug);
		if (!existsSync(file)) return [];
		const out: SkillOutcome[] = [];
		for (const line of readFileSync(file, "utf8").split("\n")) {
			const trimmed = line.trim();
			if (trimmed === "") continue;
			let parsed: unknown;
			try {
				parsed = JSON.parse(trimmed);
			} catch {
				// A corrupt line should not poison the whole history.
				continue;
			}
			const outcome = coerceOutcome(parsed);
			if (outcome !== null) out.push(outcome);
		}
		return out;
	}

	/** List every skill on disk, newest-updated first, optionally status-filtered. */
	function list(opts?: ListSkillsOptions): Skill[] {
		if (!existsSync(skillsDir)) return [];
		const skills: Skill[] = [];
		for (const entry of readdirSync(skillsDir, { withFileTypes: true })) {
			if (!entry.isDirectory()) continue;
			const skill = read(entry.name);
			if (skill === null) continue;
			if (opts?.status !== undefined && skill.status !== opts.status) continue;
			skills.push(skill);
		}
		// Deterministic order: most-recently-updated first, slug as a stable tiebreak.
		skills.sort((a, b) => {
			if (a.updatedAt !== b.updatedAt) return a.updatedAt < b.updatedAt ? 1 : -1;
			return a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0;
		});
		return skills;
	}

	function get(slug: string): Skill | null {
		return read(slug);
	}

	function upsert(draft: SkillDraft, provenance: SkillProvenance): UpsertResult {
		// `skip` drafts must never reach storage. The caller is expected to guard
		// this, but we reject defensively so a stray skip can't mint/mutate a skill.
		if (draft.action === "skip") {
			throw new ValidationError("Cannot upsert a SkillDraft with action 'skip'");
		}

		const now = new Date().toISOString();

		// --- UPDATE path: bump an existing skill, preserving its outcome log. ---
		if (draft.action === "update") {
			const targetSlug = draft.targetSlug;
			if (targetSlug === undefined || targetSlug === "") {
				throw new ValidationError("SkillDraft action 'update' requires targetSlug");
			}
			const existing = read(targetSlug);
			if (existing === null) {
				throw new NotFoundError(`Cannot update skill: "${targetSlug}" not found`);
			}

			// Recompute derived fields from the preserved outcome log so they stay
			// consistent across the version bump (outcomes.jsonl is left untouched).
			const stats = deriveStats(readOutcomes(targetSlug));

			const updated: Skill = {
				...existing,
				title: draft.title ?? existing.title,
				goal: draft.goal ?? existing.goal,
				whenToUse: draft.whenToUse ?? existing.whenToUse,
				filePatterns: draft.filePatterns ?? existing.filePatterns,
				tags: draft.tags ?? existing.tags,
				body: draft.body ?? existing.body,
				version: existing.version + 1,
				updatedAt: now,
				distilledFrom: provenance,
				...stats,
			};
			write(updated);
			return { action: "updated", skill: updated };
		}

		// --- CREATE path: mint a fresh skill directory from the title slug. ---
		if (draft.title === undefined || draft.title.trim() === "") {
			throw new ValidationError("SkillDraft action 'create' requires a non-empty title");
		}
		const slug = uniqueSlug(slugify(draft.title));

		const created: Skill = {
			id: crypto.randomUUID(),
			slug,
			title: draft.title,
			version: 1,
			status: "active",
			goal: draft.goal ?? "",
			whenToUse: draft.whenToUse ?? [],
			filePatterns: draft.filePatterns ?? [],
			tags: draft.tags ?? [],
			created: now,
			updatedAt: now,
			distilledFrom: provenance,
			relatesTo: [],
			supersedes: [],
			body: draft.body ?? "",
			confidence: 0,
			appliedCount: 0,
			successCount: 0,
			lastOutcome: null,
		};
		write(created);
		return { action: "created", skill: created };
	}

	/**
	 * Resolve a free slug, appending `-2`, `-3`, … if the base is taken so two
	 * skills with the same title don't collide on one directory.
	 */
	function uniqueSlug(base: string): string {
		if (!existsSync(dirOf(base))) return base;
		for (let n = 2; ; n++) {
			const candidate = `${base}-${n}`;
			if (!existsSync(dirOf(candidate))) return candidate;
		}
	}

	function setStatus(slug: string, status: SkillStatus): void {
		const skill = read(slug);
		if (skill === null) {
			throw new NotFoundError(`Cannot set status: skill "${slug}" not found`);
		}
		skill.status = status;
		skill.updatedAt = new Date().toISOString();
		write(skill);
	}

	function appendOutcome(slug: string, outcome: SkillOutcome): Skill {
		const skill = read(slug);
		if (skill === null) {
			throw new NotFoundError(`Cannot append outcome: skill "${slug}" not found`);
		}

		// Append first (the JSONL log is the durable record), then recompute the
		// cached derived fields in skill.md from the full, post-append history.
		appendFileSync(outcomesFileOf(slug), `${JSON.stringify(outcome)}\n`, "utf8");

		const stats = deriveStats(readOutcomes(slug));
		const updated: Skill = { ...skill, ...stats };
		write(updated);
		return updated;
	}

	function remove(slug: string): void {
		const dir = dirOf(slug);
		if (existsSync(dir)) {
			rmSync(dir, { recursive: true, force: true });
		}
		db.query("DELETE FROM skills_fts WHERE slug = $slug").run({ $slug: slug });
	}

	function reindex(): number {
		// Rebuild the FTS table from scratch so deletions/renames on disk are
		// reflected and the index can't drift from the source of truth.
		db.exec("DELETE FROM skills_fts");
		let count = 0;
		for (const skill of list()) {
			upsertIndexRow(db, skill);
			count++;
		}
		return count;
	}

	function close(): void {
		db.close();
	}

	return { list, get, upsert, setStatus, appendOutcome, remove, reindex, close };
}

// ---------------------------------------------------------------------------
// Outcome coercion
// ---------------------------------------------------------------------------

/** Narrow an unknown parsed JSONL value into a {@link SkillOutcome}, or null. */
function coerceOutcome(value: unknown): SkillOutcome | null {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
	const obj = value as Record<string, unknown>;
	const status = toOutcomeStatus(obj.status);
	// An outcome without a valid status carries no information — drop it.
	if (status === null) return null;
	const outcome: SkillOutcome = {
		status,
		agent: typeof obj.agent === "string" ? obj.agent : "",
		taskId: typeof obj.taskId === "string" ? obj.taskId : null,
		gates: toOutcomeStatus(obj.gates),
		ts: typeof obj.ts === "string" ? obj.ts : "",
	};
	if (typeof obj.note === "string") outcome.note = obj.note;
	return outcome;
}

// ---------------------------------------------------------------------------
// FTS index
// ---------------------------------------------------------------------------

/**
 * Create the FTS5 virtual table if it is absent. `slug` is stored UNINDEXED so
 * it round-trips exactly (it is a row key, not a search term); the remaining
 * text columns are full-text searchable. `confidence`/`updated_at` ride along as
 * unindexed columns so retrieval can rank/filter without a second table.
 */
function initIndex(db: Database): void {
	db.exec(`
		CREATE VIRTUAL TABLE IF NOT EXISTS skills_fts USING fts5(
			slug UNINDEXED,
			title,
			goal,
			tags,
			when_to_use,
			file_patterns,
			status UNINDEXED,
			confidence UNINDEXED,
			updated_at UNINDEXED
		)
	`);
}

/** Replace (delete + insert) a skill's row in the FTS index. */
function upsertIndexRow(db: Database, skill: Skill): void {
	// FTS5 has no UPSERT; delete the prior row (if any) then insert the current.
	db.query("DELETE FROM skills_fts WHERE slug = $slug").run({ $slug: skill.slug });
	const row: IndexRow = {
		slug: skill.slug,
		title: skill.title,
		goal: skill.goal,
		tags: skill.tags.join(" "),
		when_to_use: skill.whenToUse.join(" "),
		file_patterns: skill.filePatterns.join(" "),
		status: skill.status,
		confidence: skill.confidence,
		updated_at: skill.updatedAt,
	};
	db.query(
		`INSERT INTO skills_fts
			(slug, title, goal, tags, when_to_use, file_patterns, status, confidence, updated_at)
		VALUES
			($slug, $title, $goal, $tags, $when_to_use, $file_patterns, $status, $confidence, $updated_at)`,
	).run({
		$slug: row.slug,
		$title: row.title,
		$goal: row.goal,
		$tags: row.tags,
		$when_to_use: row.when_to_use,
		$file_patterns: row.file_patterns,
		$status: row.status,
		$confidence: row.confidence,
		$updated_at: row.updated_at,
	});
}
