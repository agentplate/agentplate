/**
 * Idle-session reaper — terminate agents that have gone quiet.
 *
 * Agentplate workers run spawn-per-turn: between turns a worker sits `idle` with
 * no live process, waiting for mail that may never come. A stalled turn can also
 * leave a session stuck `working`. Either way, an agent with no activity for the
 * configured idle window is dead weight — it counts toward the concurrency cap and
 * clutters the UI. This module reaps them: mark the session `stopped` and (by
 * default) remove its worktree + merged branch.
 *
 * "Activity" is the session's `last_activity`, which `driveTurn` bumps on every
 * streamed runtime event. A quiet turn (a long tool call, a nested synchronous
 * `sling`) streams nothing, so staleness alone never condemns a session:
 * - a session whose recorded turn pid is still alive is working, never idle;
 * - a `working` session with no recorded pid can't be proven dead, so it is left
 *   alone (`agents.turnTimeoutMinutes` and `agentplate stop` own that case);
 * - a parent with active children is waiting on them, and a child's activity
 *   counts as its parent's, so a lead is not reaped the moment its builders finish.
 * The coordinator is excluded by default (it's a long-lived interactive session
 * whose worktree IS the project root, and it does not stream per-turn events).
 */

import { isAbsolute, relative, resolve, sep } from "node:path";
import { createEventStore } from "../events/store.ts";
import { createMailStore } from "../mail/store.ts";
import { createMergeQueue } from "../merge/queue.ts";
import { eventsDbPath, mailDbPath, mergeDbPath, worktreesDir } from "../paths.ts";
import type { AgentSession, SessionState } from "../types.ts";
import { deleteBranch, removeWorktree, worktreeExists } from "../worktree/manager.ts";
import { type PurgeReport, purgeAgentData } from "./purge.ts";
import type { SessionStore } from "./store.ts";

/** States that can be reaped — the pre-terminal (still-counted) ones. */
const REAPABLE_STATES: readonly SessionState[] = ["booting", "working", "idle"];

/** Capabilities never reaped (the coordinator runs at the project root). */
const DEFAULT_EXCLUDE: readonly string[] = ["coordinator"];

export interface SelectIdleOptions {
	/** Idle window in milliseconds: reap sessions with no activity for this long. */
	idleMs: number;
	/** Reference "now" in epoch ms (injectable for tests). */
	now: number;
	/** Capabilities to skip (defaults to `["coordinator"]`). */
	excludeCapabilities?: readonly string[];
	/** Liveness probe for a recorded pid (injectable for tests; default {@link isPidAlive}). */
	isPidAlive?: (pid: number) => boolean;
}

/**
 * Is `pid` a live process? Signal 0 probes without delivering anything: ESRCH
 * means gone, EPERM means alive but owned by someone else.
 */
export function isPidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as { code?: unknown }).code === "EPERM";
	}
}

/**
 * Pure selector: which sessions are idle past the window. Side-effect-free apart
 * from the (injectable) pid probe, so the reap policy is unit-testable without a
 * store or git. `sessions` should be the full list: it is also how a session's
 * children are found.
 */
export function selectIdleSessions(
	sessions: readonly AgentSession[],
	opts: SelectIdleOptions,
): AgentSession[] {
	const exclude = new Set(opts.excludeCapabilities ?? DEFAULT_EXCLUDE);
	const alive = opts.isPidAlive ?? isPidAlive;
	return sessions.filter((s) => {
		if (!REAPABLE_STATES.includes(s.state)) return false;
		if (exclude.has(s.capability)) return false;
		// A live turn process is working, however quiet its event stream.
		if (s.pid != null && alive(s.pid)) return false;
		// `working` with no pid on record: the turn can't be proven dead — leave it.
		if (s.state === "working" && s.pid == null) return false;
		let last = Date.parse(s.lastActivity);
		if (Number.isNaN(last)) return false;
		for (const child of sessions) {
			if (child.parentAgent !== s.agentName || child.runId !== s.runId) continue;
			// A parent with live children is waiting on them, not idle.
			if (REAPABLE_STATES.includes(child.state)) return false;
			// A child's last move (e.g. finishing) is activity on its parent's behalf.
			const childLast = Date.parse(child.lastActivity);
			if (childLast > last) last = childLast;
		}
		return opts.now - last >= opts.idleMs;
	});
}

