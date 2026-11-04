/**
 * Branch merge with tiered conflict resolution.
 *
 * Two execution paths share the same git primitives:
 *
 *   mergeBranch()   — mutating. Checks out the target branch and runs a real
 *                     `git merge`. On conflict it either auto-resolves
 *                     (keep-theirs) or aborts cleanly, depending on `opts`.
 *   predictMerge()  — read-only. Reports whether a merge WOULD conflict and
 *                     which tier would apply via `git merge-tree --write-tree`,
 *                     which never touches HEAD, the index, or the working tree
 *                     (so it needs no merge lock). Used by `agentplate merge --dry-run`.
 *
 * Both validate that the source and target are existing LOCAL branches before
 * running anything, so a typo or a path-like name (`ui`, `-x`) can never be read
 * by git as a pathspec or an option.
 *
 * Resolution tiers (this module implements the first two; "ai-resolve" /
 * "reimagine" from {@link MergeTier} are reserved for a later phase):
 *
 *   clean-merge   — `git merge --no-ff` succeeded with no conflicts.
 *   auto-resolve  — conflicts existed; we took the incoming branch's version of
 *                   every conflicted file (`git checkout --theirs`, or `git rm`
 *                   when the branch deleted it), staged ONLY those files, and
 *                   committed. This is "agent work wins", matching the
 *                   orchestration model where the branch is the source of truth.
 *                   Conflicts inside `.agentplate/` are never auto-resolved.
 *
 * WHY keep-theirs for auto-resolve: agent worktrees are branched from the
 * target and own an exclusive file scope, so when a conflict does occur the
 * branch side is the intended change and the target side is stale. Taking
 * "theirs" wholesale is the deterministic, no-LLM resolution. Semantically
 * risky conflicts are a future-phase concern (ai-resolve).
 */

import { AGENTPLATE_DIR } from "../config.ts";
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
 * Split git's NUL-delimited (`-z`) path output into a clean array. `-z` paths
 * are verbatim (never C-quoted), so they can be passed straight back to git.
 */
function parseNulList(stdout: string): string[] {
	return stdout.split("\0").filter((entry) => entry.length > 0);
}

/** Files currently in an unmerged (conflicted) state in the index. */
async function conflictedFiles(repoRoot: string): Promise<string[]> {
	const { stdout } = await runGit(repoRoot, ["diff", "--name-only", "-z", "--diff-filter=U"]);
	return parseNulList(stdout);
}

/**
 * Paths whose incoming ("theirs", index stage 3) version exists, among the
 * currently unmerged entries. A conflicted path missing from this set was
 * deleted on the incoming branch (modify/delete, delete/delete).
 */
async function pathsWithTheirVersion(repoRoot: string): Promise<Set<string>> {
	// `ls-files -u -z` entries are "<mode> <oid> <stage>\t<path>".
	const { stdout } = await runGitChecked(repoRoot, ["ls-files", "-u", "-z"]);
	const theirs = new Set<string>();
	for (const entry of parseNulList(stdout)) {
		const tab = entry.indexOf("\t");
		if (tab === -1) continue;
		const stage = entry.slice(0, tab).split(" ")[2];
		if (stage === "3") theirs.add(entry.slice(tab + 1));
	}
	return theirs;
}

