/**
 * Tests for branch merge + conflict resolution.
 *
 * Every test runs against a REAL git repository created in a temp directory
 * (per the project's "never mock what you can use for real" rule). We drive git
 * through Bun.spawn exactly as the resolver does, so the tests validate true git
 * behavior — clean merges, conflict detection, abort cleanliness, and the
 * keep-theirs auto-resolution.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { WorktreeError } from "../errors.ts";
import { withMergeLock } from "./lock.ts";
import { mergeBranch, predictMerge } from "./resolver.ts";

let repo: string;

/** Run a git command in the test repo, asserting success. Returns stdout. */
async function git(...args: string[]): Promise<string> {
	const proc = Bun.spawn(["git", ...args], { cwd: repo, stdout: "pipe", stderr: "pipe" });
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	if (exitCode !== 0) {
		throw new Error(`git ${args.join(" ")} failed (exit ${exitCode}): ${stderr}`);
	}
	return stdout;
}

/** Write a file (relative to repo root) and return its absolute path. */
async function writeFile(rel: string, content: string): Promise<void> {
	await Bun.write(join(repo, rel), content);
}

/** Read a tracked file's current working-tree content. */
async function readFile(rel: string): Promise<string> {
	return Bun.file(join(repo, rel)).text();
}

/**
 * Create a fresh repo on branch `main` with an initial commit containing
 * `file.txt`. Returns once HEAD is on `main`.
 */
async function initRepo(): Promise<void> {
	await git("init", "-q");
	// Deterministic identity so commits succeed in CI without global git config.
	await git("config", "user.email", "test@agentplate.dev");
	await git("config", "user.name", "Agentplate Test");
	// Pin the default branch name regardless of the host's init.defaultBranch.
	await git("checkout", "-q", "-b", "main");
	await writeFile("file.txt", "line1\nline2\nline3\n");
	await git("add", "-A");
	await git("commit", "-q", "-m", "initial");
}

/** Create `branch` off the current HEAD and check it out. */
async function branchOff(branch: string): Promise<void> {
	await git("checkout", "-q", "-b", branch);
}

/** Switch to an existing branch. */
async function checkout(branch: string): Promise<void> {
	await git("checkout", "-q", branch);
}

/** Commit the current working tree with a message. */
async function commitAll(message: string): Promise<void> {
	await git("add", "-A");
	await git("commit", "-q", "-m", message);
}

/** True iff a merge is in progress (MERGE_HEAD exists) in the test repo. */
async function mergeHeadExists(): Promise<boolean> {
	const proc = Bun.spawn(["git", "rev-parse", "--verify", "-q", "MERGE_HEAD"], {
		cwd: repo,
		stdout: "pipe",
		stderr: "pipe",
	});
	return (await proc.exited) === 0;
}

/** The currently checked-out branch name. */
async function headBranch(): Promise<string> {
	return (await git("symbolic-ref", "--short", "HEAD")).trim();
}

/**
 * Leave a real conflicting `git merge` of `agentplate/a` in progress on main
 * (MERGE_HEAD set), plus an unrelated clean branch `agentplate/b`.
 */
async function startConflictingMerge(): Promise<void> {
	await branchOff("agentplate/a");
	await writeFile("file.txt", "A\nline2\nline3\n");
	await commitAll("a");
	await checkout("main");
	await branchOff("agentplate/b");
	await writeFile("other.txt", "b\n");
	await commitAll("b");
	await checkout("main");
	await writeFile("file.txt", "MAIN\nline2\nline3\n");
	await commitAll("main");
	const proc = Bun.spawn(["git", "merge", "--no-ff", "--no-edit", "agentplate/a"], {
		cwd: repo,
		stdout: "pipe",
		stderr: "pipe",
	});
	expect(await proc.exited).toBe(1);
	expect(await mergeHeadExists()).toBe(true);
}

/** Paths the merge commit at HEAD changed relative to its first parent (the target). */
async function mergeCommitPaths(): Promise<string[]> {
	const out = await git("diff", "--name-only", "-z", "HEAD^1", "HEAD");
	return out.split("\0").filter((p) => p.length > 0);
}

beforeEach(async () => {
	repo = mkdtempSync(join(tmpdir(), "agentplate-merge-"));
	await initRepo();
});

afterEach(() => {
	rmSync(repo, { recursive: true, force: true });
});

