/**
 * AI distiller tests.
 *
 * Real implementations throughout: the prompt/parse halves are pure and tested
 * directly; the orchestration is exercised end-to-end against a REAL temp git
 * repo and the REAL skill store, with a FAKE runtime whose `buildPrintCommand`
 * returns a `bash -lc cat <<EOF …` heredoc that prints a scripted draft. This
 * drives `distillSkill` through a genuine one-shot subprocess call with no LLM.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentRuntime, DirectSpawnOpts } from "../runtimes/types.ts";
import type { ResolvedModel } from "../types.ts";
import {
	buildDistillerPrompt,
	distillSkill,
	extractFirstJsonObject,
	parseDistillerOutput,
} from "./distiller.ts";
import { createSkillStore, type SkillStore } from "./store.ts";
import type { Skill } from "./types.ts";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Build a minimal valid Skill for prompt-rendering tests. */
function makeSkill(overrides: Partial<Skill> = {}): Skill {
	return {
		id: "id-1",
		slug: "add-cli-subcommand",
		title: "Add a CLI Subcommand",
		version: 1,
		status: "active",
		goal: "Register a new subcommand on the program",
		whenToUse: ["adding an ap command"],
		filePatterns: ["src/commands/*.ts"],
		tags: ["cli"],
		created: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
		relatesTo: [],
		supersedes: [],
		body: "## Steps\n1. do thing\n## Gotchas\n## Verification\n",
		confidence: 0.5,
		appliedCount: 2,
		successCount: 2,
		lastOutcome: "success",
		...overrides,
	};
}

/**
 * A fake runtime whose one-shot `buildPrintCommand` emits a fixed string on
 * stdout via a `cat` heredoc — a real subprocess, deterministic output, no LLM.
 * The other methods satisfy the interface but are unused by the distiller.
 */
function fakeRuntime(printPayload: string): AgentRuntime {
	return {
		id: "fake",
		stability: "experimental",
		instructionPath: "CLAUDE.md",
		buildDirectSpawn(_opts: DirectSpawnOpts): string[] {
			return ["true"];
		},
		buildEnv(_model: ResolvedModel): Record<string, string> {
			return {};
		},
		buildPrintCommand(_prompt: string, _model?: string): string[] {
			// Heredoc keeps the payload a single opaque chunk; 'EOF' (quoted) disables
			// shell interpolation so JSON braces/quotes survive verbatim.
			return ["bash", "-lc", `cat <<'AGENTPLATE_EOF'\n${printPayload}\nAGENTPLATE_EOF`];
		},
	};
}

/** Run a git command in a repo, throwing on failure (test-only convenience). */
async function git(cwd: string, ...args: string[]): Promise<string> {
	const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
	const stdout = await new Response(proc.stdout).text();
	const exitCode = await proc.exited;
	if (exitCode !== 0) {
		const stderr = await new Response(proc.stderr).text();
		throw new Error(`git ${args.join(" ")} failed: ${stderr}`);
	}
	return stdout.trim();
}

/**
 * Create a real git repo in a temp dir with an initial commit, returning the
 * worktree path and the base ref (the initial commit's sha) to diff against.
 */
async function setupRepo(dir: string): Promise<string> {
	await git(dir, "init", "-q");
	await git(dir, "config", "user.email", "test@agentplate.dev");
	await git(dir, "config", "user.name", "Agentplate Test");
	writeFileSync(join(dir, "README.md"), "# base\n");
	await git(dir, "add", ".");
	await git(dir, "commit", "-q", "-m", "initial");
	return git(dir, "rev-parse", "HEAD");
}

// ---------------------------------------------------------------------------
// buildDistillerPrompt
// ---------------------------------------------------------------------------

