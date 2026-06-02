/**
 * Environment detection helpers used by `init`/`setup`.
 *
 * All detection is best-effort and side-effect-free: failures fall back to
 * sensible defaults rather than throwing, so initialization never blocks on a
 * missing remote or an absent CLI.
 */

import { basename } from "node:path";

/** Runtime adapter ids Agentplate knows how to detect by their CLI name. */
const RUNTIME_CLIS: ReadonlyArray<{ runtime: string; cli: string }> = [
	{ runtime: "claude", cli: "claude" },
	{ runtime: "opencode", cli: "opencode" },
	{ runtime: "codex", cli: "codex" },
	{ runtime: "gemini", cli: "gemini" },
	{ runtime: "cursor", cli: "cursor-agent" },
];

async function runGit(root: string, args: string[]): Promise<string | null> {
	try {
		const proc = Bun.spawn(["git", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
		const code = await proc.exited;
		if (code !== 0) return null;
		return (await new Response(proc.stdout).text()).trim();
	} catch {
		return null;
	}
}

/**
 * True if `cli` is resolvable on PATH. Uses `Bun.which`, which is cross-platform
 * and honors Windows `PATHEXT` (so `.cmd`/`.exe` shims are found). The previous
 * `which` subprocess was Unix-only, so on Windows every CLI looked "not installed"
 * — the wizard hid them and `detectDefaultRuntime` always fell back to claude.
 */
export async function commandOnPath(cli: string): Promise<boolean> {
	return Bun.which(cli) !== null;
}

/**
 * Resolve an argv so its executable can be launched on every OS. On Windows,
 * npm-installed CLIs (gemini, codex, opencode, cursor-agent) are `.cmd`/`.ps1`
 * shims that `Bun.spawn` will NOT launch by bare name (it looks for an exact
 * `name`/`name.exe`), causing ENOENT; `Bun.which` resolves the real shim path via
 * `PATHEXT`. On POSIX the argv is returned unchanged so the proven path is kept.
 */
export function resolveArgv(argv: string[]): string[] {
	if (process.platform !== "win32" || argv.length === 0) return argv;
	const resolved = Bun.which(argv[0] as string);
	return resolved ? [resolved, ...argv.slice(1)] : argv;
}

/** Detect the project name from the git remote URL, falling back to the dir name. */
export async function detectProjectName(root: string): Promise<string> {
	const remote = await runGit(root, ["config", "--get", "remote.origin.url"]);
	if (remote) {
		const match = remote.match(/([^/:]+?)(?:\.git)?$/);
		if (match?.[1]) return match[1];
	}
	return basename(root);
}

/** Detect the canonical branch (origin HEAD, else current branch, else "main"). */
export async function detectCanonicalBranch(root: string): Promise<string> {
	const originHead = await runGit(root, ["symbolic-ref", "refs/remotes/origin/HEAD"]);
	if (originHead) {
		const name = originHead.split("/").pop();
		if (name) return name;
	}
	const current = await runGit(root, ["branch", "--show-current"]);
	if (current) return current;
	return "main";
}

/** Detect the first installed coding-agent runtime, defaulting to "claude". */
export async function detectDefaultRuntime(): Promise<string> {
	for (const { runtime, cli } of RUNTIME_CLIS) {
		if (await commandOnPath(cli)) return runtime;
	}
	return "claude";
}
