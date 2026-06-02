/**
 * Full data purge for a terminated agent — "clear the Office".
 *
 * Reaping (see {@link ./reaper.ts}) stops an idle agent and removes its worktree,
 * but deliberately leaves its records behind for history: the session row stays
 * (marked `stopped`), and its mail / events / queued merges / on-disk state dir
 * all persist. That is the right default for auditability, but it accumulates —
 * a long-running project fills up with the debris of agents that came and went.
 *
 * This module is the opt-in opposite: given a session, erase *everything* that
 * agent left behind so nothing of it remains. It is intentionally thorough and
 * destructive; callers gate it behind an explicit `--purge` / `purgeOnReap`.
 *
 * Design: the orchestrator is handed already-open stores (the reaper opens them
 * once per sweep; tests pass in-memory ones) and is responsible only for the
 * deletions, not store lifecycle. Every step is best-effort and isolated — a
 * failure to clear one store never aborts the rest — and a {@link PurgeReport}
 * records exactly what was removed.
 */

import { existsSync, rmSync } from "node:fs";
import { resolve, sep } from "node:path";
import type { EventStore } from "../events/store.ts";
import type { MailStore } from "../mail/store.ts";
import type { MergeQueue } from "../merge/queue.ts";
import { agentStateDir, specPath } from "../paths.ts";
import type { AgentSession } from "../types.ts";
import type { SessionStore } from "./store.ts";

/** The open stores a purge needs. The session store is the one the reaper holds. */
export interface PurgeStores {
	sessions: SessionStore;
	events: EventStore;
	merge: MergeQueue;
	mail: MailStore;
}

/** What a single agent purge removed. Counts are best-effort (0 on failure). */
export interface PurgeReport {
	/** Mail messages deleted (sent or received by the agent). */
	mailDeleted: number;
	/** Event-log rows deleted for the agent. */
	eventsDeleted: number;
	/** Merge-queue entries deleted for the agent. */
	mergeDeleted: number;
	/** Whether the on-disk `.agentplate/agents/<name>/` state dir was removed. */
	stateDirRemoved: boolean;
	/** Whether the task spec file was removed (only when no session still uses it). */
	specRemoved: boolean;
	/** Whether the session row itself was deleted. */
	sessionDeleted: boolean;
}

/**
 * Erase all data belonging to `session`'s agent. Assumes the agent is already
 * terminated (pid killed, worktree removed) — this only clears records, not
 * processes or git state. Returns a {@link PurgeReport} of what was removed.
 *
 * Ordering note: the session row is deleted last and the spec check runs against
 * the *remaining* sessions, so the agent's own row never keeps its spec alive.
 */
export function purgeAgentData(
	root: string,
	session: AgentSession,
	stores: PurgeStores,
): PurgeReport {
	const report: PurgeReport = {
		mailDeleted: 0,
		eventsDeleted: 0,
		mergeDeleted: 0,
		stateDirRemoved: false,
		specRemoved: false,
		sessionDeleted: false,
	};

	// Mail: everything the agent sent or received.
	try {
		report.mailDeleted = stores.mail.purge({ agent: session.agentName });
	} catch {
		// Best-effort: a store error here must not block the rest of the purge.
	}

	// Events: the agent's slice of the append-only log (scoped to its run so a
	// reused agent name in a later run keeps its own history).
	try {
		report.eventsDeleted = stores.events.deleteByAgent(session.agentName, session.runId);
	} catch {
		// Best-effort.
	}

	// Merge queue: any pending/merged/failed entries it enqueued.
	try {
		report.mergeDeleted = stores.merge.deleteByAgent(session.agentName);
	} catch {
		// Best-effort.
	}

	// On-disk state dir: identity CV + applied-skills.json. Guarded so we only ever
	// remove a path that resolves inside `.agentplate/agents/` (defence in depth;
	// the path is already derived from a constant, not user input).
	try {
		const dir = resolve(agentStateDir(root, session.agentName));
		const agentsRoot = resolve(agentStateDir(root, ""));
		// Only report a removal when a dir actually existed: rmSync with force:true
		// is a silent no-op for a missing path, which would otherwise read as "removed".
		if (dir.startsWith(agentsRoot + sep) && dir !== agentsRoot && existsSync(dir)) {
			rmSync(dir, { recursive: true, force: true });
			report.stateDirRemoved = true;
		}
	} catch {
		// Best-effort.
	}

	// Session row: delete it before checking the spec so this agent's own row is
	// not counted as "still using" the task.
	try {
		stores.sessions.deleteSession(session.id);
		report.sessionDeleted = true;
	} catch {
		// Best-effort.
	}

	// Spec file: shared by task id, so only remove it once no remaining session
	// references the task. (A multi-agent task keeps its spec until the last one
	// is purged.)
	try {
		const stillUsed = stores.sessions.listSessions().some((s) => s.taskId === session.taskId);
		const spec = specPath(root, session.taskId);
		if (!stillUsed && existsSync(spec)) {
			rmSync(spec, { force: true });
			report.specRemoved = true;
		}
	} catch {
		// Best-effort.
	}

	return report;
}