describe("buildDistillerPrompt", () => {
	test("embeds the diff, skip guidance, and the JSON contract", () => {
		const prompt = buildDistillerPrompt({
			diff: "diff --git a/x.ts b/x.ts\n+const SENTINEL_DIFF_TOKEN = 1;",
			insightDigest: "x.ts | 1 +",
			specText: "Implement the X feature",
			appliedSkills: [],
		});

		// The diff is present verbatim.
		expect(prompt).toContain("SENTINEL_DIFF_TOKEN");
		// "skip" is taught as the usual right answer.
		expect(prompt.toLowerCase()).toContain("skip");
		expect(prompt).toMatch(/skip[\s\S]*right answer/i);
		// The strict JSON output contract is stated.
		expect(prompt).toContain("JSON");
		expect(prompt).toContain('"action"');
		// Body structure is specified.
		expect(prompt).toContain("## Steps");
		expect(prompt).toContain("## Gotchas");
		expect(prompt).toContain("## Verification");
	});

	test("renders applied skills as update candidates", () => {
		const prompt = buildDistillerPrompt({
			diff: "some diff",
			insightDigest: "",
			specText: "",
			appliedSkills: [makeSkill({ slug: "my-applied-skill" })],
		});
		expect(prompt).toContain("my-applied-skill");
		expect(prompt).toContain("update");
	});

	test("handles empty inputs without throwing", () => {
		const prompt = buildDistillerPrompt({
			diff: "",
			insightDigest: "",
			specText: "",
			appliedSkills: [],
		});
		expect(prompt).toContain("(empty diff)");
		expect(prompt).toContain("(no spec provided)");
		expect(prompt).toContain("(no skills were applied this session)");
	});

	test("truncates an enormous diff", () => {
		const huge = "X".repeat(50_000);
		const prompt = buildDistillerPrompt({
			diff: huge,
			insightDigest: "",
			specText: "",
			appliedSkills: [],
		});
		expect(prompt).toContain("[diff truncated]");
		// The full 50k payload is not embedded.
		expect(prompt.length).toBeLessThan(50_000);
	});
});

// ---------------------------------------------------------------------------
// extractFirstJsonObject
// ---------------------------------------------------------------------------

describe("extractFirstJsonObject", () => {
	test("returns null when there is no object", () => {
		expect(extractFirstJsonObject("no json here at all")).toBeNull();
		expect(extractFirstJsonObject("")).toBeNull();
	});

	test("finds a bare object", () => {
		expect(extractFirstJsonObject('prefix {"a":1} suffix')).toBe('{"a":1}');
	});

	test("respects braces inside string literals", () => {
		const text = 'x {"body":"has a } brace inside"} y';
		expect(extractFirstJsonObject(text)).toBe('{"body":"has a } brace inside"}');
	});

	test("handles nested objects and escaped quotes", () => {
		const text = 'lead {"a":{"b":2},"s":"q\\"uote"} trail';
		expect(extractFirstJsonObject(text)).toBe('{"a":{"b":2},"s":"q\\"uote"}');
	});
});

// ---------------------------------------------------------------------------
// parseDistillerOutput
// ---------------------------------------------------------------------------

describe("parseDistillerOutput", () => {
	test("parses a bare JSON object", () => {
		const draft = parseDistillerOutput('{"action":"skip"}');
		expect(draft).not.toBeNull();
		expect(draft?.action).toBe("skip");
	});

	test("parses a ```json fenced block with surrounding prose", () => {
		const stdout = [
			"Here is my decision after reviewing the diff:",
			"```json",
			JSON.stringify({
				action: "create",
				title: "Wire a New Subcommand",
				goal: "Add a command",
				whenToUse: ["adding a command"],
				filePatterns: ["src/commands/*.ts"],
				tags: ["cli"],
				body: "## Steps\n1. x\n## Gotchas\n## Verification\n",
			}),
			"```",
			"Hope that helps!",
		].join("\n");

		const draft = parseDistillerOutput(stdout);
		expect(draft).not.toBeNull();
		expect(draft?.action).toBe("create");
		expect(draft?.title).toBe("Wire a New Subcommand");
		expect(draft?.whenToUse).toEqual(["adding a command"]);
		expect(draft?.filePatterns).toEqual(["src/commands/*.ts"]);
		expect(draft?.tags).toEqual(["cli"]);
		expect(draft?.body).toContain("## Steps");
	});

	test("parses an update action with targetSlug", () => {
		const draft = parseDistillerOutput(
			'{"action":"update","targetSlug":"existing-skill","body":"## Steps\\nnew\\n"}',
		);
		expect(draft?.action).toBe("update");
		expect(draft?.targetSlug).toBe("existing-skill");
	});

	test("returns null on garbage", () => {
		expect(parseDistillerOutput("this is not json")).toBeNull();
		expect(parseDistillerOutput("")).toBeNull();
		expect(parseDistillerOutput("{ not valid json , }")).toBeNull();
	});

	test("returns null when action is missing", () => {
		expect(parseDistillerOutput('{"title":"No Action Here"}')).toBeNull();
	});

	test("returns null when action is not in the union", () => {
		expect(parseDistillerOutput('{"action":"delete"}')).toBeNull();
	});

	test("drops malformed optional fields rather than corrupting the draft", () => {
		const draft = parseDistillerOutput(
			'{"action":"create","title":"T","whenToUse":"not-an-array","tags":[1,2,"keep"]}',
		);
		expect(draft).not.toBeNull();
		expect(draft?.title).toBe("T");
		// A non-array whenToUse is dropped entirely.
		expect(draft?.whenToUse).toBeUndefined();
		// Non-string tag entries are filtered out.
		expect(draft?.tags).toEqual(["keep"]);
	});
});

