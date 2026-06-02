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
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
