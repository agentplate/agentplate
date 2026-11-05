/**
 * `agentplate skill` — operate on the self-improving skill library.
 *
 * Skills live on disk as `.agentplate/skills/<slug>/` directories (skill.md +
 * outcomes.jsonl); the {@link createSkillStore} in `../skills/store.ts` is the
 * single read/write path. This command is the operator (and Stop-hook) surface
 * over that store:
 *
 *   list       — tabular roster (slug, title, confidence, applied/success, status)
 *   show       — print a skill's full skill.md
 *   search     — rank skills for a task description (+ optional --files) exactly
 *                as agent retrieval would, and print them
 *   record     — read a JSON SkillDraft from stdin, scrub it, and upsert (manual
 *                distillation path; the Stop hook pipes a draft here)
 *   outcome    — append a success/partial/failure outcome to a skill
 *   prune      — remove quarantined skills past the max-age window (dry-run default)
 *   approve    — make a draft skill active (drafts exist under skills.requireReview)
 *   deprecate  — mark a skill deprecated (excluded from retrieval)
 *   restore    — return a deprecated/quarantined skill to active
 *   reindex    — deprecated no-op, hidden from help (the FTS index it rebuilt is gone)
 *
 * `--json` is read via `command.optsWithGlobals().json === true` (each subcommand
 * still declares `--json`), matching the house pattern in `mail.ts`.
 *
 * `search` calls {@link rankSkills} from `../skills/retrieval.ts`, the same
 * ranker (status filter, safety scrub, scorer) that picks the skills injected
 * into an agent's overlay, so its scores and order match what agents get.
 */

import { Command } from "commander";
import { loadConfig } from "../config.ts";
import { NotFoundError, ValidationError } from "../errors.ts";
import { jsonOutput } from "../json.ts";
import { accent, brand, muted, printInfo, printSuccess, printWarning } from "../logging/color.ts";
import { rankSkills } from "../skills/retrieval.ts";
import { sanitizeSkillDraft } from "../skills/safety.ts";
import { createSkillStore, type SkillStore, serializeSkillMd } from "../skills/store.ts";
import type { Skill, SkillDraft, SkillStatus } from "../skills/types.ts";
import type { OutcomeStatus } from "../types.ts";
import { requireInit } from "./shared.ts";

/** Provenance stamped onto manually-recorded skills (the operator path). */
const OPERATOR_PROVENANCE = { taskId: null, agent: "operator", commit: null } as const;

/**
 * Resolve the project root, throwing if Agentplate is not initialized there.
 * Every subcommand calls this first so an uninitialized project fails fast and
 * uniformly (matching the rest of the CLI).
 */
/** Read the `--json` global flag off the action's trailing Command instance. */
function wantsJson(command: Command): boolean {
	return command.optsWithGlobals().json === true;
}

// ---------------------------------------------------------------------------
// Pure helpers (formatting + parsing) — unit-tested directly
// ---------------------------------------------------------------------------

/** Format a 0..1 confidence as a fixed-width two-decimal string (e.g. `0.42`). */
function formatConfidence(value: number): string {
	return value.toFixed(2);
}

/** A compact `applied/success` cell; success may be fractional (weighted partials). */
function formatTrack(skill: Skill): string {
	const success = Number.isInteger(skill.successCount)
		? String(skill.successCount)
		: skill.successCount.toFixed(1);
	return `${skill.appliedCount}/${success}`;
}

/** One JSON-safe row describing a skill (the `--json` shape for list/search). */
interface SkillRow {
	slug: string;
	title: string;
	status: SkillStatus;
	confidence: number;
	appliedCount: number;
	successCount: number;
}

/** Project a {@link Skill} to its compact row shape. */
function toRow(skill: Skill): SkillRow {
	return {
		slug: skill.slug,
		title: skill.title,
		status: skill.status,
		confidence: skill.confidence,
		appliedCount: skill.appliedCount,
		successCount: skill.successCount,
	};
}

/** Right-pad (or truncate with an ellipsis) a string to an exact display width. */
function pad(text: string, width: number): string {
	if (text.length === width) return text;
	if (text.length < width) return text + " ".repeat(width - text.length);
	if (width <= 1) return text.slice(0, width);
	return `${text.slice(0, width - 1)}…`;
}