/** True if `path` (repo-relative) lives in Agentplate's own state directory. */
function isAgentplateStatePath(path: string): boolean {
	return path === AGENTPLATE_DIR || path.startsWith(`${AGENTPLATE_DIR}/`);
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
 * Throw {@link WorktreeError} unless `name` is an existing local branch.
 *
 * WHY `show-ref --verify` on `refs/heads/<name>` (not `rev-parse`): it requires
 * an exact ref, so revision syntax (`main~1`, `main^{tree}`), tags, and remote
 * names are all rejected, and a name that is really a file or directory (`ui`)
 * can never fall through to `git checkout`'s pathspec mode. A leading "-" is
 * rejected outright — git never creates such branches, and it would be parsed
 * as an option by the commands below.
 */
async function assertLocalBranch(repoRoot: string, name: string): Promise<void> {
	if (name.length === 0 || name.startsWith("-")) {
		throw new WorktreeError(`Invalid branch name "${name}".`);
	}
	const { exitCode } = await runGit(repoRoot, [
		"show-ref",
		"--verify",
		"--quiet",
		`refs/heads/${name}`,
	]);
	if (exitCode !== 0) {
		throw new WorktreeError(`"${name}" is not a local branch.`);
	}
}

/**
 * Ensure `branch` (already validated by {@link assertLocalBranch}) is the
 * checked-out branch. No-op when already on it — this avoids git's "already
 * checked out / would overwrite" error when the target is current (common when
 * merging straight into the session branch). The trailing `--` pins `branch`
 * as a revision, never a pathspec.
 */
async function ensureOnBranch(repoRoot: string, branch: string): Promise<void> {
	if ((await currentBranch(repoRoot)) === branch) return;
	const { exitCode, stderr } = await runGit(repoRoot, ["checkout", branch, "--"]);
	if (exitCode !== 0) {
		throw new WorktreeError(`Failed to checkout "${branch}": ${stderr.trim()}`);
	}
}

/**
 * Resolve every conflicted path keep-theirs and stage exactly those paths.
 *
 * Only the conflicted files are staged (never `git add -A`): the root checkout
 * may hold unrelated untracked/modified operator files and Agentplate runtime
 * state (`.agentplate/merge.lock`), none of which belong in the merge commit.
 * `--literal-pathspecs` keeps a file literally named e.g. `*.ts` from matching
 * other paths.
 */
async function resolveKeepTheirs(repoRoot: string, conflicts: string[]): Promise<void> {
	const theirs = await pathsWithTheirVersion(repoRoot);
	const keep = conflicts.filter((file) => theirs.has(file));
	const remove = conflicts.filter((file) => !theirs.has(file));
	if (keep.length > 0) {
		await runGitChecked(repoRoot, ["--literal-pathspecs", "checkout", "--theirs", "--", ...keep]);
		await runGitChecked(repoRoot, ["--literal-pathspecs", "add", "--", ...keep]);
	}
	if (remove.length > 0) {
		// The incoming branch deleted these; keep-theirs means the deletion wins.
		await runGitChecked(repoRoot, ["--literal-pathspecs", "rm", "--quiet", "--", ...remove]);
	}
}

/**
 * Merge `branchName` into `targetBranch`, resolving conflicts per `opts`.
 *
 * Always returns a {@link MergeResult} (never throws for the ordinary
 * conflict/failure case) so the caller can record an outcome uniformly. It does
 * throw {@link WorktreeError}/{@link SubprocessError} for genuine git failures
 * that are not "this branch conflicts" (e.g. either branch does not exist, or a
 * merge is already in progress). Any merge this call started is aborted before
 * it throws, so the repo is never left with a MERGE_HEAD.
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
	await assertLocalBranch(repoRoot, branchName);
	await assertLocalBranch(repoRoot, targetBranch);
	// Never start on top of a merge we don't own: we could neither merge over it
	// nor safely abort it (that would discard someone else's resolution work).
	// This also guarantees any MERGE_HEAD seen below was created by this call.
	if (await mergeInProgress(repoRoot)) {
		throw new WorktreeError(
			`A merge is already in progress in ${repoRoot}; finish it or run \`git merge --abort\` first.`,
		);
	}
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

	// Agentplate's own state (config, agent defs, skills) is never resolved by
	// "agent wins": a branch must not be able to overwrite it via a conflict.
	const stateConflicts = conflicts.filter(isAgentplateStatePath);
	if (stateConflicts.length > 0) {
		await runGitChecked(repoRoot, ["merge", "--abort"]);
		return {
			branchName,
			status: "failed",
			tier: null,
			conflictFiles: conflicts,
			message: `Merge of ${branchName} into ${targetBranch} conflicts in ${AGENTPLATE_DIR}/ (${stateConflicts.join(", ")}); these are never auto-resolved, merge aborted.`,
		};
	}

	// Auto-resolve: take the incoming branch's version of each conflicted file
	// (`--theirs` during a merge is the branch being merged in), stage only those
	// files, and commit the in-progress merge with its default message. Any
	// failure part-way (a hook, an unexpected conflict shape) aborts the merge we
	// started so the root checkout is never left half-merged.
	try {
		await resolveKeepTheirs(repoRoot, conflicts);
		await runGitChecked(repoRoot, ["commit", "--no-edit"]);
	} catch (err) {
		if (await mergeInProgress(repoRoot)) {
			await runGit(repoRoot, ["merge", "--abort"]);
		}
		throw err;
	}

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
 * changing HEAD, the index, or the working tree.
 *
 * Strategy: `git merge-tree --write-tree` (git >= 2.38) runs the same `ort`
 * merge `git merge` does, entirely in the object database, and reports the
 * conflicted paths. Nothing is checked out, staged, reset, or aborted, so the
 * operator's uncommitted work is never at risk and no merge lock is needed (a
 * concurrent real merge's MERGE_HEAD is never touched). Its only side effect is
 * writing the would-be result tree as unreferenced objects, which `git gc`
 * reclaims. It compares the committed branch tips only; uncommitted changes in
 * the root checkout do not affect the prediction.
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
	// Validate first: merge-tree reports a missing branch with exit 1, the same
	// code it uses for "conflicts".
	await assertLocalBranch(repoRoot, branchName);
	await assertLocalBranch(repoRoot, targetBranch);

	const trial = await runGit(repoRoot, [
		"merge-tree",
		"--write-tree",
		"--name-only",
		"--no-messages",
		"-z",
		`refs/heads/${targetBranch}`,
		`refs/heads/${branchName}`,
	]);

	if (trial.exitCode === 0) {
		return {
			branchName,
			status: "pending",
			tier: "clean-merge",
			conflictFiles: [],
			message: `${branchName} would merge into ${targetBranch} cleanly.`,
		};
	}

	if (trial.exitCode === 129) {
		// Pre-2.38 git has no `--write-tree` mode and prints its usage instead.
		throw new SubprocessError(
			"Predicting a merge requires git >= 2.38 (`git merge-tree --write-tree`).",
			trial.exitCode,
		);
	}

	// Exit 1 = conflicts; `-z` output is "<tree-oid>\0<path>\0<path>\0...".
	const conflicts = trial.exitCode === 1 ? parseNulList(trial.stdout).slice(1) : [];
	if (conflicts.length === 0) {
		// Anything else means git refused the merge for a structural reason (e.g.
		// unrelated histories). Report it as a failure prediction rather than
		// inventing a tier.
		return {
			branchName,
			status: "failed",
			tier: null,
			conflictFiles: [],
			message: `${branchName} cannot be merged into ${targetBranch}: ${trial.stderr.trim()}`,
		};
	}

	// Mirror mergeBranch: conflicts in Agentplate's own state are never auto-resolved.
	const stateConflicts = conflicts.filter(isAgentplateStatePath);
	if (stateConflicts.length > 0) {
		return {
			branchName,
			status: "failed",
			tier: null,
			conflictFiles: conflicts,
			message: `${branchName} would conflict with ${targetBranch} in ${AGENTPLATE_DIR}/ (${stateConflicts.join(", ")}); these are never auto-resolved.`,
		};
	}

	return {
		branchName,
		status: "pending",
		tier: "auto-resolve",
		conflictFiles: conflicts,
		message: `${branchName} would conflict with ${targetBranch} in ${conflicts.length} file(s); auto-resolve would keep incoming changes.`,
	};
}
