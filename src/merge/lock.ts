// Sentinel-file merge lock.
//
// WHY a file lock (and not an in-process mutex or a SQLite row): `agentplate merge`
// can be invoked by several independent processes at once (the operator's shell,
// the coordinator agent, a watchdog retry). They are separate OS processes, so an
// in-memory lock is useless. A sentinel file created with O_EXCL is atomic at the
// filesystem level — exactly one caller can win the create, everyone else sees
// EEXIST — which gives us a cheap cross-process mutex without a daemon.
//
// We deliberately keep this dumb: no PID tracking, no stale-lock reaping. The lock
// is held only for the duration of a single `withMergeLock` body (one merge), and
// `releaseMergeLock` runs in a `finally`, so a crash mid-merge is the only way to
// leak it. Recovering from that is a manual `agentplate clean`-style concern, not
// something we want to guess at here (auto-reaping a "stale" lock races with a
// merge that is simply slow).

import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { WorktreeError } from "../errors.ts";

/** Absolute path to the sentinel file for a given project root. */
function lockPath(root: string): string {
	return join(root, ".agentplate", "merge.lock");
}

/**
 * Try to acquire the merge lock for `root`.
 *
 * Returns `true` if this call created the sentinel (caller now holds the lock),
 * `false` if it was already held by someone else. Never throws on contention —
 * contention is an expected, recoverable condition the caller decides how to
 * handle.
 */
export function acquireMergeLock(root: string): boolean {
	const path = lockPath(root);
	// Ensure `.agentplate/` exists; a fresh checkout or a targeted test dir may not
	// have it yet, and `wx` would otherwise fail with ENOENT instead of EEXIST.
	mkdirSync(dirname(path), { recursive: true });
	try {
		// `flag: "wx"` === open(O_CREAT | O_EXCL | O_WRONLY): atomic create-or-fail.
		// The payload is informational only (a timestamp aids manual debugging).
		writeFileSync(path, `${new Date().toISOString()}\n`, { flag: "wx" });
		return true;
	} catch (err) {
		// EEXIST means another process holds the lock — the one outcome we treat as
		// "not acquired" rather than an error. Anything else (EACCES, EROFS, …) is a
		// real filesystem failure and must surface.
		if (err instanceof Error && "code" in err && err.code === "EEXIST") {
			return false;
		}
		throw err;
	}
}

/**
 * Release the merge lock for `root`. Idempotent: removing an already-absent lock
 * is a no-op, so double-release (e.g. a `finally` after an early manual release)
 * is safe.
 */
export function releaseMergeLock(root: string): void {
	const path = lockPath(root);
	if (existsSync(path)) {
		rmSync(path, { force: true });
	}
}

/**
 * Run `fn` while holding the merge lock, releasing it afterwards no matter how
 * `fn` settles. Throws `WorktreeError` if the lock is already held — callers that
 * want to wait/retry should loop on `acquireMergeLock` themselves.
 */
export async function withMergeLock<T>(root: string, fn: () => Promise<T>): Promise<T> {
	if (!acquireMergeLock(root)) {
		throw new WorktreeError(
			`Merge lock is already held (${lockPath(root)}). Another merge is in progress.`,
		);
	}
	try {
		return await fn();
	} finally {
		releaseMergeLock(root);
	}
}
