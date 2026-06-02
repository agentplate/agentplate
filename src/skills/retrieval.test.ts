/**
 * Skill retrieval + overlay formatting tests.
 *
 * Everything under test is PURE (it takes already-loaded {@link Skill} objects
 * and returns plain data + markdown), so these tests need no filesystem, SQLite,
 * or subprocess — just hand-built skills. No mocks.
 */

import { describe, expect, test } from "bun:test";
import {
	globMatch,
	renderSkillsOverlay,
	type SelectOpts,
	scoreSkill,
	selectSkills,
} from "./retrieval.ts";
import type { Skill } from "./types.ts";

/** Build a Skill with sane defaults; override only what a test cares about. */
function makeSkill(overrides: Partial<Skill> = {}): Skill {
	const now = new Date().toISOString();
	return {
		id: crypto.randomUUID(),
		slug: "a-skill",
		title: "A Skill",
		version: 1,
		status: "active",
		goal: "Do a thing",
		whenToUse: [],
		filePatterns: [],
		tags: [],
		created: now,
		updatedAt: now,
		relatesTo: [],
		supersedes: [],
		body: "## Steps\n\n1. Step one\n2. Step two",
		confidence: 0,
		appliedCount: 0,
		successCount: 0,
		lastOutcome: null,
		...overrides,
	};
}

function opts(overrides: Partial<SelectOpts> = {}): SelectOpts {
	return {
		fileScope: [],
		taskText: "",
		capability: "builder",
		...overrides,
	};
}

// ---------------------------------------------------------------------------
// globMatch
// ---------------------------------------------------------------------------

