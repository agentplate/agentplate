/**
 * Helpers for the agent-facing child processes: worker turns, quality gates and
 * the skill distiller.
 *
 * - {@link agentChildEnv} builds an ALLOWLISTED environment. Those children run
 *   an agent with permission prompts bypassed, or code an agent wrote (a gate's
 *   `bun test`), so they must not inherit the operator's whole environment: in
 *   CI it holds deploy credentials (`GHCR_TOKEN`, cloud tokens — `getSecret`
 *   deliberately reads them from `process.env`) that one prompt injection could
 *   exfiltrate. A child inherits only what a shell, git, a toolchain and the
 *   runtime CLI need; the caller merges the resolved provider env on top.
 * - {@link armKillTimer} puts a wall-clock cap on a spawned child: SIGTERM at
 *   the limit, then SIGKILL after a grace period — optionally to the child's
 *   whole process group, so a gate's grandchildren (`bun test` under
 *   `bash -lc`) die with it instead of lingering.
 */

import type { Subprocess } from "bun";

/**
 * Variables every agent-facing child inherits (when set in the parent). A
 * trailing `*` matches a prefix. This is the process basics, locale, temp and
 * per-user dirs (runtime CLIs keep their login under `$HOME` / `$XDG_*`),
 * terminal hints, proxy + CA settings (a CLI behind a proxy cannot reach its
 * API without them), git identity / transport / config location, common
 * toolchain homes, and the Windows variables a process needs to start.
 *
 * Deliberately absent: repository-location overrides (`GIT_DIR`,
 * `GIT_WORK_TREE`, `GIT_INDEX_FILE` — they would aim a worktree's git at
 * another repo), CI job tokens (`ACTIONS_*`, `GITHUB_TOKEN`) and every deploy
 * or cloud credential. A runtime adds its own namespace via
 * `AgentRuntime.envPassthrough`; an operator adds names via
 * {@link ENV_PASSTHROUGH_VAR}.
 */
export const BASE_ENV_ALLOWLIST: readonly string[] = [
	// Process basics.
	"PATH",
	"HOME",
	"USER",
	"LOGNAME",
	"SHELL",
	"TERM",
	"COLORTERM",
	"NO_COLOR",
	"FORCE_COLOR",
	"CI",
	"TZ",
	// Locale.
	"LANG",
	"LANGUAGE",
	"LC_*",
	// Temp + per-user dirs.
	"TMPDIR",
	"TMP",
	"TEMP",
	"XDG_*",
	// Network: proxies and CA bundles.
	"HTTP_PROXY",
	"HTTPS_PROXY",
	"NO_PROXY",
	"ALL_PROXY",
	"http_proxy",
	"https_proxy",
	"no_proxy",
	"all_proxy",
	"SSL_CERT_FILE",
	"SSL_CERT_DIR",
	"NODE_EXTRA_CA_CERTS",
	"REQUESTS_CA_BUNDLE",
	"CURL_CA_BUNDLE",
	// git: identity, config location, transport, signing.
	"GIT_AUTHOR_NAME",
	"GIT_AUTHOR_EMAIL",
	"GIT_COMMITTER_NAME",
	"GIT_COMMITTER_EMAIL",
	"GIT_CONFIG_GLOBAL",
	"GIT_CONFIG_SYSTEM",
	"GIT_CONFIG_NOSYSTEM",
	"GIT_EXEC_PATH",
	"GIT_SSH",
	"GIT_SSH_COMMAND",
	"GIT_SSL_CAINFO",
	"GIT_TERMINAL_PROMPT",
	"SSH_AUTH_SOCK",
	"GNUPGHOME",
	// Toolchain homes (quality gates run the project's own build/test tools).
	"JAVA_HOME",
	"GOPATH",
	"GOROOT",
	"GOCACHE",
	"GOMODCACHE",
	"CARGO_HOME",
	"RUSTUP_HOME",
	"BUN_INSTALL",
	"NVM_DIR",
	"VOLTA_HOME",
	"PNPM_HOME",
	"DENO_DIR",
	"PYENV_ROOT",
	"VIRTUAL_ENV",
	"CONDA_PREFIX",
	// Windows system variables.
	"SYSTEMROOT",
	"WINDIR",
	"COMSPEC",
	"PATHEXT",
	"APPDATA",
	"LOCALAPPDATA",
	"USERPROFILE",
	"HOMEDRIVE",
	"HOMEPATH",
	"SYSTEMDRIVE",
	"PROGRAMDATA",
	"PROGRAMFILES",
	"PROGRAMFILES(X86)",
	"PROGRAMW6432",
	"COMMONPROGRAMFILES",
	"COMMONPROGRAMFILES(X86)",
	"ALLUSERSPROFILE",
	"PUBLIC",
	"USERNAME",
	"USERDOMAIN",
	"OS",
	"NUMBER_OF_PROCESSORS",
	"PROCESSOR_ARCHITECTURE",
];

/**
 * Operator escape hatch: a comma/space-separated list of extra variable names
 * (a trailing `*` matches a prefix; a lone `*` inherits everything) that
 * agent-facing children may inherit — e.g. `AWS_ACCESS_KEY_ID` for a Bedrock
 * login, or a toolchain variable a quality gate needs. The variable itself is
 * always forwarded, so the list applies at every level of the agent hierarchy.
 */