/**
 * Print a roster of skills as an aligned table. Columns: slug, title, conf,
 * applied/success, status. A header is printed once; an empty list prints a muted
 * placeholder instead of bare headers.
 */
function printSkillTable(skills: Skill[]): void {
	if (skills.length === 0) {
		printInfo(muted("(no skills)"));
		return;
	}
	const SLUG_W = 28;
	const TITLE_W = 36;
	printInfo(
		muted(
			`${pad("SLUG", SLUG_W)}  ${pad("TITLE", TITLE_W)}  ${pad("CONF", 4)}  ${pad("A/S", 7)}  STATUS`,
		),
	);
	for (const skill of skills) {
		const slug = brand(pad(skill.slug, SLUG_W));
		const title = pad(skill.title, TITLE_W);
		const conf = pad(formatConfidence(skill.confidence), 4);
		const track = pad(formatTrack(skill), 7);
		const status = colorStatus(skill.status);
		printInfo(`${slug}  ${title}  ${conf}  ${track}  ${status}`);
	}
}

/** Color a lifecycle status for the table's STATUS column. */
function colorStatus(status: SkillStatus): string {
	if (status === "active") return status;
	if (status === "deprecated") return muted(status);
	return accent(status);
}

/** Narrow an arbitrary string to a {@link SkillStatus}, or throw a ValidationError. */
function parseStatusFilter(value: string): SkillStatus {
	if (
		value === "active" ||
		value === "draft" ||
		value === "deprecated" ||
		value === "quarantined"
	) {
		return value;
	}
	throw new ValidationError(
		`Invalid --status "${value}" (expected active | draft | deprecated | quarantined)`,
	);
}

/** Narrow an arbitrary string to an {@link OutcomeStatus}, or throw a ValidationError. */
function parseOutcomeStatus(value: string): OutcomeStatus {
	if (value === "success" || value === "partial" || value === "failure") return value;
	throw new ValidationError(`Invalid --status "${value}" (expected success | partial | failure)`);
}

/**
 * Parse a JSON {@link SkillDraft} from a string (stdin). Validates that it is an
 * object with a known `action`; everything else is left to the store/safety layer
 * which already coerce optional fields. Throws {@link ValidationError} on malformed
 * JSON or a missing/invalid action so the caller never feeds garbage to the store.
 */
export function parseDraft(input: string): SkillDraft {
	const trimmed = input.trim();
	if (trimmed === "") {
		throw new ValidationError("No draft on stdin (expected a JSON SkillDraft)");
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(trimmed);
	} catch (error) {
		throw new ValidationError(`Invalid JSON on stdin: ${(error as Error).message}`);
	}
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new ValidationError("Draft must be a JSON object");
	}
	const obj = parsed as Record<string, unknown>;
	const action = obj.action;
	if (action !== "create" && action !== "update" && action !== "skip") {
		throw new ValidationError('Draft "action" must be one of: create, update, skip');
	}

	// Build a clean SkillDraft, carrying only known fields with the right shapes.
	const draft: SkillDraft = { action };
	if (typeof obj.targetSlug === "string") draft.targetSlug = obj.targetSlug;
	if (typeof obj.title === "string") draft.title = obj.title;
	if (typeof obj.goal === "string") draft.goal = obj.goal;
	if (Array.isArray(obj.whenToUse)) draft.whenToUse = obj.whenToUse.filter(isStr);
	if (Array.isArray(obj.filePatterns)) draft.filePatterns = obj.filePatterns.filter(isStr);
	if (Array.isArray(obj.tags)) draft.tags = obj.tags.filter(isStr);
	if (typeof obj.body === "string") draft.body = obj.body;
	return draft;
}

/** Type guard used to filter parsed arrays down to strings. */
function isStr(value: unknown): value is string {
	return typeof value === "string";
}

// ---------------------------------------------------------------------------
// Subcommand actions (exported so tests can drive them without spawning the CLI)
// ---------------------------------------------------------------------------

