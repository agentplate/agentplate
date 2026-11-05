/**
 * Branch merge with tiered conflict resolution.
 *
 * Two execution paths share the same git primitives:
 *
 *   mergeBranch()   — mutating. Checks out the target branch and runs a real
 *                     `git merge`. On conflict it either auto-resolves (only
 *                     when that loses nothing — see below) or aborts cleanly.
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
 *   auto-resolve  — conflicts existed, and for EVERY conflicted file the target
 *                   side is unchanged from the merge base (index stage 2 ==
 *                   stage 1). Only then do we take the incoming branch's version
 *                   (`git checkout --theirs`, or `git rm` when the branch deleted
 *                   it), stage ONLY those files, and commit. Conflicts inside
 *                   `.agentplate/` are never auto-resolved.
 *
 * WHY auto-resolve is this narrow: taking "theirs" for a whole file discards
 * every change the target made to it — including hunks git had already merged
 * cleanly, i.e. other agents' work that already landed. There is no AI
 * resolution tier yet (ai-resolve is reserved), so a conflicted file that the
 * target side also changed is never resolved automatically: the merge is
 * aborted and reported as failed with those files listed, for a human (or a
 * later tier) to resolve. In practice ordinary content conflicts (both sides
 * edited the file) therefore fail; auto-resolve only applies to the rare shapes
 * where git flags a conflict yet the target's copy is still the base version.
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

/**
 * Index stages of one unmerged path, each as "<mode> <oid>" (absent when that
 * side has no version of the path: added on one side only, or deleted).
 */
interface UnmergedEntry {
	path: string;
	base?: string;
	ours?: string;
	theirs?: string;
}

/**
 * Group `ls-files -u -z` / `merge-tree --write-tree -z` conflict entries
 * ("<mode> <oid> <stage>\t<path>") by path, preserving first-seen order.
 * Exported for tests.
 */
export function parseUnmergedEntries(entries: string[]): UnmergedEntry[] {
	const byPath = new Map<string, UnmergedEntry>();
	for (const entry of entries) {
		const tab = entry.indexOf("\t");
		if (tab === -1) continue;
		const [mode, oid, stage] = entry.slice(0, tab).split(" ");
		const path = entry.slice(tab + 1);
		let rec = byPath.get(path);
		if (!rec) {
			rec = { path };
			byPath.set(path, rec);
		}
		const version = `${mode} ${oid}`;
		if (stage === "1") rec.base = version;
		else if (stage === "2") rec.ours = version;
		else if (stage === "3") rec.theirs = version;
	}
	return [...byPath.values()];
}

/** How auto-resolve would treat each conflicted path. */
interface AutoResolvePlan {
	/** Target unchanged vs base, branch has a version: take theirs. */
	keep: string[];
	/** Target unchanged vs base, branch deleted it: take the deletion. */
	remove: string[];
	/** Target changed the path too: taking theirs would lose landed work. */
	unsafe: string[];
}

/**
 * Decide, per conflicted path, whether keep-theirs is lossless. It is only when
 * the target's version (stage 2) exists and is identical to the merge base's
 * (stage 1): then the target contributed nothing to that path that taking the
 * branch's version could discard. Anything else — the target edited, added, or
 * deleted the path — is unsafe. Exported for tests.
 */
export function planAutoResolve(entries: UnmergedEntry[]): AutoResolvePlan {
	const plan: AutoResolvePlan = { keep: [], remove: [], unsafe: [] };
	for (const e of entries) {
		const targetUnchanged = e.base !== undefined && e.ours === e.base;
		if (!targetUnchanged) plan.unsafe.push(e.path);
		else if (e.theirs !== undefined) plan.keep.push(e.path);
		else plan.remove.push(e.path);
	}
	return plan;
}

/** Files currently in an unmerged (conflicted) state in the index. */
async function conflictedFiles(repoRoot: string): Promise<string[]> {
	const { stdout } = await runGit(repoRoot, ["diff", "--name-only", "-z", "--diff-filter=U"]);
	return parseNulList(stdout);
}

/** The unmerged index entries of the in-progress merge, grouped by path. */
async function unmergedEntries(repoRoot: string): Promise<UnmergedEntry[]> {
	const { stdout } = await runGitChecked(repoRoot, ["ls-files", "-u", "-z"]);
	return parseUnmergedEntries(parseNulList(stdout));
}