// ---------------------------------------------------------------------------
// distillSkill (end-to-end, real git + real store + fake runtime subprocess)
// ---------------------------------------------------------------------------

describe("distillSkill", () => {
	let dir: string;
	let store: SkillStore;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "agentplate-distiller-"));
	});

	afterEach(() => {
		store?.close();
		rmSync(dir, { recursive: true, force: true });
	});

	test("creates a skill from a committed diff via the fake runtime", async () => {
		const baseRef = await setupRepo(dir);

		// Make a real change and commit it so baseRef..HEAD is a non-empty diff.
		writeFileSync(join(dir, "src.ts"), "export const answer = 42;\n");
		await git(dir, "add", ".");
		await git(dir, "commit", "-q", "-m", "add src");

		const draftJson = JSON.stringify({
			action: "create",
			title: "Export a Constant",
			goal: "Export a typed constant from a module",
			whenToUse: ["adding a shared constant"],
			filePatterns: ["src/**/*.ts"],
			tags: ["typescript"],
			body: "## Steps\n1. add `export const`\n## Gotchas\nnone\n## Verification\nrun `bun test`\n",
		});

		store = createSkillStore(dir);
		const runtime = fakeRuntime(draftJson);

		const result = await distillSkill({
			store,
			runtime,
			root: dir,
			worktreePath: dir,
			baseRef,
			taskId: "task-99",
			agentName: "builder-x",
			capability: "builder",
			appliedSlugs: [],
		});

		expect(result.action).toBe("created");
		expect(result.slug).toBe("export-a-constant");

		// The skill directory + skill.md landed on disk.
		const skillFile = join(dir, ".agentplate", "skills", "export-a-constant", "skill.md");
		expect(existsSync(skillFile)).toBe(true);

		// The persisted skill carries our provenance (agent + task + a real HEAD sha).
		const persisted = store.get("export-a-constant");
		expect(persisted).not.toBeNull();
		expect(persisted?.title).toBe("Export a Constant");
		expect(persisted?.distilledFrom?.agent).toBe("builder-x");
		expect(persisted?.distilledFrom?.taskId).toBe("task-99");
		expect(persisted?.distilledFrom?.commit).toMatch(/^[0-9a-f]{7,40}$/);
	});

	test("reads the task spec and feeds it to the model (spec is on disk)", async () => {
		const baseRef = await setupRepo(dir);
		writeFileSync(join(dir, "x.ts"), "export const x = 1;\n");
		await git(dir, "add", ".");
		await git(dir, "commit", "-q", "-m", "change");

		// Write a spec under .agentplate/specs/<task-id>.md — the distiller should read it.
		// Bun.write creates the parent directory as needed.
		const specsDir = join(dir, ".agentplate", "specs");
		await Bun.write(join(specsDir, "task-spec-1.md"), "Build the spec feature\n");

		store = createSkillStore(dir);
		// Echo back a skip so we don't mint anything — we only assert no throw + skip.
		const result = await distillSkill({
			store,
			runtime: fakeRuntime('{"action":"skip"}'),
			root: dir,
			worktreePath: dir,
			baseRef,
			taskId: "task-spec-1",
			agentName: "builder-x",
			capability: "builder",
			appliedSlugs: [],
		});
		expect(result.action).toBe("skipped");
	});

	test("skips when the diff is empty (nothing committed past base)", async () => {
		const baseRef = await setupRepo(dir);
		store = createSkillStore(dir);

		const result = await distillSkill({
			store,
			runtime: fakeRuntime('{"action":"create","title":"Should Not Happen"}'),
			root: dir,
			worktreePath: dir,
			baseRef,
			taskId: null,
			agentName: "builder-x",
			capability: "builder",
			appliedSlugs: [],
		});

		expect(result.action).toBe("skipped");
		expect(result.slug).toBeUndefined();
		expect(store.list()).toHaveLength(0);
	});

	test("skips when the model returns an explicit skip action", async () => {
		const baseRef = await setupRepo(dir);
		writeFileSync(join(dir, "f.ts"), "export const f = 1;\n");
		await git(dir, "add", ".");
		await git(dir, "commit", "-q", "-m", "trivial");

		store = createSkillStore(dir);
		const result = await distillSkill({
			store,
			runtime: fakeRuntime('Sure, here is my call:\n{"action":"skip"}\n'),
			root: dir,
			worktreePath: dir,
			baseRef,
			taskId: null,
			agentName: "builder-x",
			capability: "builder",
			appliedSlugs: [],
		});
		expect(result.action).toBe("skipped");
		expect(store.list()).toHaveLength(0);
	});

	test("downgrades a draft containing rm -rf to skipped (never persists it)", async () => {
		const baseRef = await setupRepo(dir);
		writeFileSync(join(dir, "danger.ts"), "export const d = 1;\n");
		await git(dir, "add", ".");
		await git(dir, "commit", "-q", "-m", "danger");

		const dangerousDraft = JSON.stringify({
			action: "create",
			title: "Clean the Workspace",
			goal: "Wipe build artifacts",
			whenToUse: ["cleaning up"],
			filePatterns: ["**/*"],
			tags: ["cleanup"],
			body: "## Steps\n```bash\nrm -rf ./dist\n```\n## Gotchas\n## Verification\n",
		});

		store = createSkillStore(dir);
		const result = await distillSkill({
			store,
			runtime: fakeRuntime(dangerousDraft),
			root: dir,
			worktreePath: dir,
			baseRef,
			taskId: null,
			agentName: "builder-x",
			capability: "builder",
			appliedSlugs: [],
		});

		// Fatal safety violation → skipped, and nothing written to disk.
		expect(result.action).toBe("skipped");
		expect(store.list()).toHaveLength(0);
		expect(existsSync(join(dir, ".agentplate", "skills", "clean-the-workspace"))).toBe(false);
	});

	test("updates an existing applied skill when the model says update", async () => {
		const baseRef = await setupRepo(dir);
		writeFileSync(join(dir, "u.ts"), "export const u = 1;\n");
		await git(dir, "add", ".");
		await git(dir, "commit", "-q", "-m", "update work");

		store = createSkillStore(dir);
		// Seed an existing skill the model can target.
		const seeded = store.upsert(
			{ action: "create", title: "Existing Skill", body: "## Steps\nold\n" },
			{ taskId: "t-0", agent: "seed", commit: "seed-sha" },
		);
		const targetSlug = seeded.skill.slug;

		const updateDraft = JSON.stringify({
			action: "update",
			targetSlug,
			body: "## Steps\nnew improved steps\n## Gotchas\n## Verification\n",
		});

		const result = await distillSkill({
			store,
			runtime: fakeRuntime(updateDraft),
			root: dir,
			worktreePath: dir,
			baseRef,
			taskId: "task-u",
			agentName: "builder-x",
			capability: "builder",
			appliedSlugs: [targetSlug],
		});

		expect(result.action).toBe("updated");
		expect(result.slug).toBe(targetSlug);
		const updated = store.get(targetSlug);
		expect(updated?.version).toBe(2);
		expect(updated?.body).toContain("new improved steps");
	});

	test("skips on garbage model output (unparseable)", async () => {
		const baseRef = await setupRepo(dir);
		writeFileSync(join(dir, "g.ts"), "export const g = 1;\n");
		await git(dir, "add", ".");
		await git(dir, "commit", "-q", "-m", "garbage case");

		store = createSkillStore(dir);
		const result = await distillSkill({
			store,
			runtime: fakeRuntime("I could not decide, sorry — no JSON for you."),
			root: dir,
			worktreePath: dir,
			baseRef,
			taskId: null,
			agentName: "builder-x",
			capability: "builder",
			appliedSlugs: [],
		});
		expect(result.action).toBe("skipped");
		expect(store.list()).toHaveLength(0);
	});
});