describe("mergeBranch — clean merge", () => {
	test("non-conflicting branch merges cleanly", async () => {
		// Branch touches a NEW file; main is unchanged -> no conflict.
		await branchOff("agent/clean");
		await writeFile("feature.txt", "hello from agent\n");
		await commitAll("add feature.txt");

		await checkout("main");
		const result = await mergeBranch(repo, "agent/clean", "main");

		expect(result.status).toBe("merged");
		expect(result.tier).toBe("clean-merge");
		expect(result.conflictFiles).toEqual([]);
		expect(result.branchName).toBe("agent/clean");

		// The branch's file is now present on main.
		expect(await readFile("feature.txt")).toBe("hello from agent\n");

		// A --no-ff merge always records a merge commit (two parents).
		const parents = (await git("rev-list", "--parents", "-n", "1", "HEAD")).trim().split(/\s+/);
		expect(parents.length).toBe(3); // commit + 2 parents
	});
});

describe("mergeBranch — conflict handling", () => {
	/** Build a branch that conflicts with main on file.txt's first line. */
	async function makeConflict(): Promise<void> {
		await branchOff("agent/conflict");
		await writeFile("file.txt", "BRANCH-EDIT\nline2\nline3\n");
		await commitAll("branch edits line1");

		await checkout("main");
		await writeFile("file.txt", "MAIN-EDIT\nline2\nline3\n");
		await commitAll("main edits line1");
	}

	test("autoResolve=false fails and leaves NO in-progress merge", async () => {
		await makeConflict();

		const result = await mergeBranch(repo, "agent/conflict", "main", { autoResolve: false });

		expect(result.status).toBe("failed");
		expect(result.tier).toBeNull();
		expect(result.conflictFiles).toContain("file.txt");

		// Critical: the repo must be clean — no MERGE_HEAD, no conflict markers.
		// `git rev-parse --verify MERGE_HEAD` must fail (exit != 0).
		const mh = Bun.spawn(["git", "rev-parse", "--verify", "-q", "MERGE_HEAD"], {
			cwd: repo,
			stdout: "pipe",
			stderr: "pipe",
		});
		expect(await mh.exited).not.toBe(0);

		// Working tree is clean (porcelain output empty).
		const status = await git("status", "--porcelain");
		expect(status.trim()).toBe("");

		// main's content is untouched (the conflicting merge was aborted).
		expect(await readFile("file.txt")).toBe("MAIN-EDIT\nline2\nline3\n");
	});

	test("autoResolve=true merges by keeping incoming (theirs) changes", async () => {
		await makeConflict();

		const result = await mergeBranch(repo, "agent/conflict", "main", { autoResolve: true });

		expect(result.status).toBe("merged");
		expect(result.tier).toBe("auto-resolve");
		expect(result.conflictFiles).toContain("file.txt");

		// keep-theirs => the incoming branch's version wins.
		expect(await readFile("file.txt")).toBe("BRANCH-EDIT\nline2\nline3\n");

		// Merge is committed: clean tree, no MERGE_HEAD.
		const status = await git("status", "--porcelain");
		expect(status.trim()).toBe("");
		const mh = Bun.spawn(["git", "rev-parse", "--verify", "-q", "MERGE_HEAD"], {
			cwd: repo,
			stdout: "pipe",
			stderr: "pipe",
		});
		expect(await mh.exited).not.toBe(0);
	});
});

