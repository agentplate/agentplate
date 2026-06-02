/**
 * `agentplate skill` command tests.
 *
 * Real implementations throughout (no mocks): a real temp `.agentplate/` tree with a
 * real `config.yaml` so `loadConfig`/`isInitialized` work, and the real bun:sqlite
 * skill store. The command actions resolve the project root via
 * `findProjectRoot()`, which honors `setProjectRootOverride`, so each test points
 * Agentplate at its own temp root and drives the exported action functions directly
 * (the CLI's index.ts does not register `skill` yet). `runRecord` accepts an
 * injected stdin reader so a draft can be supplied without a real pipe.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	AGENTPLATE_DIR,
	CONFIG_FILE,
	DEFAULT_CONFIG,
	serializeConfig,
	setProjectRootOverride,
} from "../config.ts";
import { NotFoundError, ValidationError } from "../errors.ts";
import { createSkillStore, parseSkillMd, serializeSkillMd } from "../skills/store.ts";
import type { Skill, SkillDraft } from "../skills/types.ts";
import {
	createSkillCommand,
	parseDraft,
	rankSkills,
	runList,
	runOutcome,
	runPrune,
	runRecord,
	runSetStatus,
	scoreSkill,
} from "./skill.ts";

// --- temp-root harness ----------------------------------------------------

let root: string;

/** Create an initialized temp project root and point Agentplate at it. */
function initRoot(): string {
	const dir = mkdtempSync(join(tmpdir(), "agentplate-skill-cmd-"));
	mkdirSync(join(dir, AGENTPLATE_DIR), { recursive: true });
	// isInitialized() checks for .agentplate/config.yaml; write a valid one so
	// loadConfig (used by `prune`) resolves without throwing.
	writeFileSync(join(dir, AGENTPLATE_DIR, CONFIG_FILE), serializeConfig(DEFAULT_CONFIG), "utf8");
	return dir;
}

beforeEach(() => {
	root = initRoot();
	setProjectRootOverride(root);
});

afterEach(() => {
	setProjectRootOverride(null);
	rmSync(root, { recursive: true, force: true });
});

/** Seed a skill straight through the store (bypassing the command surface). */
function seed(draft: Partial<SkillDraft> = {}): Skill {
	const store = createSkillStore(root);
	try {
		return store.upsert(
			{
				action: "create",
				title: "Add a CLI Subcommand",
				goal: "Register a new subcommand on the Commander program",
				whenToUse: ["adding a new agentplate command"],
				filePatterns: ["src/commands/*.ts"],
				tags: ["cli", "commander"],
				body: "## Steps\n\n1. Create the command\n",
				...draft,
			},
			{ taskId: null, agent: "test", commit: null },
		).skill;
	} finally {
		store.close();
	}
}

/** Capture everything written to stdout during `fn` (for asserting `--json`/table output). */
async function captureStdout(fn: () => void | Promise<void>): Promise<string> {
	const original = process.stdout.write.bind(process.stdout);
	let buffer = "";
	// Narrow override of the overloaded write signature for tests.
	process.stdout.write = ((chunk: unknown): boolean => {
		buffer += typeof chunk === "string" ? chunk : String(chunk);
		return true;
	}) as typeof process.stdout.write;
	try {
		await fn();
	} finally {
		process.stdout.write = original;
	}
	return buffer;
}

// --- command construction -------------------------------------------------

describe("createSkillCommand", () => {
	test("builds without throwing and registers every subcommand", () => {
		const command = createSkillCommand();
		expect(command.name()).toBe("skill");
		const names = command.commands.map((c) => c.name()).sort();
		expect(names).toEqual(
			[
				"deprecate",
				"list",
				"outcome",
				"prune",
				"record",
				"reindex",
				"restore",
				"search",
				"show",
			].sort(),
		);
	});
});

// --- record --stdin + list round-trip ------------------------------------