export const ENV_PASSTHROUGH_VAR = "AGENTPLATE_ENV_PASSTHROUGH";

/** Options for {@link agentChildEnv}. */
export interface AgentChildEnvOptions {
	/** Extra names / `PREFIX_*` patterns to inherit — e.g. a runtime's own config vars. */
	passthrough?: readonly string[];
	/** Environment to filter (default `process.env`; injectable for tests). */
	parent?: Record<string, string | undefined>;
}

/**
 * Build the environment for an agent-facing child: the allowlisted subset of
 * the parent env ({@link BASE_ENV_ALLOWLIST} + `opts.passthrough` + the
 * operator's {@link ENV_PASSTHROUGH_VAR}), with `overrides` (the resolved
 * provider/runtime env) merged on top so they always win — including an
 * explicit `""` that pins an inherited credential to empty.
 */
export function agentChildEnv(
	overrides: Record<string, string> = {},
	opts: AgentChildEnvOptions = {},
): Record<string, string> {
	const parent = opts.parent ?? process.env;
	const allowed = compileAllowlist([
		...BASE_ENV_ALLOWLIST,
		// Forward the operator's list itself, so it survives nesting: a lead runs
		// `agentplate sling` in its own turn, and the builder's first turn (plus
		// its gates and distiller) is built from the lead's already-filtered env.
		// This widens nothing — a child can only pass on vars it already has.
		ENV_PASSTHROUGH_VAR,
		...(opts.passthrough ?? []),
		...splitPassthrough(parent[ENV_PASSTHROUGH_VAR]),
	]);
	const env: Record<string, string> = {};
	for (const [name, value] of Object.entries(parent)) {
		if (value !== undefined && allowed(name)) env[name] = value;
	}
	return { ...env, ...overrides };
}

/** Parse the operator passthrough list (`"A, B_*  C"` → `["A", "B_*", "C"]`). */
function splitPassthrough(value: string | undefined): string[] {
	if (value === undefined) return [];
	return value.split(/[\s,]+/).filter((name) => name !== "");
}

/**
 * Compile name patterns into a predicate. Exact names match exactly, `PREFIX*`
 * matches a prefix (a lone `*` matches everything). Windows env names are
 * case-insensitive (`Path`, `SystemRoot`), so matching folds case there.
 */
function compileAllowlist(patterns: readonly string[]): (name: string) => boolean {
	const fold = process.platform === "win32" ? (s: string) => s.toUpperCase() : (s: string) => s;
	const exact = new Set<string>();
	const prefixes: string[] = [];
	for (const pattern of patterns) {
		if (pattern.endsWith("*")) prefixes.push(fold(pattern.slice(0, -1)));
		else exact.add(fold(pattern));
	}
	return (name) => {
		const folded = fold(name);
		return exact.has(folded) || prefixes.some((prefix) => folded.startsWith(prefix));
	};
}

/** Default grace between SIGTERM and SIGKILL for a child past its time limit. */
export const KILL_GRACE_MS = 5_000;

/** Options for {@link armKillTimer}. */
export interface KillTimerOptions {
	/**
	 * Signal the child's whole process group, not just the child. The child must
	 * have been spawned with `detached: true` (so it leads its own group).
	 * Ignored on Windows, which has no POSIX process groups.
	 */
	group?: boolean;
	/** Delay between SIGTERM and SIGKILL (default {@link KILL_GRACE_MS}). */
	graceMs?: number;
}

/** Handle returned by {@link armKillTimer}. */
export interface KillTimer {
	/** True once the time limit fired and the child was signalled. */
	readonly timedOut: boolean;
	/** Disarm the limit — call once the child has exited. */
	clear(): void;
}

/**
 * Cap a spawned child's wall-clock time. Past `timeoutMs` the child gets SIGTERM
 * and, if it is still alive `graceMs` later, SIGKILL — so a child that ignores
 * SIGTERM cannot hang its caller. With `group`, both signals go to the process
 * group, and the SIGKILL still fires after the leader exits, catching
 * grandchildren that ignored the SIGTERM. A missing or non-positive `timeoutMs`
 * arms nothing.
 */
export function armKillTimer(
	proc: Subprocess,
	timeoutMs: number | undefined,
	opts: KillTimerOptions = {},
): KillTimer {
	const group = opts.group === true && process.platform !== "win32";
	let timedOut = false;
	let escalation: ReturnType<typeof setTimeout> | null = null;

	const signal = (sig: "SIGTERM" | "SIGKILL"): void => {
		try {
			if (group) process.kill(-proc.pid, sig);
			else proc.kill(sig);
		} catch {
			// Already gone.
		}
	};

	const timer =
		timeoutMs !== undefined && timeoutMs > 0
			? setTimeout(() => {
					timedOut = true;
					signal("SIGTERM");
					escalation = setTimeout(() => signal("SIGKILL"), opts.graceMs ?? KILL_GRACE_MS);
					// Never keep the parent alive just to deliver the SIGKILL.
					escalation.unref();
				}, timeoutMs)
			: null;

	return {
		get timedOut() {
			return timedOut;
		},
		clear() {
			if (timer) clearTimeout(timer);
			// A lone child that has exited needs no SIGKILL; a group may still hold
			// grandchildren that ignored SIGTERM, so its escalation stays armed.
			if (escalation && !group) clearTimeout(escalation);
		},
	};
}