/** Options accepted by `agentplate skill list`. */
export interface ListOptions {
	status?: string;
	json?: boolean;
}

/** `agentplate skill list` — print every skill (optionally status-filtered). */
export function runList(opts: ListOptions, useJson: boolean): void {
	const root = requireInit();
	const store = createSkillStore(root);
	try {
		const statusFilter = opts.status === undefined ? undefined : parseStatusFilter(opts.status);
		const skills = store.list(statusFilter ? { status: statusFilter } : undefined);
		if (useJson) jsonOutput(skills.map(toRow));
		else printSkillTable(skills);
	} finally {
		store.close();
	}
}

/** `agentplate skill show <slug>` — print a skill's full skill.md. */
export function runShow(slug: string, useJson: boolean): void {
	const root = requireInit();
	const store = createSkillStore(root);
	try {
		const skill = store.get(slug);
		if (skill === null) throw new NotFoundError(`Skill "${slug}" not found`);
		if (useJson) jsonOutput(skill);
		else printInfo(serializeSkillMd(skill).trimEnd());
	} finally {
		store.close();
	}
}

/** Options accepted by `agentplate skill search`. */
export interface SearchOptions {
	files?: string[];
	capability?: string;
	json?: boolean;
}

/**
 * `agentplate skill search <query>` — rank skills for a task description the way
 * agent retrieval does. The query plays the spawn's task text, `--files` its
 * file scope and `--capability` its capability; scores and order come from the
 * shared {@link rankSkills}, so every listed skill is one an agent with that
 * context would get (in full or as a summary). Active skills that fail the
 * safety scrub are reported as warnings in table mode.
 */
export function runSearch(query: string, opts: SearchOptions, useJson: boolean): void {
	const root = requireInit();
	const store = createSkillStore(root);
	try {
		const { ranked, rejected } = rankSkills(store.list(), {
			taskText: query,
			capability: opts.capability ?? "",
			fileScope: opts.files ?? [],
		});
		if (useJson) {
			jsonOutput(ranked.map((r) => ({ ...toRow(r.skill), score: r.score })));
			return;
		}
		for (const r of rejected) {
			printWarning(
				`${r.slug} is never injected: it fails the safety scrub (${r.violations.join("; ")})`,
			);
		}
		if (ranked.length === 0) {
			printInfo(muted("(no matching skills)"));
			return;
		}
		for (const { skill, score } of ranked) {
			printInfo(
				`${brand(pad(skill.slug, 28))}  ${muted(`score ${score.toFixed(3)}`)}  ${skill.title}`,
			);
			if (skill.goal !== "") printInfo(muted(`    ${skill.goal}`));
		}
	} finally {
		store.close();
	}
}

/** Options accepted by `agentplate skill record`. */
export interface RecordOptions {
	stdin?: boolean;
	dryRun?: boolean;
	json?: boolean;
}

/**
 * `agentplate skill record --stdin` — read a JSON {@link SkillDraft} from stdin, scrub
 * it via {@link sanitizeSkillDraft}, and (unless `--dry-run`) upsert it with
 * operator provenance. This is the manual distillation path and the Stop-hook
 * target. A `skip` draft (or one downgraded to skip by a fatal safety violation)
 * never writes. With `skills.requireReview` on, the write lands as a `draft`
 * that `agentplate skill approve` must activate, as distilled skills do.
 *
 * `readStdin` is injected so tests can supply a draft string without a real pipe.
 */