describe("record --stdin → list round-trip", () => {
	test("a piped create draft is persisted and shows up in list", async () => {
		const draft: SkillDraft = {
			action: "create",
			title: "Pipe a Draft Through Record",
			goal: "Round-trip a SkillDraft from stdin into the store",
			whenToUse: ["distilling a skill at session-end"],
			filePatterns: ["src/skills/*.ts"],
			tags: ["distill"],
			body: "## Steps\n\n1. Read stdin\n2. Upsert\n",
		};

		const out = await captureStdout(() =>
			runRecord({ stdin: true, json: true }, true, async () => JSON.stringify(draft)),
		);
		const env = JSON.parse(out.trim());
		expect(env.ok).toBe(true);
		expect(env.data.action).toBe("created");
		expect(env.data.skill.slug).toBe("pipe-a-draft-through-record");

		// The store now contains it.
		const store = createSkillStore(root);
		try {
			const got = store.get("pipe-a-draft-through-record");
			expect(got).not.toBeNull();
			expect(got?.title).toBe("Pipe a Draft Through Record");
		} finally {
			store.close();
		}

		// And `list --json` surfaces a row for it.
		const listOut = await captureStdout(() => runList({ json: true }, true));
		const listEnv = JSON.parse(listOut.trim());
		expect(listEnv.ok).toBe(true);
		const slugs = (listEnv.data as Array<{ slug: string }>).map((r) => r.slug);
		expect(slugs).toContain("pipe-a-draft-through-record");
	});

	test("a skip draft writes nothing", async () => {
		const out = await captureStdout(() =>
			runRecord({ stdin: true, json: true }, true, async () => JSON.stringify({ action: "skip" })),
		);
		const env = JSON.parse(out.trim());
		expect(env.ok).toBe(true);
		expect(env.data.action).toBe("skipped");

		const store = createSkillStore(root);
		try {
			expect(store.list()).toHaveLength(0);
		} finally {
			store.close();
		}
	});

	test("--dry-run reports the plan without writing", async () => {
		const draft: SkillDraft = { action: "create", title: "Never Written", body: "noop" };
		const out = await captureStdout(() =>
			runRecord({ stdin: true, dryRun: true, json: true }, true, async () => JSON.stringify(draft)),
		);
		const env = JSON.parse(out.trim());
		expect(env.data.dryRun).toBe(true);
		expect(env.data.plan).toBe("create");

		const store = createSkillStore(root);
		try {
			expect(store.list()).toHaveLength(0);
		} finally {
			store.close();
		}
	});

	test("a draft with a dangerous command is downgraded to skip (safety)", async () => {
		const draft: SkillDraft = {
			action: "create",
			title: "Dangerous Skill",
			body: "## Steps\n\n```bash\nrm -rf /\n```\n",
		};
		const out = await captureStdout(() =>
			runRecord({ stdin: true, json: true }, true, async () => JSON.stringify(draft)),
		);
		const env = JSON.parse(out.trim());
		expect(env.data.action).toBe("skipped");
		expect(env.data.ok).toBe(false);

		const store = createSkillStore(root);
		try {
			expect(store.list()).toHaveLength(0);
		} finally {
			store.close();
		}
	});

	test("requires --stdin", async () => {
		await expect(runRecord({ json: true }, true, async () => "{}")).rejects.toBeInstanceOf(
			ValidationError,
		);
	});
});

// --- outcome --------------------------------------------------------------

describe("outcome", () => {
	test("appending a success outcome lifts confidence above zero", async () => {
		const skill = seed();
		const out = await captureStdout(() =>
			runOutcome(skill.slug, { status: "success", json: true }, true),
		);
		const env = JSON.parse(out.trim());
		expect(env.ok).toBe(true);
		expect(env.data.appliedCount).toBe(1);
		expect(env.data.confidence).toBeGreaterThan(0);
	});

	test("rejects an invalid status", () => {
		const skill = seed();
		expect(() => runOutcome(skill.slug, { status: "great", json: true }, true)).toThrow(
			ValidationError,
		);
	});

	test("a missing slug surfaces NotFoundError", () => {
		expect(() => runOutcome("does-not-exist", { status: "success", json: true }, true)).toThrow(
			NotFoundError,
		);
	});
});

// --- deprecate / restore --------------------------------------------------

describe("deprecate / restore", () => {
	test("deprecate then restore flips status and back", async () => {
		const skill = seed();
		await captureStdout(() => runSetStatus(skill.slug, "deprecated", true));

		const store = createSkillStore(root);
		try {
			expect(store.get(skill.slug)?.status).toBe("deprecated");
		} finally {
			store.close();
		}

		await captureStdout(() => runSetStatus(skill.slug, "active", true));
		const store2 = createSkillStore(root);
		try {
			expect(store2.get(skill.slug)?.status).toBe("active");
		} finally {
			store2.close();
		}
	});
});

// --- prune ----------------------------------------------------------------

describe("prune", () => {
	test("dry-run lists an aged quarantined skill but does not delete it", async () => {
		const skill = seed();
		// Quarantine it and backdate updatedAt far past the default max-age window.
		const store = createSkillStore(root);
		try {
			store.setStatus(skill.slug, "quarantined");
		} finally {
			store.close();
		}
		backdate(skill.slug, 999);

		const out = await captureStdout(() => runPrune({ json: true }, true));
		const env = JSON.parse(out.trim());
		expect(env.data.removed).toBe(false);
		expect(env.data.candidates).toContain(skill.slug);

		// Still present (dry run).
		const after = createSkillStore(root);
		try {
			expect(after.get(skill.slug)).not.toBeNull();
		} finally {
			after.close();
		}
	});

	test("--force deletes an aged quarantined skill", async () => {
		const skill = seed();
		const store = createSkillStore(root);
		try {
			store.setStatus(skill.slug, "quarantined");
		} finally {
			store.close();
		}
		backdate(skill.slug, 999);

		await captureStdout(() => runPrune({ force: true, json: true }, true));

		const after = createSkillStore(root);
		try {
			expect(after.get(skill.slug)).toBeNull();
		} finally {
			after.close();
		}
	});

	test("a fresh quarantined skill is not a candidate", async () => {
		const skill = seed();
		const store = createSkillStore(root);
		try {
			store.setStatus(skill.slug, "quarantined");
		} finally {
			store.close();
		}
		// updatedAt is "now" (just set) — inside the window.

		const out = await captureStdout(() => runPrune({ force: true, json: true }, true));
		const env = JSON.parse(out.trim());
		expect(env.data.candidates).toHaveLength(0);

		const after = createSkillStore(root);
		try {
			expect(after.get(skill.slug)).not.toBeNull();
		} finally {
			after.close();
		}
	});

	test("rejects a negative --max-age-days", () => {
		expect(() => runPrune({ maxAgeDays: "-3", json: true }, true)).toThrow(ValidationError);
	});
});