/** One reaped agent, returned for logging / reporting. */
export interface ReapedAgent {
	id: string;
	agentName: string;
	capability: string;
	/** How long it had been idle, in ms. */
	idleMs: number;
	/** Whether its worktree was removed (false if kept, missing, or removal failed). */
	worktreeRemoved: boolean;
	/** What a full data purge removed, or null when purge was not requested. */
	purged: PurgeReport | null;
}

export interface ReapOptions {
	/** Idle window in milliseconds. */
	idleMs: number;
	/** Reference "now" in epoch ms (defaults to `Date.now()`). */
	now?: number;
	/** Remove the reaped agent's worktree + branch (default true). */
	removeWorktrees?: boolean;
	/**
	 * Fully erase each reaped agent's data — mail, events, queued merges, on-disk
	 * state dir, and the session row itself — so nothing of it remains ("clear the
	 * Office"). Default false: reaping keeps records for history. When true, the
	 * auxiliary stores are opened from `root` for the sweep and closed afterward.
	 */
	purge?: boolean;
	/** Capabilities to skip (defaults to `["coordinator"]`). */
	excludeCapabilities?: readonly string[];
}

/**
 * Reap idle sessions: optionally remove the worktree + (merged) branch, and mark
 * the session `stopped`. Live turns are never selected (see
 * {@link selectIdleSessions}), so there is no process to kill. Every side effect
 * is best-effort and isolated per session — a failure to remove a worktree still
 * marks the session stopped and never aborts the sweep. Returns the agents that
 * were reaped.
 */
export async function reapIdleSessions(
	store: SessionStore,
	root: string,
	opts: ReapOptions,
): Promise<ReapedAgent[]> {
	const now = opts.now ?? Date.now();
	const removeWorktrees = opts.removeWorktrees !== false;
	const purge = opts.purge === true;
	const stale = selectIdleSessions(store.listSessions(), {
		idleMs: opts.idleMs,
		now,
		excludeCapabilities: opts.excludeCapabilities,
	});

	// Open the auxiliary stores once for the whole sweep, only when purging. They
	// share the session store's `root` and are closed in `finally` below.
	const aux = purge
		? {
				events: createEventStore(eventsDbPath(root)),
				merge: createMergeQueue(mergeDbPath(root)),
				mail: createMailStore(mailDbPath(root)),
			}
		: null;

	const reaped: ReapedAgent[] = [];
	try {
		for (const s of stale) {
			// 1. Remove the worktree + branch (guarded against the project root).
			let worktreeRemoved = false;
			if (removeWorktrees && isRemovableWorktree(root, s.worktreePath)) {
				try {
					if (await worktreeExists(root, s.worktreePath)) {
						await removeWorktree(root, s.worktreePath, { force: true });
					}
					worktreeRemoved = true;
					// Branch delete is separate and best-effort. deleteBranch refuses an
					// unmerged branch, so committed-but-unlanded work always survives.
					try {
						await deleteBranch(root, s.branchName);
					} catch {
						// Unmerged, shared, or already gone — leave it.
					}
				} catch {
					worktreeRemoved = false;
				}
			}

			// 2. Mark the session terminated so it stops counting and shows as stopped.
			//    (When purging, the row is deleted in step 3 — but we still transition it
			//    first so any concurrent reader observes a terminal state, never a gap.)
			store.updateSessionState(s.id, "stopped");

			// 3. Optionally erase every trace of the agent so the workspace is cleared.
			let purged: PurgeReport | null = null;
			if (aux) {
				purged = purgeAgentData(root, s, { sessions: store, ...aux });
			}

			reaped.push({
				id: s.id,
				agentName: s.agentName,
				capability: s.capability,
				idleMs: now - Date.parse(s.lastActivity),
				worktreeRemoved,
				purged,
			});
		}
	} finally {
		if (aux) {
			aux.events.close();
			aux.merge.close();
			aux.mail.close();
		}
	}
	return reaped;
}

/**
 * Only worktrees strictly inside `.agentplate/worktrees/` are removable. This
 * refuses the project root (the coordinator's and deploy sessions' `worktreePath`),
 * the worktrees dir itself, and any path outside it — including look-alike
 * prefixes (`worktrees-x/`) and `..` escapes. Shared by the reaper and
 * `agentplate stop`, so every `git worktree remove --force` goes through it.
 */
export function isRemovableWorktree(root: string, worktreePath: string): boolean {
	if (!worktreePath) return false;
	const target = resolve(worktreePath);
	if (target === resolve(root)) return false;
	const rel = relative(resolve(worktreesDir(root)), target);
	if (rel === "" || isAbsolute(rel)) return false;
	return rel !== ".." && !rel.startsWith(`..${sep}`);
}