export async function runRecord(
	opts: RecordOptions,
	useJson: boolean,
	readStdin: () => Promise<string> = () => Bun.stdin.text(),
): Promise<void> {
	if (!opts.stdin) {
		throw new ValidationError(
			"`agentplate skill record` requires --stdin (pipe a JSON SkillDraft)",
		);
	}
	const root = requireInit();
	const requireReview = loadConfig(root).skills.requireReview === true;
	const store = createSkillStore(root, { requireReview });
	try {
		const draft = parseDraft(await readStdin());
		const report = sanitizeSkillDraft(draft);

		// A skip draft, or a fatal safety violation that forces a skip, writes nothing.
		const effectiveAction = report.ok ? report.redactedDraft.action : "skip";

		if (opts.dryRun) {
			const plan =
				effectiveAction === "skip"
					? "skip (no write)"
					: effectiveAction === "update"
						? `update "${report.redactedDraft.targetSlug ?? "?"}"`
						: `create "${report.redactedDraft.title ?? "?"}"`;
			if (useJson) {
				jsonOutput({
					dryRun: true,
					plan: effectiveAction,
					ok: report.ok,
					violations: report.violations,
				});
			} else {
				printInfo(`${accent("dry-run")} would ${plan}`);
				for (const v of report.violations) printWarning(v);
			}
			return;
		}

		if (effectiveAction === "skip") {
			if (useJson) {
				jsonOutput({ action: "skipped", ok: report.ok, violations: report.violations });
			} else {
				printWarning(report.ok ? "Draft action was 'skip' — nothing recorded." : "Draft skipped:");
				for (const v of report.violations) printWarning(v);
			}
			return;
		}

		const result = store.upsert(report.redactedDraft, { ...OPERATOR_PROVENANCE });
		if (useJson) {
			jsonOutput({ action: result.action, skill: result.skill, violations: report.violations });
		} else {
			printSuccess(
				`${result.action === "created" ? "Created" : "Updated"} skill ${result.skill.slug}`,
			);
			if (result.skill.status === "draft") {
				printInfo(muted(reviewHint(result.skill.slug)));
			}
			for (const v of report.violations) printWarning(v);
		}
	} finally {
		store.close();
	}
}

/** Options accepted by `agentplate skill outcome`. */
export interface OutcomeOptions {
	status: string;
	note?: string;
	json?: boolean;
}

/** `agentplate skill outcome <slug> --status …` — append an outcome and recompute confidence. */
export function runOutcome(slug: string, opts: OutcomeOptions, useJson: boolean): void {
	const root = requireInit();
	const store = createSkillStore(root);
	try {
		const status = parseOutcomeStatus(opts.status);
		const updated = store.appendOutcome(slug, {
			status,
			agent: "operator",
			taskId: null,
			gates: null,
			ts: new Date().toISOString(),
			...(opts.note !== undefined ? { note: opts.note } : {}),
		});
		if (useJson) jsonOutput(toRow(updated));
		else
			printSuccess(
				`Recorded ${status} for ${slug} (confidence ${formatConfidence(updated.confidence)}, ${formatTrack(updated)})`,
			);
	} finally {
		store.close();
	}
}

/** Options accepted by `agentplate skill prune`. */
export interface PruneOptions {
	dryRun?: boolean;
	force?: boolean;
	maxAgeDays?: string;
	json?: boolean;
}

/**
 * `agentplate skill prune` — remove quarantined skills older than the max-age window.
 *
 * The age window defaults to `config.skills.prune.maxAgeDays` and may be
 * overridden with `--max-age-days`. Only `quarantined` skills are eligible (active
 * and deprecated skills are never auto-deleted). The default is a DRY RUN that
 * merely lists the candidates; an actual delete requires `--force` (and is
 * suppressed by `--dry-run` even if `--force` is also passed).
 */
export function runPrune(opts: PruneOptions, useJson: boolean): void {
	const root = requireInit();
	const config = loadConfig(root);
	const store = createSkillStore(root);
	try {
		const maxAgeDays =
			opts.maxAgeDays !== undefined ? Number(opts.maxAgeDays) : config.skills.prune.maxAgeDays;
		if (!Number.isFinite(maxAgeDays) || maxAgeDays < 0) {
			throw new ValidationError(`Invalid --max-age-days "${opts.maxAgeDays}" (expected >= 0)`);
		}

		const cutoffMs = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
		const candidates = store
			.list({ status: "quarantined" })
			.filter((skill) => isOlderThan(skill.updatedAt, cutoffMs));

		// Dry run unless --force is given (and --dry-run always wins).
		const willRemove = opts.force === true && opts.dryRun !== true;

		if (willRemove) {
			for (const skill of candidates) store.remove(skill.slug);
		}

		const slugs = candidates.map((s) => s.slug);
		if (useJson) {
			jsonOutput({ removed: willRemove, maxAgeDays, candidates: slugs });
			return;
		}
		if (candidates.length === 0) {
			printInfo(muted("(no quarantined skills past the max-age window)"));
			return;
		}
		if (willRemove) {
			printSuccess(`Pruned ${candidates.length} skill(s): ${slugs.join(", ")}`);
		} else {
			printInfo(`${accent("dry-run")} ${candidates.length} candidate(s) (pass --force to delete):`);
			for (const slug of slugs) printInfo(muted(`    ${slug}`));
		}
	} finally {
		store.close();
	}
}

