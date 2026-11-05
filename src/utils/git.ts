/**
 * One way to run git: argv array (never a shell string), both pipes drained
 * concurrently so a large output cannot stall on a full pipe buffer.
 */

import { SubprocessError } from "../errors.ts";

export interface GitResult {
	stdout: string;
	stderr: string;
	exitCode: number;
}

/**
 * Run `git <args>` in `cwd` and capture its output. Never throws on a non-zero
 * exit: callers check `exitCode`, because for git a non-zero exit is often an
 * expected answer (a merge conflict is exit 1). A failure to spawn git at all
 * still throws.
 */
export async function runGit(cwd: string, args: string[]): Promise<GitResult> {
	const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	return { stdout, stderr, exitCode };
}

/**
 * Run a git command that is expected to succeed. Throws {@link SubprocessError}
 * (carrying git's stderr and exit code) on a non-zero exit.
 */
export async function runGitChecked(cwd: string, args: string[]): Promise<GitResult> {
	const result = await runGit(cwd, args);
	if (result.exitCode !== 0) {
		const detail = result.stderr.trim() || result.stdout.trim() || `exit code ${result.exitCode}`;
		throw new SubprocessError(
			`git ${args.join(" ")} failed (exit ${result.exitCode}): ${detail}`,
			result.exitCode,
		);
	}
	return result;
}

/** Trimmed stdout of a git command, or null when it fails or git cannot run. */
export async function gitOutput(cwd: string, args: string[]): Promise<string | null> {
	try {
		const result = await runGit(cwd, args);
		return result.exitCode === 0 ? result.stdout.trim() : null;
	} catch {
		return null;
	}
}