/** Why auto-resolve refuses conflicts the target side also changed. */
function unsafeMessage(unsafe: string[]): string {
	return `the target also changed ${unsafe.length} conflicted file(s) (${unsafe.join(", ")}); taking the incoming version would discard work already on the target, so they must be resolved manually`;
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
 * Apply a fully-safe {@link AutoResolvePlan} (no `unsafe` paths) and stage
 * exactly the conflicted paths.
 *
 * Only the conflicted files are staged (never `git add -A`): the root checkout
 * may hold unrelated untracked/modified operator files and Agentplate runtime
 * state (`.agentplate/merge.lock`), none of which belong in the merge commit.
 * `--literal-pathspecs` keeps a file literally named e.g. `*.ts` from matching
 * other paths.
 */
async function resolveKeepTheirs(repoRoot: string, plan: AutoResolvePlan): Promise<void> {
	const { keep, remove } = plan;
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
 *   committed (tier "auto-resolve") — but only if no conflicted file was also
 *   changed on the target (see the module doc); otherwise the merge is aborted
 *   and reported as failed with the files listed. When false (default), any
 *   conflicting merge is aborted and reported as failed. Either way a failed
 *   merge leaves the repo with no in-progress merge.
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
	// non-interactively (no editor in a headless context). The full ref keeps a
	// same-named tag (`refs/tags/<name>`) from being merged instead of the
	// branch that assertLocalBranch validated.
	const merge = await runGit(repoRoot, [
		"merge",
		"--no-ff",
		"--no-edit",
		`refs/heads/${branchName}`,
	]);

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
	// files, and commit the in-progress merge with its default message — but
	// only if that is lossless for every file. Any failure part-way (a hook, an
	// unexpected conflict shape) aborts the merge we started so the root
	// checkout is never left half-merged.
	try {
		const plan = planAutoResolve(await unmergedEntries(repoRoot));
		if (plan.unsafe.length > 0) {
			await runGitChecked(repoRoot, ["merge", "--abort"]);
			return {
				branchName,
				status: "failed",
				tier: null,
				conflictFiles: conflicts,
				message: `Merge of ${branchName} into ${targetBranch} not auto-resolved: ${unsafeMessage(plan.unsafe)}. Merge aborted.`,
			};
		}
		await resolveKeepTheirs(repoRoot, plan);
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
		message: `Merged ${branchName} into ${targetBranch}; auto-resolved ${conflicts.length} conflict(s) the target had not changed by keeping incoming changes.`,
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
 * Mirrors {@link mergeBranch} given the same `opts`:
 *   - clean                     -> "pending", tier "clean-merge"
 *   - conflict, auto-resolvable -> "pending", tier "auto-resolve", files listed
 *   - any other conflict (auto-resolve off, `.agentplate/` state, or the target
 *     also changed a conflicted file) -> "failed", tier null, files listed
 */
export async function predictMerge(
	repoRoot: string,
	branchName: string,
	targetBranch: string,
	opts: { autoResolve?: boolean } = {},
): Promise<MergeResult> {
	// Validate first: merge-tree reports a missing branch with exit 1, the same
	// code it uses for "conflicts".
	await assertLocalBranch(repoRoot, branchName);
	await assertLocalBranch(repoRoot, targetBranch);

	const trial = await runGit(repoRoot, [
		"merge-tree",
		"--write-tree",
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

	// Exit 1 = conflicts; `-z` output is "<tree-oid>\0" then one
	// "<mode> <oid> <stage>\t<path>\0" entry per conflicted stage — the same
	// shape as `ls-files -u -z`, so the same auto-resolve plan applies.
	const entries =
		trial.exitCode === 1 ? parseUnmergedEntries(parseNulList(trial.stdout).slice(1)) : [];
	const conflicts = entries.map((e) => e.path);
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

	if (!opts.autoResolve) {
		return {
			branchName,
			status: "failed",
			tier: null,
			conflictFiles: conflicts,
			message: `${branchName} would conflict with ${targetBranch} in ${conflicts.length} file(s); auto-resolve disabled, the merge would be aborted.`,
		};
	}

	const plan = planAutoResolve(entries);
	if (plan.unsafe.length > 0) {
		return {
			branchName,
			status: "failed",
			tier: null,
			conflictFiles: conflicts,
			message: `${branchName} would conflict with ${targetBranch} and not be auto-resolved: ${unsafeMessage(plan.unsafe)}.`,
		};
	}

	return {
		branchName,
		status: "pending",
		tier: "auto-resolve",
		conflictFiles: conflicts,
		message: `${branchName} would conflict with ${targetBranch} in ${conflicts.length} file(s) the target has not changed; auto-resolve would keep incoming changes.`,
	};
}