/**
 * Rewrite a skill's `updatedAt` to `daysAgo` in the past to simulate an aged
 * skill (no clock seam exists in the store). Round-trips through parse/serialize
 * so the timestamp lands back as a properly-quoted string rather than a bare YAML
 * scalar that js-yaml would re-interpret as a Date.
 */
function backdate(slug: string, daysAgo: number): void {
	const file = join(root, AGENTPLATE_DIR, "skills", slug, "skill.md");
	const skill = parseSkillMd(readFileSync(file, "utf8"));
	skill.updatedAt = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000).toISOString();
	writeFileSync(file, serializeSkillMd(skill), "utf8");
}

// --- pure helpers: parseDraft --------------------------------------------

describe("parseDraft", () => {
	test("parses a well-formed create draft", () => {
		const draft = parseDraft(
			JSON.stringify({ action: "create", title: "X", whenToUse: ["a", 1, "b"] }),
		);
		expect(draft.action).toBe("create");
		expect(draft.title).toBe("X");
		// Non-string array elements are filtered out.
		expect(draft.whenToUse).toEqual(["a", "b"]);
	});

	test("rejects empty input", () => {
		expect(() => parseDraft("   ")).toThrow(ValidationError);
	});

	test("rejects malformed JSON", () => {
		expect(() => parseDraft("{not json")).toThrow(ValidationError);
	});

	test("rejects a non-object", () => {
		expect(() => parseDraft("[1,2,3]")).toThrow(ValidationError);
		expect(() => parseDraft('"a string"')).toThrow(ValidationError);
	});

	test("rejects an unknown action", () => {
		expect(() => parseDraft(JSON.stringify({ action: "frobnicate" }))).toThrow(ValidationError);
	});
});

// --- pure helpers: scoreSkill / rankSkills --------------------------------

/** Build a minimal Skill for ranking tests (only the fields the scorer reads). */
function fakeSkill(overrides: Partial<Skill>): Skill {
	return {
		id: "id",
		slug: "s",
		title: "",
		version: 1,
		status: "active",
		goal: "",
		whenToUse: [],
		filePatterns: [],
		tags: [],
		created: "",
		updatedAt: "",
		relatesTo: [],
		supersedes: [],
		body: "",
		confidence: 0,
		appliedCount: 0,
		successCount: 0,
		lastOutcome: null,
		...overrides,
	};
}

describe("scoreSkill / rankSkills", () => {
	test("query-term overlap drives the score", () => {
		const skill = fakeSkill({ title: "Add a CLI subcommand", goal: "Register on the program" });
		const tokens = new Set(["cli", "subcommand"]);
		expect(scoreSkill(skill, tokens, [])).toBeGreaterThan(0);
		expect(scoreSkill(skill, new Set(["unrelated"]), [])).toBeCloseTo(0, 5);
	});

	test("file-pattern overlap adds to the score", () => {
		const skill = fakeSkill({ filePatterns: ["src/commands/*.ts"] });
		const withFile = scoreSkill(skill, new Set(), ["src/commands/skill.ts"]);
		expect(withFile).toBeGreaterThan(0);
	});

	test("rankSkills orders by relevance and excludes non-active skills", () => {
		const relevant = fakeSkill({ slug: "relevant", title: "git rebase workflow" });
		const irrelevant = fakeSkill({ slug: "irrelevant", title: "something else entirely" });
		const deprecated = fakeSkill({
			slug: "deprecated-but-relevant",
			title: "git rebase howto",
			status: "deprecated",
		});

		const ranked = rankSkills([irrelevant, relevant, deprecated], "git rebase", []);
		// Deprecated is dropped; only the relevant active skill survives the filter.
		expect(ranked.map((r) => r.skill.slug)).toEqual(["relevant"]);
	});

	test("a blank query returns active skills ordered by confidence", () => {
		const low = fakeSkill({ slug: "low", confidence: 0.1 });
		const high = fakeSkill({ slug: "high", confidence: 0.9 });
		const ranked = rankSkills([low, high], "", []);
		expect(ranked.map((r) => r.skill.slug)).toEqual(["high", "low"]);
	});
});