describe("globMatch", () => {
	test("single * matches within a path segment but not across /", () => {
		expect(globMatch("src/*.ts", "src/foo.ts")).toBe(true);
		expect(globMatch("src/*.ts", "src/nested/foo.ts")).toBe(false);
	});

	test("** matches across path segments", () => {
		expect(globMatch("src/**/*.ts", "src/a/b/foo.ts")).toBe(true);
		expect(globMatch("src/**", "src/a/b/foo.ts")).toBe(true);
	});

	test("wildcarded patterns are anchored (no spurious prefix match)", () => {
		expect(globMatch("src/*.ts", "lib/src/a.ts")).toBe(false);
	});

	test("a pattern with no wildcards is a substring fallback", () => {
		expect(globMatch("commands", "src/commands/foo.ts")).toBe(true);
		expect(globMatch("widgets", "src/commands/foo.ts")).toBe(false);
	});

	test("empty pattern never matches", () => {
		expect(globMatch("", "anything")).toBe(false);
	});

	test("regex metacharacters in a literal are escaped", () => {
		// The dot is a literal here, not 'any char'.
		expect(globMatch("a.b*", "a.bcd")).toBe(true);
		expect(globMatch("a.b*", "axbcd")).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// scoreSkill
// ---------------------------------------------------------------------------

describe("scoreSkill", () => {
	test("ranks a file-pattern-matching skill above an unrelated one", () => {
		const matching = makeSkill({
			slug: "matching",
			filePatterns: ["src/commands/*.ts"],
		});
		const unrelated = makeSkill({
			slug: "unrelated",
			filePatterns: ["docs/**/*.md"],
		});
		const o = opts({ fileScope: ["src/commands/foo.ts"], taskText: "add a command" });

		expect(scoreSkill(matching, o)).toBeGreaterThan(scoreSkill(unrelated, o));
	});

	test("ranks a lexically-matching skill above a lexically-irrelevant one", () => {
		const relevant = makeSkill({
			slug: "relevant",
			title: "Add a CLI Subcommand",
			goal: "Register a new subcommand on the program",
			tags: ["cli", "commander"],
		});
		const irrelevant = makeSkill({
			slug: "irrelevant",
			title: "Tune Postgres Vacuum",
			goal: "Adjust autovacuum thresholds",
			tags: ["database", "postgres"],
		});
		const o = opts({ taskText: "add a new cli subcommand with commander" });

		expect(scoreSkill(relevant, o)).toBeGreaterThan(scoreSkill(irrelevant, o));
	});

	test("a quarantined skill scores 0 even with a perfect file match", () => {
		const skill = makeSkill({
			status: "quarantined",
			filePatterns: ["src/commands/*.ts"],
			confidence: 1,
		});
		expect(scoreSkill(skill, opts({ fileScope: ["src/commands/foo.ts"] }))).toBe(0);
	});

	test("a deprecated skill scores 0", () => {
		const skill = makeSkill({ status: "deprecated", filePatterns: ["src/*.ts"] });
		expect(scoreSkill(skill, opts({ fileScope: ["src/a.ts"] }))).toBe(0);
	});

	test("higher confidence raises the score, all else equal", () => {
		const base = { filePatterns: ["src/*.ts"], updatedAt: new Date().toISOString() };
		const lowConf = makeSkill({ ...base, slug: "low", confidence: 0.1 });
		const highConf = makeSkill({ ...base, slug: "high", confidence: 0.9 });
		const o = opts({ fileScope: ["src/a.ts"], taskText: "edit source" });

		expect(scoreSkill(highConf, o)).toBeGreaterThan(scoreSkill(lowConf, o));
	});

	test("a fresher skill outranks a stale one, all else equal", () => {
		const fresh = makeSkill({ slug: "fresh", updatedAt: new Date().toISOString() });
		const stale = makeSkill({
			slug: "stale",
			// ~2 years old → recency term decays toward 0.
			updatedAt: new Date(Date.now() - 730 * 24 * 60 * 60 * 1000).toISOString(),
		});
		const o = opts({ taskText: "do a thing" });

		expect(scoreSkill(fresh, o)).toBeGreaterThan(scoreSkill(stale, o));
	});

	test("score stays within [0, 1]", () => {
		const skill = makeSkill({
			filePatterns: ["src/commands/*.ts"],
			title: "Add a CLI Subcommand",
			goal: "Register a subcommand",
			tags: ["cli"],
			confidence: 1,
			updatedAt: new Date().toISOString(),
		});
		const s = scoreSkill(
			skill,
			opts({ fileScope: ["src/commands/foo.ts"], taskText: "add a cli subcommand" }),
		);
		expect(s).toBeGreaterThan(0);
		expect(s).toBeLessThanOrEqual(1);
	});
});

// ---------------------------------------------------------------------------
// selectSkills
// ---------------------------------------------------------------------------

describe("selectSkills", () => {
	test("ranks full skills highest-score first and drops zero-score skills", () => {
		const top = makeSkill({
			slug: "top",
			filePatterns: ["src/commands/*.ts"],
			title: "Add a CLI Subcommand",
			tags: ["cli"],
		});
		const mid = makeSkill({
			slug: "mid",
			title: "Add a CLI Subcommand",
			tags: ["cli"],
		});
		const excluded = makeSkill({ slug: "excluded", status: "quarantined" });

		const result = selectSkills(
			[mid, top, excluded],
			opts({ fileScope: ["src/commands/foo.ts"], taskText: "add a cli subcommand" }),
		);

		// 'top' (file + lexical) outranks 'mid' (lexical only); 'excluded' is gone.
		const fullSlugs = result.full.map((r) => r.skill.slug);
		expect(fullSlugs).toEqual(["top", "mid"]);
		expect([...result.full, ...result.summarized].some((r) => r.skill.slug === "excluded")).toBe(
			false,
		);
	});

	test("respects maxFull: surplus skills spill into summarized", () => {
		const skills = [0, 1, 2, 3, 4].map((i) =>
			makeSkill({
				slug: `s${i}`,
				title: "Add a CLI Subcommand",
				tags: ["cli"],
				// Stagger confidence so ordering is deterministic and distinct.
				confidence: (5 - i) / 5,
				filePatterns: ["src/commands/*.ts"],
			}),
		);

		const result = selectSkills(
			skills,
			opts({ fileScope: ["src/commands/foo.ts"], taskText: "add a cli subcommand", maxFull: 2 }),
		);

		expect(result.full.length).toBe(2);
		expect(result.summarized.length).toBe(3);
		// All five were ranked (none dropped).
		expect(result.full.length + result.summarized.length).toBe(5);
	});

	test("a tiny budget pushes everything into summarized", () => {
		const skills = [0, 1, 2].map((i) =>
			makeSkill({
				slug: `s${i}`,
				title: "Add a CLI Subcommand",
				tags: ["cli"],
				body: "## Steps\n\n1. A long-ish body that easily exceeds a tiny budget.\n2. More.",
				filePatterns: ["src/commands/*.ts"],
			}),
		);

		const result = selectSkills(
			skills,
			opts({
				fileScope: ["src/commands/foo.ts"],
				taskText: "add a cli subcommand",
				budgetChars: 5,
			}),
		);

		expect(result.full.length).toBe(0);
		expect(result.summarized.length).toBe(3);
		// And the rendered block is the summaries (with show-hints), not full bodies.
		expect(result.overlayMarkdown).toContain("agentplate skill show s0");
		expect(result.overlayMarkdown).not.toContain("long-ish body");
	});

	test("a generous budget admits skills as full (under maxFull)", () => {
		const skills = [0, 1].map((i) =>
			makeSkill({
				slug: `s${i}`,
				title: "Add a CLI Subcommand",
				tags: ["cli"],
				filePatterns: ["src/commands/*.ts"],
			}),
		);
		const result = selectSkills(
			skills,
			opts({
				fileScope: ["src/commands/foo.ts"],
				taskText: "add a cli subcommand",
				budgetChars: 100_000,
			}),
		);
		expect(result.full.length).toBe(2);
		expect(result.summarized.length).toBe(0);
	});

	test("default budget/maxFull apply when omitted (small set fits as full)", () => {
		const skills = [0, 1, 2].map((i) =>
			makeSkill({
				slug: `s${i}`,
				title: "Add a CLI Subcommand",
				tags: ["cli"],
				filePatterns: ["src/commands/*.ts"],
			}),
		);
		const result = selectSkills(
			skills,
			opts({ fileScope: ["src/commands/foo.ts"], taskText: "add a cli subcommand" }),
		);
		// Three short skills are well under the 6000-char / 4-full defaults.
		expect(result.full.length).toBe(3);
		expect(result.summarized.length).toBe(0);
	});

	test("overlayMarkdown carries the full skill's goal and the summarized skill's show-hint", () => {
		const fullSkill = makeSkill({
			slug: "full-one",
			title: "Full One",
			goal: "Wire the thing end to end",
			tags: ["cli"],
			body: "## Steps\n\n1. Do it",
			filePatterns: ["src/commands/*.ts"],
		});
		const summarizedSkill = makeSkill({
			slug: "summary-one",
			title: "Summary One",
			goal: "A lesser but relevant skill",
			tags: ["cli"],
		});

		const result = selectSkills(
			[fullSkill, summarizedSkill],
			opts({
				fileScope: ["src/commands/foo.ts"],
				taskText: "add a cli command",
				maxFull: 1,
			}),
		);

		// The file-matching skill goes full; the lexical-only one is summarized.
		expect(result.full.map((r) => r.skill.slug)).toEqual(["full-one"]);
		expect(result.summarized.map((r) => r.skill.slug)).toEqual(["summary-one"]);

		expect(result.overlayMarkdown).toContain("Wire the thing end to end");
		expect(result.overlayMarkdown).toContain("agentplate skill show summary-one");
	});

	test("only excluded (score-0) skills yields the placeholder block and empty lists", () => {
		// Quarantined/deprecated skills score exactly 0, so both lists end up empty
		// even though the skills are otherwise strong matches — the realistic route
		// to a "no applicable skills" overlay. (A merely-irrelevant active skill can
		// still earn a microscopic recency score and would be summarized.)
		const quarantined = makeSkill({
			slug: "quarantined",
			status: "quarantined",
			filePatterns: ["src/widgets/*.tsx"],
			title: "Render a React Widget",
			confidence: 1,
		});
		const deprecated = makeSkill({
			slug: "deprecated",
			status: "deprecated",
			filePatterns: ["src/widgets/*.tsx"],
			title: "Render a React Widget",
		});

		const result = selectSkills(
			[quarantined, deprecated],
			opts({ fileScope: ["src/widgets/a.tsx"], taskText: "render a react widget" }),
		);

		expect(result.full).toEqual([]);
		expect(result.summarized).toEqual([]);
		expect(result.overlayMarkdown).toContain("## Applicable Skills");
		expect(result.overlayMarkdown).toContain("(no applicable skills yet)");
	});
});

// ---------------------------------------------------------------------------
// renderSkillsOverlay
// ---------------------------------------------------------------------------

describe("renderSkillsOverlay", () => {
	test("empty input renders the heading + placeholder", () => {
		const md = renderSkillsOverlay([], []);
		expect(md).toContain("## Applicable Skills");
		expect(md).toContain("(no applicable skills yet)");
	});

	test("a full skill renders goal, trimmed body, and a skill:<slug> tag", () => {
		const skill = makeSkill({
			slug: "wire-it",
			title: "Wire It",
			goal: "Connect A to B",
			body: "\n\n## Steps\n\n1. Connect\n2. Verify\n\n",
		});
		const md = renderSkillsOverlay([skill], []);

		expect(md).toContain("### Wire It");
		expect(md).toContain("Goal: Connect A to B");
		expect(md).toContain("## Steps");
		expect(md).toContain("1. Connect");
		expect(md).toContain("skill: wire-it");
		// Body was trimmed: no leading blank lines bleeding into the header block.
		expect(md).not.toContain("Wire It\n\n\n\n");
	});

	test("a summarized skill renders a single show-hint bullet with its goal", () => {
		const skill = makeSkill({ slug: "lesser", title: "Lesser", goal: "A small win" });
		const md = renderSkillsOverlay([], [skill]);

		expect(md).toContain("- Lesser — A small win (run `agentplate skill show lesser`)");
		expect(md).toContain("### Related skills");
	});

	test("a summarized skill with no goal omits the dash segment", () => {
		const skill = makeSkill({ slug: "bare", title: "Bare", goal: "" });
		const md = renderSkillsOverlay([], [skill]);

		expect(md).toContain("- Bare (run `agentplate skill show bare`)");
		expect(md).not.toContain("Bare — ");
	});

	test("mixed full + summarized renders both sections", () => {
		const full = makeSkill({ slug: "full-x", title: "Full X", goal: "Full goal" });
		const summary = makeSkill({ slug: "sum-y", title: "Sum Y", goal: "Sum goal" });
		const md = renderSkillsOverlay([full], [summary]);

		expect(md.startsWith("## Applicable Skills")).toBe(true);
		expect(md).toContain("### Full X");
		expect(md).toContain("skill: full-x");
		expect(md).toContain("agentplate skill show sum-y");
		// The full skill's content precedes the related-skills list.
		expect(md.indexOf("### Full X")).toBeLessThan(md.indexOf("### Related skills"));
	});
});