describe("predictMerge — side-effect-free", () => {
	test("reports clean for a non-conflicting branch without changing HEAD", async () => {
		await branchOff("agent/clean");
		await writeFile("feature.txt", "x\n");
		await commitAll("add feature.txt");
		await checkout("main");

		const headBefore = (await git("rev-parse", "HEAD")).trim();
		const result = await predictMerge(repo, "agent/clean", "main");

		expect(result.status).toBe("pending");
		expect(result.tier).toBe("clean-merge");
		expect(result.conflictFiles).toEqual([]);

		// HEAD unchanged and working tree clean: prediction had no side effects.
		expect((await git("rev-parse", "HEAD")).trim()).toBe(headBefore);
		expect((await git("status", "--porcelain")).trim()).toBe("");
		// The would-be-merged file was NOT brought in.
		expect(await Bun.file(join(repo, "feature.txt")).exists()).toBe(false);
	});

	test("reports conflicts without changing HEAD or leaving a merge in progress", async () => {
		// Conflicting setup.
		await branchOff("agent/conflict");
		await writeFile("file.txt", "BRANCH\nline2\nline3\n");
		await commitAll("branch edit");
		await checkout("main");
		await writeFile("file.txt", "MAIN\nline2\nline3\n");
		await commitAll("main edit");

		const headBefore = (await git("rev-parse", "HEAD")).trim();
		const result = await predictMerge(repo, "agent/conflict", "main");

		expect(result.status).toBe("pending");
		expect(result.tier).toBe("auto-resolve");
		expect(result.conflictFiles).toContain("file.txt");

		// No side effects: HEAD pinned, tree clean, no MERGE_HEAD, content intact.
		expect((await git("rev-parse", "HEAD")).trim()).toBe(headBefore);
		expect((await git("status", "--porcelain")).trim()).toBe("");
		expect(await readFile("file.txt")).toBe("MAIN\nline2\nline3\n");
		const mh = Bun.spawn(["git", "rev-parse", "--verify", "-q", "MERGE_HEAD"], {
			cwd: repo,
			stdout: "pipe",
			stderr: "pipe",
		});
		expect(await mh.exited).not.toBe(0);
	});
});

describe("predictMerge — never touches the operator checkout", () => {
	test("an already-merged branch keeps uncommitted edits (no reset --hard)", async () => {
		// The branch adds nothing over main ("Already up to date" for a real merge).
		await git("branch", "agentplate/done");
		await writeFile("file.txt", "UNCOMMITTED\n");

		const result = await predictMerge(repo, "agentplate/done", "main");

		expect(result.status).toBe("pending");
		expect(result.tier).toBe("clean-merge");
		expect(await readFile("file.txt")).toBe("UNCOMMITTED\n");
		expect((await git("status", "--porcelain")).trim()).toBe("M file.txt");
	});

	test("dirty files the branch also touches are preserved", async () => {
		await writeFile("b.txt", "b\n");
		await commitAll("add b.txt");
		await branchOff("agentplate/w");
		await writeFile("file.txt", "AGENT\nline2\nline3\n");
		await commitAll("agent edits file.txt");
		await checkout("main");
		// Operator edits both a file the branch touches and one it does not.
		await writeFile("file.txt", "OPERATOR\nline2\nline3\n");
		await writeFile("b.txt", "operator b\n");

		const result = await predictMerge(repo, "agentplate/w", "main");

		// Prediction is over committed tips: main never committed a change, so clean.
		expect(result.tier).toBe("clean-merge");
		expect(await readFile("file.txt")).toBe("OPERATOR\nline2\nline3\n");
		expect(await readFile("b.txt")).toBe("operator b\n");
	});

	test("does not switch the checked-out branch to the target", async () => {
		await branchOff("agentplate/w");
		await writeFile("feature.txt", "x\n");
		await commitAll("add feature.txt");
		await checkout("main");
		await branchOff("feature");
		await writeFile("wip.txt", "wip\n");

		await predictMerge(repo, "agentplate/w", "main");

		expect(await headBranch()).toBe("feature");
		expect(await readFile("wip.txt")).toBe("wip\n");
	});

	test("leaves a concurrent in-progress merge alone (no stray merge --abort)", async () => {
		// A real merge (e.g. a locked mergeBranch / operator) is mid-conflict.
		await startConflictingMerge();

		const result = await predictMerge(repo, "agentplate/b", "main");

		expect(result.tier).toBe("clean-merge");
		expect(await mergeHeadExists()).toBe(true);
		expect(await readFile("file.txt")).toContain("<<<<<<<");
	});

	test("a typo'd branch throws WorktreeError and leaves dirty files intact", async () => {
		await writeFile("file.txt", "DIRTY\n");

		await expect(predictMerge(repo, "agentplate/typo", "main")).rejects.toBeInstanceOf(
			WorktreeError,
		);
		expect(await readFile("file.txt")).toBe("DIRTY\n");
	});

	test("lists conflicted paths verbatim (spaces / non-ASCII are not C-quoted)", async () => {
		await branchOff("agentplate/w");
		await writeFile("ün i.txt", "agent\n");
		await commitAll("agent adds");
		await checkout("main");
		await writeFile("ün i.txt", "main\n");
		await commitAll("main adds");

		const result = await predictMerge(repo, "agentplate/w", "main");

		expect(result.tier).toBe("auto-resolve");
		expect(result.conflictFiles).toEqual(["ün i.txt"]);
	});
});

