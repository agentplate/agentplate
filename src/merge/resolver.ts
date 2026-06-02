/**
 * Branch merge with tiered conflict resolution.
 *
 * Two execution paths share the same git primitives:
 *
 *   mergeBranch()   — mutating. Checks out the target branch and runs a real
 *                     `git merge`. On conflict it either auto-resolves
 *                     (keep-theirs) or aborts cleanly, depending on `opts`.
 *   predictMerge()  — side-effect-free. Reports whether a merge WOULD conflict
 *                     and which tier would apply, WITHOUT touching HEAD or the
 *                     working tree. Used by `agentplate merge --dry-run`.
 *
 * Resolution tiers (this module implements the first two; "ai-resolve" /
 * "reimagine" from {@link MergeTier} are reserved for a later phase):
 *
 *   clean-merge   — `git merge --no-ff` succeeded with no conflicts.
 *   auto-resolve  — conflicts existed; we took the incoming branch's version of
 *                   every conflicted file (`git checkout --theirs`) and
 *                   committed. This is "agent work wins", matching the
 *                   orchestration model where the branch is the source of truth.
 *
 * WHY keep-theirs for auto-resolve: agent worktrees are branched from the
 * target and own an exclusive file scope, so when a conflict does occur the
 * branch side is the intended change and the target side is stale. Taking
 * "theirs" wholesale is the deterministic, no-LLM resolution. Semantically
 * risky conflicts are a future-phase concern (ai-resolve).
 */

import { SubprocessError, WorktreeError } from "../errors.ts";
import type { MergeResult } from "../types.ts";

/** Result of running a git subprocess. */
interface GitResult {
	stdout: string;
	stderr: string;
	exitCode: number;
}

/**
 * Run a git command in `repoRoot` and capture its output. Never throws on a
 * non-zero exit — callers inspect `exitCode` because for git a non-zero exit is
 * frequently expected (a merge conflict is exit 1, not a crash).
 */
