import { mkdir, stat } from "node:fs/promises";
import { join } from "node:path";

import { SubprocessError, WorktreeError } from "../errors.ts";

// Where every agent's isolated worktree lives, relative to the repo root.
// Mirrors agentplate's layout (.agentplate/worktrees/<agent>) so the rest of
// Agentplate can reason about paths deterministically without consulting git.
const WORKTREES_SUBDIR = join(".agentplate", "worktrees");

/** A single entry parsed from `git worktree list --porcelain`. */
export interface WorktreeEntry {
	/** Absolute path to the worktree directory. */
	path: string;
	/** Branch ref (short name, e.g. "feature/x") or "" for detached HEAD. */
	branch: string;
	/** Commit SHA the worktree currently points at. */
	head: string;
}

/**
 * Run a git subcommand in `repoRoot` and return trimmed stdout.
 *
 * Centralised here (rather than per-function) so every git call shares the same
 * argv-array invocation, output capture, and typed-error handling. We never use
 * a shell string: argv arrays avoid quoting/injection issues entirely.
 *
 * On a non-zero exit we throw SubprocessError carrying stderr so callers (and
 * the higher-level WorktreeError translation) have the real git diagnostic.
 */
async function git(repoRoot: string, args: string[]): Promise<string> {
	const proc = Bun.spawn(["git", ...args], {
		cwd: repoRoot,
		stdout: "pipe",
		stderr: "pipe",
	});

	// Drain both streams before awaiting exit. Reading after `await proc.exited`
	// is fine for small outputs, but draining first avoids any chance of a
	// pipe-buffer stall on large `git worktree list` output.
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);

	if (exitCode !== 0) {
		const detail = stderr.trim() || stdout.trim() || `exit code ${exitCode}`;
		throw new SubprocessError(`git ${args.join(" ")} failed: ${detail}`);
	}

	return stdout.trim();
}

/**
 * Create an isolated git worktree for an agent on a brand-new branch.
 *
 * Layout: `<repoRoot>/.agentplate/worktrees/<agentName>` checked out on a freshly
 * created `branchName` based off `baseBranch` (default: current HEAD).
 *
 * We mkdir the parent (`.agentplate/worktrees`) up front because git refuses to
 * create a worktree under a non-existent parent directory. If the target path
 * already exists we fail fast with WorktreeError rather than letting git emit a
 * confusing "already exists"/"not a valid object" message — a pre-existing path
 * almost always means a stale or duplicate agent and the caller must clean up.
 */
export async function createWorktree(
	repoRoot: string,
	agentName: string,
	branchName: string,
	baseBranch?: string,
): Promise<{ path: string; branchName: string }> {
	const parentDir = join(repoRoot, WORKTREES_SUBDIR);
	const worktreePath = join(parentDir, agentName);

	// Guard against clobbering an existing worktree directory. We check before
	// touching git so the error is precise and no partial state is created.
	if (await worktreeExists(repoRoot, worktreePath)) {
		throw new WorktreeError(`Worktree path already exists: ${worktreePath}`);
	}

	// Ensure `.agentplate/worktrees/` exists (recursive == mkdir -p, no error if
	// the parent chain already exists from a prior agent).
	await mkdir(parentDir, { recursive: true });

	// `git worktree add -b <branch> <path> [<base>]` creates the branch and the
	// worktree atomically. Omitting <base> makes git use the current HEAD, which
	// matches our documented default.
	const addArgs = ["worktree", "add", "-b", branchName, worktreePath];
	if (baseBranch !== undefined) {
		addArgs.push(baseBranch);
	}

	try {
		await git(repoRoot, addArgs);
	} catch (error) {
		// Translate the low-level subprocess failure into the domain error the
		// rest of Agentplate expects, preserving the original git message.
		const message = error instanceof Error ? error.message : String(error);
		throw new WorktreeError(`Failed to create worktree for ${agentName}: ${message}`);
	}

	return { path: worktreePath, branchName };
}