describe("merge target/branch validation", () => {
	test("a target that names a directory (not a branch) is refused, edits kept", async () => {
		await branchOff("agentplate/w");
		await writeFile("feature.txt", "x\n");
		await commitAll("add feature.txt");
		await checkout("main");
		await branchOff("feature");
		mkdirSync(join(repo, "ui"));
		await writeFile("ui/app.tsx", "committed\n");
		await commitAll("add ui");
		await writeFile("ui/app.tsx", "unsaved edit\n");
		const headBefore = (await git("rev-parse", "HEAD")).trim();

		await expect(mergeBranch(repo, "agentplate/w", "ui")).rejects.toBeInstanceOf(WorktreeError);
		await expect(predictMerge(repo, "agentplate/w", "ui")).rejects.toBeInstanceOf(WorktreeError);

		// No pathspec checkout: the unsaved edit survives, no merge landed on `feature`.
		expect(await readFile("ui/app.tsx")).toBe("unsaved edit\n");
		expect(await headBranch()).toBe("feature");
		expect((await git("rev-parse", "HEAD")).trim()).toBe(headBefore);
	});

	test("revision syntax, option-like, and missing names are refused", async () => {
		await branchOff("agentplate/w");
		await writeFile("feature.txt", "x\n");
		await commitAll("add feature.txt");
		await checkout("main");

		for (const bad of ["main~1", "-q", "--help", "nope", ""]) {
			await expect(mergeBranch(repo, "agentplate/w", bad)).rejects.toBeInstanceOf(WorktreeError);
			await expect(mergeBranch(repo, bad, "main")).rejects.toBeInstanceOf(WorktreeError);
		}
		expect(await headBranch()).toBe("main");
		expect(await Bun.file(join(repo, "feature.txt")).exists()).toBe(false);
	});
});

describe("mergeBranch — auto-resolve stages only conflicted files", () => {
	/** Branch conflicts with main on file.txt; main also tracks notes.md. */
	async function makeConflict(): Promise<void> {
		await writeFile("notes.md", "committed notes\n");
		await commitAll("add notes");
		await branchOff("agentplate/w");
		await writeFile("file.txt", "BRANCH\nline2\nline3\n");
		await commitAll("branch edit");
		await checkout("main");
		await writeFile("file.txt", "MAIN\nline2\nline3\n");
		await commitAll("main edit");
	}

	test("operator files and .agentplate/merge.lock never enter the merge commit", async () => {
		await makeConflict();
		await writeFile("operator-notes.txt", "private\n"); // untracked
		await writeFile("notes.md", "operator wip\n"); // tracked, modified, unstaged

		const result = await withMergeLock(repo, () =>
			mergeBranch(repo, "agentplate/w", "main", { autoResolve: true }),
		);

		expect(result.tier).toBe("auto-resolve");
		expect(await mergeCommitPaths()).toEqual(["file.txt"]);
		const tracked = await git("ls-files");
		expect(tracked).not.toContain("operator-notes.txt");
		expect(tracked).not.toContain(".agentplate");
		// The operator's work is still there, still uncommitted.
		expect(await readFile("notes.md")).toBe("operator wip\n");
		expect(await git("show", "HEAD:notes.md")).toBe("committed notes\n");
		expect(existsSync(join(repo, "operator-notes.txt"))).toBe(true);
		expect(existsSync(join(repo, ".agentplate", "merge.lock"))).toBe(false);
	});

	test("a conflicted file named like a glob does not stage other files", async () => {
		await branchOff("agentplate/w");
		await writeFile("*.txt", "agent\n");
		await commitAll("agent adds *.txt");
		await checkout("main");
		await writeFile("*.txt", "main\n");
		await commitAll("main adds *.txt");
		await writeFile("operator.txt", "untracked\n");

		const result = await mergeBranch(repo, "agentplate/w", "main", { autoResolve: true });

		expect(result.conflictFiles).toEqual(["*.txt"]);
		expect(await mergeCommitPaths()).toEqual(["*.txt"]);
		expect((await git("status", "--porcelain")).trim()).toBe("?? operator.txt");
	});

	test("conflicts inside .agentplate/ are never auto-resolved", async () => {
		mkdirSync(join(repo, ".agentplate"));
		await writeFile(".agentplate/config.yaml", "base: 1\n");
		await commitAll("add config");
		await branchOff("agentplate/w");
		await writeFile(".agentplate/config.yaml", "agent: overwrite\n");
		await commitAll("agent edits config");
		await checkout("main");
		await writeFile(".agentplate/config.yaml", "operator: 2\n");
		await commitAll("operator edits config");
		const headBefore = (await git("rev-parse", "HEAD")).trim();

		const prediction = await predictMerge(repo, "agentplate/w", "main");
		expect(prediction.status).toBe("failed");
		expect(prediction.conflictFiles).toEqual([".agentplate/config.yaml"]);

		const result = await mergeBranch(repo, "agentplate/w", "main", { autoResolve: true });
		expect(result.status).toBe("failed");
		expect(result.tier).toBeNull();
		expect(await mergeHeadExists()).toBe(false);
		expect((await git("rev-parse", "HEAD")).trim()).toBe(headBefore);
		expect(await readFile(".agentplate/config.yaml")).toBe("operator: 2\n");
	});
});

