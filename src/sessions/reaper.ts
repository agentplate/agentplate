/**
 * Idle-session reaper — terminate agents that have gone quiet.
 *
 * Agentplate workers run spawn-per-turn: between turns a worker sits `idle` with
 * no live process, waiting for mail that may never come. A stalled turn can also
 * leave a session stuck `working`. Either way, an agent with no activity for the
 * configured idle window is dead weight — it counts toward the concurrency cap and
 * clutters the UI. This module reaps them: mark the session `stopped`, kill any
 * live pid, and (by default) remove its worktree + branch.
 *
 * "Activity" is the session's `last_activity`, which `sling` bumps on every
 * streamed runtime event, so an agent actively working a long turn keeps itself
 * fresh and is never reaped — only genuinely idle/stalled agents are. The
 * coordinator is excluded by default (it's a long-lived interactive session whose
 * worktree IS the project root, and it does not stream per-turn events).
 */

import { worktreesDir } from "../paths.ts";
import type { AgentSession, SessionState } from "../types.ts";
import { deleteBranch, removeWorktree, worktreeExists } from "../worktree/manager.ts";
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
}

/**
 * Pure selector: which sessions are idle past the window. Kept side-effect-free so
 * the reap policy is trivially unit-testable without a store or git.
 */
export function selectIdleSessions(
	sessions: readonly AgentSession[],
	opts: SelectIdleOptions,
): AgentSession[] {
	const exclude = new Set(opts.excludeCapabilities ?? DEFAULT_EXCLUDE);
	return sessions.filter((s) => {
		if (!REAPABLE_STATES.includes(s.state)) return false;
		if (exclude.has(s.capability)) return false;
		const last = Date.parse(s.lastActivity);
		if (Number.isNaN(last)) return false;
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
}

export interface ReapOptions {
	/** Idle window in milliseconds. */
	idleMs: number;
	/** Reference "now" in epoch ms (defaults to `Date.now()`). */
	now?: number;
	/** Remove the reaped agent's worktree + branch (default true). */
	removeWorktrees?: boolean;
	/** Capabilities to skip (defaults to `["coordinator"]`). */
	excludeCapabilities?: readonly string[];
}

/**
 * Reap idle sessions: kill any live pid, optionally remove the worktree + branch,
 * and mark the session `stopped`. Every side effect is best-effort and isolated
 * per session — a failure to kill a process or remove a worktree still marks the
 * session stopped and never aborts the sweep. Returns the agents that were reaped.
 */
export async function reapIdleSessions(
	store: SessionStore,
	root: string,
	opts: ReapOptions,
): Promise<ReapedAgent[]> {
	const now = opts.now ?? Date.now();
	const removeWorktrees = opts.removeWorktrees !== false;
	const stale = selectIdleSessions(store.listSessions(), {
		idleMs: opts.idleMs,
		now,
		excludeCapabilities: opts.excludeCapabilities,
	});

	const reaped: ReapedAgent[] = [];
	for (const s of stale) {
		// 1. Kill any live process (spawn-per-turn workers usually have no pid).
		if (s.pid != null) {
			try {
				process.kill(s.pid, "SIGTERM");
			} catch {
				// Already gone / not ours — nothing to do.
			}
		}

		// 2. Remove the worktree + branch (guarded against the project root).
		let worktreeRemoved = false;
		if (removeWorktrees && isRemovableWorktree(root, s.worktreePath)) {
			try {
				if (await worktreeExists(root, s.worktreePath)) {
					await removeWorktree(root, s.worktreePath, { force: true });
				}
				worktreeRemoved = true;
				// Branch delete is separate and best-effort (no-op if already gone).
				try {
					await deleteBranch(root, s.branchName);
				} catch {
					// Branch may be merged away or shared — leave it.
				}
			} catch {
				worktreeRemoved = false;
			}
		}

		// 3. Mark the session terminated so it stops counting and shows as stopped.
		store.updateSessionState(s.id, "stopped");

		reaped.push({
			id: s.id,
			agentName: s.agentName,
			capability: s.capability,
			idleMs: now - Date.parse(s.lastActivity),
			worktreeRemoved,
		});
	}
	return reaped;
}

/**
 * Only worktrees under `.agentplate/worktrees/` are removable. This refuses to
 * touch the project root (the coordinator's `worktreePath`) or any path outside
 * the managed worktrees dir — a hard safety net beyond the capability exclusion.
 */
function isRemovableWorktree(root: string, worktreePath: string): boolean {
	if (!worktreePath || worktreePath === root) return false;
	return worktreePath.startsWith(worktreesDir(root));
}