/**
 * List all worktrees registered with this repository.
 *
 * Parses `git worktree list --porcelain`, whose stable, machine-readable format
 * emits one record per worktree separated by a blank line. Each record looks
 * like:
 *
 *   worktree /abs/path
 *   HEAD <sha>
 *   branch refs/heads/<name>        (omitted/replaced by `detached` if detached)
 *
 * We intentionally parse the porcelain (not the human format) so output is
 * locale- and version-stable.
 */
export async function listWorktrees(
	repoRoot: string,
): Promise<Array<{ path: string; branch: string; head: string }>> {
	const output = await git(repoRoot, ["worktree", "list", "--porcelain"]);
	if (output === "") {
		return [];
	}

	const entries: WorktreeEntry[] = [];
	// Records are separated by blank lines. Split on a blank line and process
	// each block independently so a malformed/extra field never bleeds across
	// records.
	const blocks = output.split("\n\n");

	for (const block of blocks) {
		const trimmedBlock = block.trim();
		if (trimmedBlock === "") {
			continue;
		}

		let path: string | undefined;
		let head = "";
		let branch = "";

		for (const line of trimmedBlock.split("\n")) {
			if (line.startsWith("worktree ")) {
				path = line.slice("worktree ".length).trim();
			} else if (line.startsWith("HEAD ")) {
				head = line.slice("HEAD ".length).trim();
			} else if (line.startsWith("branch ")) {
				// git prints the full ref ("refs/heads/foo"); expose the short name.
				const ref = line.slice("branch ".length).trim();
				branch = ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : ref;
			}
			// `detached`, `bare`, `locked`, etc. carry no fields we surface; ignore.
		}

		// A record without a `worktree` line is not something git emits; skip it
		// defensively so the return type's `path` is always a real string.
		if (path === undefined) {
			continue;
		}

		entries.push({ path, branch, head });
	}

	return entries;
}

/**
 * Remove a worktree via `git worktree remove`.
 *
 * `--force` is required when the worktree has uncommitted changes or is locked;
 * callers opt in via `opts.force`. We do NOT delete the branch here — branch
 * lifecycle (merge/cleanup) is a separate concern handled elsewhere.
 */
export async function removeWorktree(
	repoRoot: string,
	worktreePath: string,
	opts?: { force?: boolean },
): Promise<void> {
	const args = ["worktree", "remove"];
	if (opts?.force === true) {
		args.push("--force");
	}
	args.push(worktreePath);

	try {
		await git(repoRoot, args);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new WorktreeError(`Failed to remove worktree ${worktreePath}: ${message}`);
	}
}

/**
 * Force-delete a local branch via `git branch -D`. Used to fully clean up a
 * reaped agent's `agentplate/<name>` branch after its worktree is removed. Uses
 * `-D` (not `-d`) because the branch is typically unmerged. The branch must no
 * longer be checked out by any worktree (remove the worktree first).
 */
export async function deleteBranch(repoRoot: string, branchName: string): Promise<void> {
	try {
		await git(repoRoot, ["branch", "-D", branchName]);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new WorktreeError(`Failed to delete branch ${branchName}: ${message}`);
	}
}

/**
 * Report whether a worktree directory currently exists on disk.
 *
 * We answer from the filesystem (not `git worktree list`) on purpose: callers
 * use this to decide whether `createWorktree` would collide, and a leftover
 * directory from an interrupted/aborted run can exist even when git no longer
 * tracks it as a worktree. A filesystem check catches both cases.
 */
export async function worktreeExists(_repoRoot: string, worktreePath: string): Promise<boolean> {
	// We stat the path directly (rather than Bun.file().exists(), which reports
	// false for directories) so the check is correct for the common case where a
	// worktree is a directory. Any stat error — ENOENT and friends — means the
	// path is absent for our collision-detection purposes.
	try {
		await stat(worktreePath);
		return true;
	} catch {
		return false;
	}
}