/**
 * Is an ISO timestamp strictly older than `cutoffMs`? An unparseable/empty
 * timestamp is treated as NOT old (we never delete a skill whose age we can't
 * establish), keeping prune conservative.
 */
function isOlderThan(iso: string, cutoffMs: number): boolean {
	const t = Date.parse(iso);
	if (Number.isNaN(t)) return false;
	return t < cutoffMs;
}

/** The next step for a skill written as a draft under `skills.requireReview`. */
function reviewHint(slug: string): string {
	return `    draft (skills.requireReview): review with \`agentplate skill show ${slug}\`, then run \`agentplate skill approve ${slug}\``;
}

/**
 * `agentplate skill reindex` — deprecated no-op, kept so existing scripts keep
 * working. It used to rebuild an FTS index that nothing read; skills are now
 * read straight from their files. It still reads every skill (warning about any
 * malformed file) and reports how many it read.
 */
export function runReindex(useJson: boolean): void {
	const root = requireInit();
	const store = createSkillStore(root);
	try {
		const count = store.list().length;
		if (useJson) jsonOutput({ reindexed: count, deprecated: true });
		else {
			printWarning("`agentplate skill reindex` is deprecated: there is no index to rebuild.");
			printInfo(muted(`Read ${count} skill(s) from .agentplate/skills/`));
		}
	} finally {
		store.close();
	}
}

/**
 * `agentplate skill approve <slug>` — make a `draft` skill `active` so retrieval
 * starts injecting it. Drafts are written while `skills.requireReview` is on.
 * Approving an already-active skill is a no-op; a deprecated or quarantined
 * skill is refused (that is `skill restore`'s job), so approve never brings
 * back a retired skill by accident.
 */
export function runApprove(slug: string, useJson: boolean): void {
	const root = requireInit();
	const store = createSkillStore(root);
	try {
		const skill = store.get(slug);
		if (skill === null) throw new NotFoundError(`Skill "${slug}" not found`);
		if (skill.status === "deprecated" || skill.status === "quarantined") {
			throw new ValidationError(
				`Skill "${slug}" is ${skill.status}, not a draft. Use \`agentplate skill restore ${slug}\` to reactivate it.`,
			);
		}
		const changed = skill.status === "draft";
		if (changed) store.setStatus(slug, "active");
		if (useJson) jsonOutput({ slug, status: "active", changed });
		else if (changed) printSuccess(`Approved ${slug} (draft → active)`);
		else printInfo(muted(`${slug} is already active`));
	} finally {
		store.close();
	}
}

/** `agentplate skill deprecate|restore <slug>` — flip a skill's lifecycle status. */
export function runSetStatus(slug: string, status: SkillStatus, useJson: boolean): void {
	const root = requireInit();
	const store = createSkillStore(root);
	try {
		// setStatus throws NotFoundError for a missing slug; surface that as-is.
		store.setStatus(slug, status);
		if (useJson) jsonOutput({ slug, status });
		else printSuccess(`Set ${slug} → ${status}`);
	} finally {
		store.close();
	}
}

// ---------------------------------------------------------------------------
// Command wiring
// ---------------------------------------------------------------------------

function listCommand(): Command {
	return new Command("list")
		.description("List skills (slug, title, confidence, applied/success, status)")
		.option("--status <status>", "filter by lifecycle status (active|draft|deprecated|quarantined)")
		.option("--json", "output JSON")
		.action((opts: ListOptions, command: Command) => {
			runList(opts, wantsJson(command));
		});
}