describe("mergeBranch — modify/delete and mid-merge failures", () => {
	test("branch-deleted vs target-modified resolves to the deletion (keep-theirs)", async () => {
		await writeFile("x.txt", "x\n");
		await writeFile("y.txt", "y\n");
		await commitAll("add x, y");
		await branchOff("agentplate/w");
		await git("rm", "-q", "x.txt"); // branch deletes x
		await writeFile("y.txt", "agent y\n"); // branch modifies y
		await commitAll("agent: rm x, edit y");
		await checkout("main");
		await writeFile("x.txt", "main x\n"); // main modifies x
		await git("rm", "-q", "y.txt"); // main deletes y
		await commitAll("main: edit x, rm y");

		const result = await mergeBranch(repo, "agentplate/w", "main", { autoResolve: true });

		expect(result.status).toBe("merged");
		expect(result.tier).toBe("auto-resolve");
		expect([...result.conflictFiles].sort()).toEqual(["x.txt", "y.txt"]);
		expect(existsSync(join(repo, "x.txt"))).toBe(false);
		expect(await readFile("y.txt")).toBe("agent y\n");
		expect(await mergeHeadExists()).toBe(false);
		expect((await git("status", "--porcelain")).trim()).toBe("");
	});

	test("a failure while committing the resolution aborts the merge (no MERGE_HEAD)", async () => {
		await branchOff("agentplate/w");
		await writeFile("file.txt", "BRANCH\nline2\nline3\n");
		await commitAll("branch edit");
		await checkout("main");
		await writeFile("file.txt", "MAIN\nline2\nline3\n");
		await commitAll("main edit");
		await branchOff("agentplate/other");
		await writeFile("other.txt", "o\n");
		await commitAll("other");
		await checkout("main");
		const headBefore = (await git("rev-parse", "HEAD")).trim();
		// A rejecting pre-commit hook makes `git commit --no-edit` fail mid-merge.
		const hook = join(repo, ".git", "hooks", "pre-commit");
		await Bun.write(hook, "#!/bin/sh\nexit 1\n");
		chmodSync(hook, 0o755);

		await expect(
			mergeBranch(repo, "agentplate/w", "main", { autoResolve: true }),
		).rejects.toThrow();

		expect(await mergeHeadExists()).toBe(false);
		expect((await git("rev-parse", "HEAD")).trim()).toBe(headBefore);
		expect(await readFile("file.txt")).toBe("MAIN\nline2\nline3\n");

		// The repo is not wedged: an unrelated merge still works afterwards.
		rmSync(hook);
		const next = await mergeBranch(repo, "agentplate/other", "main", { autoResolve: true });
		expect(next.status).toBe("merged");
		expect(next.tier).toBe("clean-merge");
	});

	test("refuses to start over an existing merge and leaves it intact", async () => {
		await startConflictingMerge();

		await expect(
			mergeBranch(repo, "agentplate/b", "main", { autoResolve: true }),
		).rejects.toBeInstanceOf(WorktreeError);

		expect(await mergeHeadExists()).toBe(true);
		expect(await readFile("file.txt")).toContain("<<<<<<<");
	});
});
