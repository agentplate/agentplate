import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { WorktreeError } from "../errors.ts";
import { createWorktree, listWorktrees, removeWorktree, worktreeExists } from "./manager.ts";

// We use REAL git repos in temp dirs (no mocks) so the porcelain parsing and
// `git worktree` semantics are exercised exactly as in production.

/** Run git in `cwd`, fail the test helper loudly on non-zero exit. */
async function runGit(cwd: string, args: string[]): Promise<string> {
	const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
	const [stdout, stderr, code] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	if (code !== 0) {
		throw new Error(`git ${args.join(" ")} failed (${code}): ${stderr.trim()}`);
	}
	return stdout.trim();
}

/**
 * Create a real git repo in a fresh temp dir with a deterministic identity and
 * one initial commit (so HEAD exists and worktrees have a base to branch from).
 */
async function createTempGitRepo(): Promise<string> {
	// realpathSync resolves symlinks in the temp root. On macOS tmpdir() is
	// /tmp -> /private/tmp; `git worktree list --porcelain` reports the resolved
	// form, so we canonicalize here to keep the test's constructed paths in sync
	// with git's output (createWorktree itself is path-agnostic — it just joins).
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "agentplate-wt-")));
	await runGit(dir, ["init"]);
	// Pin a deterministic identity so commits succeed in CI.
	await runGit(dir, ["config", "user.email", "test@agentplate.dev"]);
	await runGit(dir, ["config", "user.name", "Agentplate Test"]);
	writeFileSync(join(dir, "README.md"), "# temp repo\n");
	await runGit(dir, ["add", "README.md"]);
	await runGit(dir, ["commit", "-m", "initial commit"]);
	// Force the initial branch to "main" regardless of the host's
	// init.defaultBranch (master vs main). `branch -M` renames in place and is a
	// no-op-safe rename even if the branch is already called "main", so this is
	// portable across git versions.
	await runGit(dir, ["branch", "-M", "main"]);
	return dir;
}

describe("worktree manager", () => {
	let repoRoot: string;

	beforeEach(async () => {
		repoRoot = await createTempGitRepo();
	});

	afterEach(() => {
		rmSync(repoRoot, { recursive: true, force: true });
	});

	test("createWorktree creates the dir on the right branch and returns its path", async () => {
		const result = await createWorktree(repoRoot, "alice", "agent/alice");

		const expectedPath = join(repoRoot, ".agentplate", "worktrees", "alice");
		expect(result.path).toBe(expectedPath);
		expect(result.branchName).toBe("agent/alice");

		// The directory exists on disk.
		expect(await worktreeExists(repoRoot, expectedPath)).toBe(true);

		// HEAD inside the worktree resolves to the new branch.
		const currentBranch = await runGit(result.path, ["rev-parse", "--abbrev-ref", "HEAD"]);
		expect(currentBranch).toBe("agent/alice");
	});

	test("createWorktree creates the .agentplate/worktrees parent if missing", async () => {
		// No pre-existing .agentplate dir — createWorktree must mkdir -p the parents.
		const result = await createWorktree(repoRoot, "bob", "agent/bob");
		expect(await worktreeExists(repoRoot, result.path)).toBe(true);
	});

	test("createWorktree throws WorktreeError when the path already exists", async () => {
		await createWorktree(repoRoot, "dup", "agent/dup-1");

		// A second create for the same agent name targets the same dir -> collide.
		await expect(createWorktree(repoRoot, "dup", "agent/dup-2")).rejects.toBeInstanceOf(
			WorktreeError,
		);
	});

	test("createWorktree branches off an explicit baseBranch", async () => {
		// Make a divergent branch with a marker file, return to main.
		await runGit(repoRoot, ["checkout", "-b", "feature-base"]);
		writeFileSync(join(repoRoot, "marker.txt"), "from base\n");
		await runGit(repoRoot, ["add", "marker.txt"]);
		await runGit(repoRoot, ["commit", "-m", "base-only commit"]);
		await runGit(repoRoot, ["checkout", "main"]);

		const result = await createWorktree(repoRoot, "carol", "agent/carol", "feature-base");

		// The worktree should see the marker file that only exists on feature-base.
		expect(await worktreeExists(repoRoot, join(result.path, "marker.txt"))).toBe(true);
	});

	test("listWorktrees parses porcelain output including the main worktree", async () => {
		await createWorktree(repoRoot, "alice", "agent/alice");

		const list = await listWorktrees(repoRoot);

		// Main worktree + the one we created.
		expect(list.length).toBe(2);

		const alice = list.find((w) => w.branch === "agent/alice");
		expect(alice).toBeDefined();
		expect(alice?.path).toBe(join(repoRoot, ".agentplate", "worktrees", "alice"));
		// HEAD is a 40-char SHA.
		expect(alice?.head).toMatch(/^[0-9a-f]{40}$/);

		const mainEntry = list.find((w) => w.branch === "main");
		expect(mainEntry).toBeDefined();
	});

	test("a commit made inside the worktree is visible on its branch", async () => {
		const { path: wtPath } = await createWorktree(repoRoot, "writer", "agent/writer");

		// Commit a file from INSIDE the worktree.
		writeFileSync(join(wtPath, "work.txt"), "agent output\n");
		await runGit(wtPath, ["add", "work.txt"]);
		await runGit(wtPath, ["commit", "-m", "agent work"]);

		// The branch tip (queried from the main repo) must contain that commit.
		const subject = await runGit(repoRoot, ["log", "-1", "--format=%s", "agent/writer"]);
		expect(subject).toBe("agent work");

		// And the file is part of that branch's tree.
		const tree = await runGit(repoRoot, ["ls-tree", "--name-only", "agent/writer"]);
		expect(tree.split("\n")).toContain("work.txt");
	});

	test("worktreeExists reflects creation and removal", async () => {
		const missing = join(repoRoot, ".agentplate", "worktrees", "ghost");
		expect(await worktreeExists(repoRoot, missing)).toBe(false);

		const { path } = await createWorktree(repoRoot, "ghost", "agent/ghost");
		expect(await worktreeExists(repoRoot, path)).toBe(true);

		await removeWorktree(repoRoot, path);
		expect(await worktreeExists(repoRoot, path)).toBe(false);
	});

	test("removeWorktree removes a clean worktree without force", async () => {
		const { path } = await createWorktree(repoRoot, "tmp", "agent/tmp");

		await removeWorktree(repoRoot, path);

		// Gone from disk...
		expect(await worktreeExists(repoRoot, path)).toBe(false);
		// ...and de-registered from git's worktree list.
		const list = await listWorktrees(repoRoot);
		expect(list.find((w) => w.path === path)).toBeUndefined();
	});

	test("removeWorktree requires force when the worktree is dirty", async () => {
		const { path } = await createWorktree(repoRoot, "dirty", "agent/dirty");

		// Introduce an uncommitted change; git refuses a non-forced remove.
		writeFileSync(join(path, "scratch.txt"), "uncommitted\n");

		await expect(removeWorktree(repoRoot, path)).rejects.toBeInstanceOf(WorktreeError);

		// With force it succeeds.
		await removeWorktree(repoRoot, path, { force: true });
		expect(await worktreeExists(repoRoot, path)).toBe(false);
	});

	test("removeWorktree throws WorktreeError for an unknown path", async () => {
		const bogus = join(repoRoot, ".agentplate", "worktrees", "does-not-exist");
		await expect(removeWorktree(repoRoot, bogus)).rejects.toBeInstanceOf(WorktreeError);
	});
});