function showCommand(): Command {
	return new Command("show")
		.description("Print a skill's full skill.md")
		.argument("<slug>", "skill slug")
		.option("--json", "output JSON")
		.action((slug: string, _opts: { json?: boolean }, command: Command) => {
			runShow(slug, wantsJson(command));
		});
}

function searchCommand(): Command {
	return new Command("search")
		.description(
			"Rank skills for a task description exactly as agent retrieval would (+ optional --files)",
		)
		.argument("<query>", "task description to rank against")
		.option("--files <path...>", "the agent's file scope (the paths given to `sling --files`)")
		.option("--capability <capability>", "the agent's capability (e.g. builder)")
		.option("--json", "output JSON")
		.action((query: string, opts: SearchOptions, command: Command) => {
			runSearch(query, opts, wantsJson(command));
		});
}

function recordCommand(): Command {
	return new Command("record")
		.description("Record a skill from a JSON SkillDraft piped on stdin")
		.option("--stdin", "read the draft from stdin (required)")
		.option("--dry-run", "show what would happen without writing")
		.option("--json", "output JSON")
		.action(async (opts: RecordOptions, command: Command) => {
			await runRecord(opts, wantsJson(command));
		});
}

function outcomeCommand(): Command {
	return new Command("outcome")
		.description("Append a success/partial/failure outcome to a skill")
		.argument("<slug>", "skill slug")
		.requiredOption("--status <status>", "success | partial | failure")
		.option("--note <text>", "optional note for the outcome line")
		.option("--json", "output JSON")
		.action((slug: string, opts: OutcomeOptions, command: Command) => {
			runOutcome(slug, opts, wantsJson(command));
		});
}

function pruneCommand(): Command {
	return new Command("prune")
		.description("Remove quarantined skills past the max-age window (dry-run by default)")
		.option("--dry-run", "list candidates without deleting (default behavior)")
		.option("--force", "actually delete the candidates")
		.option("--max-age-days <n>", "override config.skills.prune.maxAgeDays")
		.option("--json", "output JSON")
		.action((opts: PruneOptions, command: Command) => {
			runPrune(opts, wantsJson(command));
		});
}

function reindexCommand(): Command {
	return new Command("reindex")
		.description("Deprecated no-op: skills are read straight from their files")
		.option("--json", "output JSON")
		.action((_opts: { json?: boolean }, command: Command) => {
			runReindex(wantsJson(command));
		});
}

function approveCommand(): Command {
	return new Command("approve")
		.description("Approve a draft skill so agents start receiving it (see skills.requireReview)")
		.argument("<slug>", "skill slug")
		.option("--json", "output JSON")
		.action((slug: string, _opts: { json?: boolean }, command: Command) => {
			runApprove(slug, wantsJson(command));
		});
}

function deprecateCommand(): Command {
	return new Command("deprecate")
		.description("Mark a skill deprecated (excluded from retrieval)")
		.argument("<slug>", "skill slug")
		.option("--json", "output JSON")
		.action((slug: string, _opts: { json?: boolean }, command: Command) => {
			runSetStatus(slug, "deprecated", wantsJson(command));
		});
}

function restoreCommand(): Command {
	return new Command("restore")
		.description("Restore a deprecated/quarantined skill to active")
		.argument("<slug>", "skill slug")
		.option("--json", "output JSON")
		.action((slug: string, _opts: { json?: boolean }, command: Command) => {
			runSetStatus(slug, "active", wantsJson(command));
		});
}

/** Build the `agentplate skill` command tree. */
export function createSkillCommand(): Command {
	return new Command("skill")
		.description("Operate on the self-improving skill library")
		.addCommand(listCommand())
		.addCommand(showCommand())
		.addCommand(searchCommand())
		.addCommand(recordCommand())
		.addCommand(outcomeCommand())
		.addCommand(pruneCommand())
		.addCommand(approveCommand())
		.addCommand(deprecateCommand())
		.addCommand(restoreCommand())
		.addCommand(reindexCommand(), { hidden: true });
}

// Re-export the store type so test files importing this module get a single
// surface for the store handle they assert against.
export type { SkillStore };
