/**
 * Skill store tests.
 *
 * Real implementations throughout: a real temp `.agentplate/` tree on disk and the
 * real bun:sqlite FTS index (no mocks). Each test gets a fresh temp root so
 * directory-per-skill state never leaks between cases.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AGENTPLATE_DIR } from "../config.ts";
import { NotFoundError, ValidationError } from "../errors.ts";
import {
	createSkillStore,
	parseSkillMd,
	type SkillStore,
	serializeSkillMd,
	slugify,
} from "./store.ts";
import type { Skill, SkillDraft, SkillOutcome, SkillProvenance } from "./types.ts";

const PROVENANCE: SkillProvenance = { taskId: "task-1", agent: "builder-a", commit: "abc123" };

function createDraft(overrides: Partial<SkillDraft> = {}): SkillDraft {
	return {
		action: "create",
		title: "Add a CLI Subcommand",
		goal: "Register a new subcommand on the Commander program",
		whenToUse: ["adding a new ap command", "wiring an action handler"],
		filePatterns: ["src/commands/*.ts", "src/index.ts"],
		tags: ["cli", "commander"],
		body: "## Steps\n\n1. Create src/commands/foo.ts\n2. Register it in index.ts\n",
		...overrides,
	};
}

function outcome(
	status: SkillOutcome["status"],
	overrides: Partial<SkillOutcome> = {},
): SkillOutcome {
	return {
		status,
		agent: "builder-a",
		taskId: "task-1",
		gates: status,
		ts: new Date().toISOString(),
		...overrides,
	};
}

describe("slugify", () => {
	test("lowercases and kebab-cases", () => {
		expect(slugify("Add a CLI Subcommand")).toBe("add-a-cli-subcommand");
	});

	test("strips unsafe characters", () => {
		expect(slugify("Fix: the @Thing! (now)")).toBe("fix-the-thing-now");
	});

	test("collapses repeated dashes and trims edges", () => {
		expect(slugify("  --Hello___World--  ")).toBe("hello-world");
	});

	test("strips accents via normalization", () => {
		expect(slugify("Café Déjà Vu")).toBe("cafe-deja-vu");
	});

	test("falls back to 'skill' when nothing survives", () => {
		expect(slugify("!!!")).toBe("skill");
		expect(slugify("")).toBe("skill");
	});

	test("is idempotent on already-slugged input", () => {
		const s = slugify("Some Title Here");
		expect(slugify(s)).toBe(s);
	});
});

describe("parseSkillMd / serializeSkillMd", () => {
	function sampleSkill(): Skill {
		return {
			id: "11111111-2222-3333-4444-555555555555",
			slug: "add-a-cli-subcommand",
			title: "Add a CLI Subcommand",
			version: 3,
			status: "active",
			goal: "Register a new subcommand",
			whenToUse: ["adding a command", "wiring a handler"],
			filePatterns: ["src/commands/*.ts"],
			tags: ["cli"],
			created: "2026-05-31T10:00:00.000Z",
			updatedAt: "2026-05-31T12:00:00.000Z",
			distilledFrom: { taskId: "t-1", agent: "builder", commit: "deadbeef" },
			relatesTo: ["another-skill"],
			supersedes: [],
			body: "## Steps\n\n1. Do the thing\n2. Verify it\n\n## Gotchas\n\n- Watch the colon",
			confidence: 0.42,
			appliedCount: 5,
			successCount: 3.5,
			lastOutcome: "partial",
		};
	}

	test("round-trips a fully-populated skill", () => {
		const original = sampleSkill();
		const reparsed = parseSkillMd(serializeSkillMd(original));
		expect(reparsed).toEqual(original);
	});

	test("serialized form has fenced frontmatter, a blank line, then the body", () => {
		const text = serializeSkillMd(sampleSkill());
		expect(text.startsWith("---\n")).toBe(true);
		// Frontmatter fence closes, then exactly one blank line precedes the body.
		expect(text).toContain("---\n\n## Steps");
		// Body is present verbatim (including a line containing a colon).
		expect(text).toContain("- Watch the colon");
	});

	test("frontmatter keys are emitted in canonical order", () => {
		const text = serializeSkillMd(sampleSkill());
		const idIdx = text.indexOf("id:");
		const titleIdx = text.indexOf("title:");
		const statusIdx = text.indexOf("status:");
		const bodyIdx = text.indexOf("## Steps");
		expect(idIdx).toBeGreaterThanOrEqual(0);
		expect(idIdx).toBeLessThan(titleIdx);
		expect(titleIdx).toBeLessThan(statusIdx);
		expect(statusIdx).toBeLessThan(bodyIdx);
	});

	test("omits distilledFrom from frontmatter when absent", () => {
		const skill = sampleSkill();
		skill.distilledFrom = undefined;
		const text = serializeSkillMd(skill);
		expect(text).not.toContain("distilledFrom");
		const reparsed = parseSkillMd(text);
		expect(reparsed.distilledFrom).toBeUndefined();
	});

	test("tolerates missing optional arrays (defaults to [])", () => {
		const text = ["---", "id: x1", "slug: minimal", "title: Minimal", "---", "", "Body here"].join(
			"\n",
		);
		const skill = parseSkillMd(text);
		expect(skill.whenToUse).toEqual([]);
		expect(skill.filePatterns).toEqual([]);
		expect(skill.tags).toEqual([]);
		expect(skill.relatesTo).toEqual([]);
		expect(skill.supersedes).toEqual([]);
		expect(skill.body).toBe("Body here");
		expect(skill.version).toBe(1);
		expect(skill.status).toBe("active");
		expect(skill.confidence).toBe(0);
		expect(skill.lastOutcome).toBeNull();
	});

	test("a multi-paragraph body survives round-trip including trailing structure", () => {
		const skill = sampleSkill();
		skill.body = "Para one.\n\nPara two with a list:\n- a\n- b\n\nFinal line.";
		const reparsed = parseSkillMd(serializeSkillMd(skill));
		expect(reparsed.body).toBe(skill.body);
	});

	test("throws on non-mapping frontmatter", () => {
		const text = "---\n- just\n- a\n- list\n---\n\nbody";
		expect(() => parseSkillMd(text)).toThrow(ValidationError);
	});
});

describe("createSkillStore", () => {
	let root: string;
	let store: SkillStore;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "agentplate-skills-"));
		store = createSkillStore(root);
	});

	afterEach(() => {
		store.close();
		rmSync(root, { recursive: true, force: true });
	});

	test("upsert(create) writes a skill directory and returns action 'created'", () => {
		const { action, skill } = store.upsert(createDraft(), PROVENANCE);
		expect(action).toBe("created");
		expect(skill.slug).toBe("add-a-cli-subcommand");
		expect(skill.version).toBe(1);
		expect(skill.status).toBe("active");
		expect(skill.confidence).toBe(0);
		expect(skill.appliedCount).toBe(0);
		expect(skill.successCount).toBe(0);
		expect(skill.lastOutcome).toBeNull();
		expect(skill.distilledFrom).toEqual(PROVENANCE);
		expect(skill.created).not.toBe("");
		expect(skill.updatedAt).toBe(skill.created);

		// On-disk layout matches the contract.
		const dir = join(root, AGENTPLATE_DIR, "skills", skill.slug);
		expect(existsSync(join(dir, "skill.md"))).toBe(true);
	});

	test("get returns the stored skill and null for a missing slug", () => {
		store.upsert(createDraft(), PROVENANCE);
		const got = store.get("add-a-cli-subcommand");
		expect(got).not.toBeNull();
		expect(got?.title).toBe("Add a CLI Subcommand");
		expect(got?.whenToUse).toEqual(["adding a new ap command", "wiring an action handler"]);
		expect(store.get("does-not-exist")).toBeNull();
	});

	test("get reads back exactly what was written (frontmatter round-trip)", () => {
		const { skill } = store.upsert(createDraft(), PROVENANCE);
		const got = store.get(skill.slug);
		expect(got).toEqual(skill);
	});

	test("list returns all skills and filters by status", () => {
		store.upsert(createDraft({ title: "First Skill" }), PROVENANCE);
		store.upsert(createDraft({ title: "Second Skill" }), PROVENANCE);
		store.upsert(createDraft({ title: "Third Skill" }), PROVENANCE);

		expect(store.list().length).toBe(3);

		store.setStatus("second-skill", "deprecated");
		const active = store.list({ status: "active" });
		expect(active.map((s) => s.slug).sort()).toEqual(["first-skill", "third-skill"]);
		const deprecated = store.list({ status: "deprecated" });
		expect(deprecated.length).toBe(1);
		expect(deprecated[0]?.slug).toBe("second-skill");
	});

	test("list on a fresh store is empty (no skills dir yet)", () => {
		expect(store.list()).toEqual([]);
	});

	test("create then create same title yields a unique slug (no collision)", () => {
		const a = store.upsert(createDraft({ title: "Same Name" }), PROVENANCE);
		const b = store.upsert(createDraft({ title: "Same Name" }), PROVENANCE);
		expect(a.skill.slug).toBe("same-name");
		expect(b.skill.slug).toBe("same-name-2");
		expect(store.list().length).toBe(2);
	});

	test("upsert(update) bumps version, applies fields, and preserves outcomes.jsonl", () => {
		const { skill } = store.upsert(createDraft(), PROVENANCE);
		const slug = skill.slug;

		// Record some history first.
		store.appendOutcome(slug, outcome("success"));
		store.appendOutcome(slug, outcome("partial"));

		const updateDraft: SkillDraft = {
			action: "update",
			targetSlug: slug,
			title: "Add a CLI Subcommand (revised)",
			goal: "Updated goal",
			body: "## New body\n\nrevised steps",
		};
		const newProv: SkillProvenance = { taskId: "task-9", agent: "builder-b", commit: "999" };
		const { action, skill: updated } = store.upsert(updateDraft, newProv);

		expect(action).toBe("updated");
		expect(updated.version).toBe(2);
		expect(updated.title).toBe("Add a CLI Subcommand (revised)");
		expect(updated.goal).toBe("Updated goal");
		expect(updated.body).toBe("## New body\n\nrevised steps");
		expect(updated.distilledFrom).toEqual(newProv);
		// Fields not in the draft are preserved.
		expect(updated.filePatterns).toEqual(skill.filePatterns);
		expect(updated.created).toBe(skill.created);

		// Outcomes were preserved, so derived counts survive the version bump.
		expect(updated.appliedCount).toBe(2);
		expect(updated.successCount).toBe(1.5);
		expect(updated.lastOutcome).toBe("partial");

		// The on-disk JSONL still has both lines.
		const jsonl = readFileSync(
			join(root, AGENTPLATE_DIR, "skills", slug, "outcomes.jsonl"),
			"utf8",
		).trim();
		expect(jsonl.split("\n").length).toBe(2);
	});

	test("upsert(update) on a missing target throws NotFoundError", () => {
		expect(() => store.upsert({ action: "update", targetSlug: "nope" }, PROVENANCE)).toThrow(
			NotFoundError,
		);
	});

	test("upsert(update) without targetSlug throws ValidationError", () => {
		expect(() => store.upsert({ action: "update" }, PROVENANCE)).toThrow(ValidationError);
	});

	test("upsert(skip) throws ValidationError (never writes)", () => {
		expect(() => store.upsert({ action: "skip" }, PROVENANCE)).toThrow(ValidationError);
		expect(store.list()).toEqual([]);
	});

	test("upsert(create) without a title throws ValidationError", () => {
		expect(() => store.upsert({ action: "create" }, PROVENANCE)).toThrow(ValidationError);
		expect(() => store.upsert({ action: "create", title: "   " }, PROVENANCE)).toThrow(
			ValidationError,
		);
	});

	test("appendOutcome updates counts/confidence and persists to frontmatter", () => {
		const { skill } = store.upsert(createDraft(), PROVENANCE);
		const slug = skill.slug;

		const afterFirst = store.appendOutcome(slug, outcome("success"));
		expect(afterFirst.appliedCount).toBe(1);
		expect(afterFirst.successCount).toBe(1);
		expect(afterFirst.lastOutcome).toBe("success");
		expect(afterFirst.confidence).toBeGreaterThan(0);
		expect(afterFirst.confidence).toBeLessThanOrEqual(1);

		const afterSecond = store.appendOutcome(slug, outcome("failure"));
		expect(afterSecond.appliedCount).toBe(2);
		expect(afterSecond.successCount).toBe(1);
		expect(afterSecond.lastOutcome).toBe("failure");

		const afterThird = store.appendOutcome(slug, outcome("partial"));
		expect(afterThird.appliedCount).toBe(3);
		expect(afterThird.successCount).toBe(1.5);
		expect(afterThird.lastOutcome).toBe("partial");

		// A fresh get() (re-parsing skill.md) sees the persisted derived fields.
		const reloaded = store.get(slug);
		expect(reloaded?.appliedCount).toBe(3);
		expect(reloaded?.successCount).toBe(1.5);
		expect(reloaded?.lastOutcome).toBe("partial");
		expect(reloaded?.confidence).toBeCloseTo(afterThird.confidence, 10);

		// And the raw frontmatter actually carries the numbers (not just runtime state).
		const md = readFileSync(join(root, AGENTPLATE_DIR, "skills", slug, "skill.md"), "utf8");
		expect(md).toContain("appliedCount: 3");
		expect(md).toContain("successCount: 1.5");
		expect(md).toContain("lastOutcome: partial");
	});

	test("confidence rises with more successes for the same applied count trend", () => {
		const a = store.upsert(createDraft({ title: "Skill A" }), PROVENANCE).skill;
		const b = store.upsert(createDraft({ title: "Skill B" }), PROVENANCE).skill;

		// A: 5/5 successes. B: 1 success then 4 failures.
		for (let i = 0; i < 5; i++) store.appendOutcome(a.slug, outcome("success"));
		store.appendOutcome(b.slug, outcome("success"));
		for (let i = 0; i < 4; i++) store.appendOutcome(b.slug, outcome("failure"));

		const reA = store.get(a.slug);
		const reB = store.get(b.slug);
		expect(reA?.confidence ?? 0).toBeGreaterThan(reB?.confidence ?? 1);
	});

	test("appendOutcome on a missing skill throws NotFoundError", () => {
		expect(() => store.appendOutcome("ghost", outcome("success"))).toThrow(NotFoundError);
	});

	test("setStatus rewrites frontmatter status and bumps updatedAt", () => {
		const { skill } = store.upsert(createDraft(), PROVENANCE);
		expect(skill.status).toBe("active");

		store.setStatus(skill.slug, "quarantined");
		const reloaded = store.get(skill.slug);
		expect(reloaded?.status).toBe("quarantined");

		const md = readFileSync(join(root, AGENTPLATE_DIR, "skills", skill.slug, "skill.md"), "utf8");
		expect(md).toContain("status: quarantined");
	});

	test("setStatus on a missing skill throws NotFoundError", () => {
		expect(() => store.setStatus("ghost", "deprecated")).toThrow(NotFoundError);
	});

	test("remove deletes the directory and drops it from list", () => {
		const { skill } = store.upsert(createDraft(), PROVENANCE);
		store.appendOutcome(skill.slug, outcome("success"));
		expect(existsSync(join(root, AGENTPLATE_DIR, "skills", skill.slug))).toBe(true);

		store.remove(skill.slug);
		expect(existsSync(join(root, AGENTPLATE_DIR, "skills", skill.slug))).toBe(false);
		expect(store.get(skill.slug)).toBeNull();
		expect(store.list()).toEqual([]);
	});

	test("remove is a no-op for a non-existent slug", () => {
		expect(() => store.remove("never-existed")).not.toThrow();
	});

	test("reindex returns the number of skills indexed", () => {
		store.upsert(createDraft({ title: "One" }), PROVENANCE);
		store.upsert(createDraft({ title: "Two" }), PROVENANCE);
		store.upsert(createDraft({ title: "Three" }), PROVENANCE);

		expect(store.reindex()).toBe(3);

		// After removing one, a rebuild reflects the new count.
		store.remove("two");
		expect(store.reindex()).toBe(2);
	});

	test("reindex on an empty store returns 0", () => {
		expect(store.reindex()).toBe(0);
	});

	test("a reindexed store survives reopen (index is rebuildable from files)", () => {
		store.upsert(createDraft({ title: "Persistent Skill" }), PROVENANCE);
		store.close();

		// Reopen against the same root and rebuild from the on-disk skill.md files.
		const reopened = createSkillStore(root);
		try {
			expect(reopened.reindex()).toBe(1);
			expect(reopened.get("persistent-skill")?.title).toBe("Persistent Skill");
		} finally {
			reopened.close();
			// Re-point the outer store so afterEach's close() is harmless.
			store = createSkillStore(root);
		}
	});
});
