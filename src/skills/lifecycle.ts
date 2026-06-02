/**
 * Skills lifecycle glue — the two integration points that close the learning
 * loop, kept out of the command files so `sling`/`log` stay thin.
 *
 *  - {@link retrieveSkillsForSpawn}: at spawn, select relevant skills, persist an
 *    `applied-skills.json` record, and return the overlay markdown block.
 *  - {@link runSkillFeedbackAndDistill}: at session-end, append outcomes to the
 *    applied skills (evolving confidence) and — when gates passed — distill a new
 *    or updated skill from the diff.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { appliedSkillsPath } from "../paths.ts";
import type { AgentRuntime } from "../runtimes/types.ts";
import type { OutcomeStatus, SkillsConfig } from "../types.ts";
import { distillSkill } from "./distiller.ts";
import { selectSkills } from "./retrieval.ts";
import { createSkillStore } from "./store.ts";
import type { AppliedSkillsRecord } from "./types.ts";

export interface RetrieveSpawnArgs {
	root: string;
	agentName: string;
	capability: string;
	taskId: string;
	fileScope: string[];
	taskText: string;
	skills: SkillsConfig;
}

/**
 * Select skills for a spawning agent. Returns the overlay markdown to inject
 * (empty string when skills are disabled or none match) and writes the
 * `applied-skills.json` record the feedback step consumes.
 */
export function retrieveSkillsForSpawn(args: RetrieveSpawnArgs): string {
	if (!args.skills.enabled) return "";
	const store = createSkillStore(args.root);
	try {
		const all = store.list({ status: "active" });
		if (all.length === 0) return "";
		const result = selectSkills(all, {
			fileScope: args.fileScope,
			taskText: args.taskText,
			capability: args.capability,
			budgetChars: args.skills.retrieval.budgetChars,
			maxFull: args.skills.retrieval.maxFull,
		});

		const record: AppliedSkillsRecord = {
			taskId: args.taskId,
			agent: args.agentName,
			capability: args.capability,
			skills: [
				...result.full.map((r) => ({
					id: r.skill.id,
					slug: r.skill.slug,
					injected: "full" as const,
				})),
				...result.summarized.map((r) => ({
					id: r.skill.id,
					slug: r.skill.slug,
					injected: "summary" as const,
				})),
			],
		};
		if (record.skills.length > 0) {
			const path = appliedSkillsPath(args.root, args.agentName);
			mkdirSync(dirname(path), { recursive: true });
			writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`, "utf8");
		}
		return result.overlayMarkdown;
	} finally {
		store.close();
	}
}

export interface FeedbackDistillArgs {
	root: string;
	agentName: string;
	capability: string;
	taskId: string | null;
	worktreePath: string;
	baseRef: string;
	runtime: AgentRuntime;
	/** Quality-gate status for the session (null when no gates ran). */
	outcomeStatus: OutcomeStatus | null;
	skills: SkillsConfig;
	model?: string;
}

export interface FeedbackDistillResult {
	outcomesAppended: number;
	distill: { action: "created" | "updated" | "skipped"; slug?: string };
}

/**
 * Session-end: append the session's outcome to each applied skill (evolving its
 * confidence), then — when enabled and gates passed — distill a skill from the
 * work. Best-effort: never throws into the caller's hook path.
 */
export async function runSkillFeedbackAndDistill(
	args: FeedbackDistillArgs,
): Promise<FeedbackDistillResult> {
	const result: FeedbackDistillResult = {
		outcomesAppended: 0,
		distill: { action: "skipped" },
	};
	if (!args.skills.enabled) return result;

	const store = createSkillStore(args.root);
	try {
		// 1. Feedback: append the session outcome to every applied skill. Capture
		//    the applied slugs first (the record file is removed afterward, but the
		//    distiller still needs them to target an UPDATE).
		const appliedSlugs = readAppliedSlugs(args.root, args.agentName);
		const appliedPath = appliedSkillsPath(args.root, args.agentName);
		if (existsSync(appliedPath)) {
			const status: OutcomeStatus = args.outcomeStatus ?? "partial";
			const ts = new Date().toISOString();
			for (const slug of appliedSlugs) {
				if (!store.get(slug)) continue;
				store.appendOutcome(slug, {
					status,
					agent: args.agentName,
					taskId: args.taskId,
					gates: args.outcomeStatus,
					ts,
					note: `Applied by ${args.capability} ${args.agentName}`,
				});
				result.outcomesAppended++;
			}
			rmSync(appliedPath, { force: true });
		}

		// 2. Distill: only from work that passed its gates (when configured).
		const gatesOk = !args.skills.distill.onlyOnGatesPass || args.outcomeStatus === "success";
		if (gatesOk) {
			result.distill = await distillSkill({
				store,
				runtime: args.runtime,
				root: args.root,
				worktreePath: args.worktreePath,
				baseRef: args.baseRef,
				taskId: args.taskId,
				agentName: args.agentName,
				capability: args.capability,
				appliedSlugs,
				model: args.skills.distill.model ?? args.model,
			});
		}
		return result;
	} finally {
		store.close();
	}
}

/** Read the applied-skill slugs recorded at spawn (empty when absent/corrupt). */
function readAppliedSlugs(root: string, agentName: string): string[] {
	const path = appliedSkillsPath(root, agentName);
	if (!existsSync(path)) return [];
	try {
		const record = JSON.parse(readFileSync(path, "utf8")) as AppliedSkillsRecord;
		return record.skills.map((s) => s.slug);
	} catch {
		return [];
	}
}