async function runGit(repoRoot: string, args: string[]): Promise<GitResult> {
	const proc = Bun.spawn(["git", ...args], {
		cwd: repoRoot,
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	return { stdout, stderr, exitCode };
}

/**
 * Run a git command that is expected to succeed. Throws {@link SubprocessError}
 * (carrying the git exit code) on any non-zero exit. Use this only for steps
 * where a failure is genuinely exceptional (checkout of an existing branch,
 * staging, committing a resolution).
 */
async function runGitChecked(repoRoot: string, args: string[]): Promise<GitResult> {
	const result = await runGit(repoRoot, args);
	if (result.exitCode !== 0) {
		throw new SubprocessError(
			`git ${args.join(" ")} failed (exit ${result.exitCode}): ${result.stderr.trim()}`,
			result.exitCode,
		);
	}
	return result;
}

/**
 * Split git's newline-delimited path output into a clean array, dropping the
 * trailing empty entry that a final newline produces.
 */
function parsePathList(stdout: string): string[] {
	return stdout
		.trim()
		.split("\n")
		.filter((line) => line.length > 0);
}

/** Files currently in an unmerged (conflicted) state in the index. */
async function conflictedFiles(repoRoot: string): Promise<string[]> {
	const { stdout } = await runGit(repoRoot, ["diff", "--name-only", "--diff-filter=U"]);
	return parsePathList(stdout);
}

/** True if a merge is currently in progress (MERGE_HEAD exists). */
async function mergeInProgress(repoRoot: string): Promise<boolean> {
	// `git rev-parse --verify -q MERGE_HEAD` exits 0 iff a merge is in progress.
	const { exitCode } = await runGit(repoRoot, ["rev-parse", "--verify", "-q", "MERGE_HEAD"]);
	return exitCode === 0;
}

/** The short name of the currently checked-out branch (empty if detached). */
async function currentBranch(repoRoot: string): Promise<string> {
	const { stdout, exitCode } = await runGit(repoRoot, ["symbolic-ref", "--short", "-q", "HEAD"]);
	return exitCode === 0 ? stdout.trim() : "";
}

/**
 * Ensure `branch` is the checked-out branch. No-op when already on it — this
 * avoids git's "already checked out / would overwrite" error when the target is
 * current (common when merging straight into the session branch).
 */
async function ensureOnBranch(repoRoot: string, branch: string): Promise<void> {
	if ((await currentBranch(repoRoot)) === branch) return;
	const { exitCode, stderr } = await runGit(repoRoot, ["checkout", branch]);
	if (exitCode !== 0) {
		throw new WorktreeError(`Failed to checkout "${branch}": ${stderr.trim()}`);
	}
}

/**
 * Merge `branchName` into `targetBranch`, resolving conflicts per `opts`.
 *
 * Always returns a {@link MergeResult} (never throws for the ordinary
 * conflict/failure case) so the caller can record an outcome uniformly. It does
 * throw {@link WorktreeError}/{@link SubprocessError} for genuine git failures
 * that are not "this branch conflicts" (e.g. the target branch does not exist).
 *
 * @param opts.autoResolve When true, conflicts are resolved keep-theirs and
 *   committed (tier "auto-resolve"). When false (default), a conflicting merge
 *   is aborted and reported as failed, leaving the repo with no in-progress
 *   merge.
 */
export async function mergeBranch(
	repoRoot: string,
	branchName: string,
	targetBranch: string,
	opts: { autoResolve?: boolean } = {},
): Promise<MergeResult> {
	await ensureOnBranch(repoRoot, targetBranch);

	// --no-ff: always create a merge commit so the branch's history is preserved
	// as a distinct unit. --no-edit: accept the default merge message
	// non-interactively (no editor in a headless context).
	const merge = await runGit(repoRoot, ["merge", "--no-ff", "--no-edit", branchName]);

	if (merge.exitCode === 0) {
		return {
			branchName,
			status: "merged",
			tier: "clean-merge",
			conflictFiles: [],
			message: `Merged ${branchName} into ${targetBranch} cleanly.`,
		};
	}

	// Non-zero exit: capture the conflict set. If git failed for a reason other
	// than a content conflict (e.g. it refused to start the merge), there will be
	// no unmerged files — surface that as a typed error rather than a silent
	// "failed with no conflicts".
	const conflicts = await conflictedFiles(repoRoot);
	if (conflicts.length === 0) {
		// Abort any half-started merge so we never leave the repo wedged.
		if (await mergeInProgress(repoRoot)) {
			await runGit(repoRoot, ["merge", "--abort"]);
		}
		throw new SubprocessError(
			`git merge of ${branchName} into ${targetBranch} failed without conflicts: ${merge.stderr.trim()}`,
			merge.exitCode,
		);
	}

	if (!opts.autoResolve) {
		// Leave the repo exactly as we found it: abort the merge so there is no
		// MERGE_HEAD and `git status` is clean for the next caller.
		await runGitChecked(repoRoot, ["merge", "--abort"]);
		return {
			branchName,
			status: "failed",
			tier: null,
			conflictFiles: conflicts,
			message: `Merge of ${branchName} into ${targetBranch} conflicts in ${conflicts.length} file(s); auto-resolve disabled, merge aborted.`,
		};
	}

	// Auto-resolve: take the incoming branch's version of each conflicted file.
	// `--theirs` during a merge refers to the branch being merged in (branchName).
	for (const file of conflicts) {
		await runGitChecked(repoRoot, ["checkout", "--theirs", "--", file]);
	}
	// Stage everything (including any deletes/renames the resolution implies) and
	// commit the in-progress merge with its default message.
	await runGitChecked(repoRoot, ["add", "-A"]);
	await runGitChecked(repoRoot, ["commit", "--no-edit"]);

	return {
		branchName,
		status: "merged",
		tier: "auto-resolve",
		conflictFiles: conflicts,
		message: `Merged ${branchName} into ${targetBranch}; auto-resolved ${conflicts.length} conflict(s) by keeping incoming changes.`,
	};
}

/**
 * Predict the outcome of merging `branchName` into `targetBranch` WITHOUT
 * changing HEAD or the working tree.
 *
 * Strategy: a trial `git merge --no-commit --no-ff` followed unconditionally by
 * `git merge --abort`. We deliberately do NOT use `git merge-tree` here so the
 * prediction exercises the same merge machinery the real run does (identical
 * rename/conflict detection), and because `--no-commit` works on every git
 * version we support. The `--abort` in the `finally` guarantees the repo is
 * restored even if parsing throws.
 *
 * Returned status is "pending" (a prediction, not a completed merge):
 *   - clean    -> tier "clean-merge", no conflict files
 *   - conflict -> tier "auto-resolve" (what mergeBranch would apply), files listed
 */
export async function predictMerge(
	repoRoot: string,
	branchName: string,
	targetBranch: string,
): Promise<MergeResult> {
	await ensureOnBranch(repoRoot, targetBranch);

	// `--no-commit` still applies the merge to the index/worktree, so we MUST
	// undo it. `--no-ff` forces the merge machinery even for fast-forwardable
	// branches, matching mergeBranch's behavior.
	const trial = await runGit(repoRoot, ["merge", "--no-commit", "--no-ff", branchName]);
	try {
		if (trial.exitCode === 0) {
			return {
				branchName,
				status: "pending",
				tier: "clean-merge",
				conflictFiles: [],
				message: `${branchName} would merge into ${targetBranch} cleanly.`,
			};
		}

		const conflicts = await conflictedFiles(repoRoot);
		if (conflicts.length === 0) {
			// Non-zero exit with no unmerged files means git refused the merge for
			// a structural reason (e.g. unrelated histories). Report it as a failure
			// prediction rather than inventing a tier.
			return {
				branchName,
				status: "failed",
				tier: null,
				conflictFiles: [],
				message: `${branchName} cannot be merged into ${targetBranch}: ${trial.stderr.trim()}`,
			};
		}

		return {
			branchName,
			status: "pending",
			tier: "auto-resolve",
			conflictFiles: conflicts,
			message: `${branchName} would conflict with ${targetBranch} in ${conflicts.length} file(s); auto-resolve would keep incoming changes.`,
		};
	} finally {
		// Restore HEAD/index/worktree no matter what. A trial merge that
		// fast-forwarded or fully applied leaves MERGE_HEAD unset, in which case
		// `merge --abort` is a harmless no-op error we ignore; when there are
		// staged-but-uncommitted merge changes, it rewinds them.
		if (await mergeInProgress(repoRoot)) {
			await runGit(repoRoot, ["merge", "--abort"]);
		} else {
			// A --no-commit merge that did not record MERGE_HEAD (rare) can still
			// leave staged changes; hard-reset to HEAD to guarantee a clean tree
			// without altering committed history.
			await runGit(repoRoot, ["reset", "--hard", "HEAD"]);
		}
	}
}
