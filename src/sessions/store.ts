/**
 * SQLite-backed store for agent sessions and runs.
 *
 * Sessions track the lifecycle of every spawned agent; runs group together all
 * the sessions started during one coordinator session. Both tables live in the
 * same database (`.agentplate/sessions.db`) so a single WAL file covers the whole
 * lifecycle and status-style commands read everything from one handle.
 *
 * This module exposes a *factory* (`createSessionStore`) rather than a class.
 * The returned object is the public surface; the `Database` handle and the
 * row<->record mapping stay private in the closure. All column<->field
 * translation lives in one place (`rowToRun` / `rowToSession`) so the snake_case
 * SQL schema never leaks into the rest of the codebase, which only ever sees the
 * camelCase `RunRecord` / `AgentSession` shapes from `types.ts`.
 */

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { openDatabase } from "../db/sqlite.ts";
import type { AgentSession, Capability, RunRecord, SessionState } from "../types.ts";

/**
 * Sessions considered "active" for concurrency accounting. Mirrors the
 * pre-terminal states of {@link SessionState}: an agent that is still booting,
 * actively working, or idle (awaiting its next turn / nudge) counts against the
 * fleet/per-run caps. Terminal states (completed/failed/stopped) do not.
 *
 * Kept here (not in types.ts, which we must not edit) as a `const` tuple so the
 * compiler still checks the values against `SessionState` and `countActive`
 * stays single-sourced.
 */
const ACTIVE_STATES: readonly SessionState[] = ["booting", "working", "idle"];

/**
 * Filter for {@link SessionStore.listSessions}. Both fields are optional and
 * AND-combined; omit both to list every session. Local to this store (purely a
 * query convenience), so it is defined here rather than in shared types.
 */
export interface SessionListFilter {
	runId?: string;
	state?: SessionState;
}

/** Public surface of the session/run store, returned by `createSessionStore`. */
export interface SessionStore {
	// --- Runs ---
	createRun(label?: string): RunRecord;
	getRun(id: string): RunRecord | null;
	listRuns(limit?: number): RunRecord[];
	completeRun(id: string): void;
	// --- Sessions ---
	upsertSession(session: AgentSession): void;
	getSession(id: string): AgentSession | null;
	getSessionByAgent(agentName: string): AgentSession | null;
	listSessions(filter?: SessionListFilter): AgentSession[];
	updateSessionState(id: string, state: SessionState): void;
	setRuntimeSessionId(id: string, runtimeSessionId: string): void;
	touch(id: string): void;
	countActive(runId?: string): number;
	// --- Lifecycle ---
	close(): void;
}

// DDL is idempotent (`IF NOT EXISTS`). Nullable columns (no NOT NULL) mirror the
// `| null` fields in the record types so `null` round-trips faithfully. The
// `runs` table stores no `completed_at`: `RunRecord` has no such field, so
// completion is captured solely by flipping `status` to 'completed'.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS runs (
	id TEXT PRIMARY KEY,
	created_at TEXT NOT NULL,
	status TEXT NOT NULL DEFAULT 'active',
	label TEXT
);

CREATE TABLE IF NOT EXISTS sessions (
	id TEXT PRIMARY KEY,
	agent_name TEXT NOT NULL,
	capability TEXT NOT NULL,
	task_id TEXT NOT NULL,
	run_id TEXT NOT NULL,
	worktree_path TEXT NOT NULL,
	branch_name TEXT NOT NULL,
	state TEXT NOT NULL,
	parent_agent TEXT,
	depth INTEGER NOT NULL DEFAULT 0,
	pid INTEGER,
	runtime_session_id TEXT,
	started_at TEXT NOT NULL,
	last_activity TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sessions_run ON sessions(run_id);
CREATE INDEX IF NOT EXISTS idx_sessions_agent ON sessions(agent_name);
CREATE INDEX IF NOT EXISTS idx_sessions_state ON sessions(state);
`;

// Raw row shapes as returned by bun:sqlite (snake_case columns, nullable where
// the schema allows NULL). Mapped to camelCase records before leaving the module.
interface RunRow {
	id: string;
	created_at: string;
	status: string;
	label: string | null;
}

interface SessionRow {
	id: string;
	agent_name: string;
	capability: string;
	task_id: string;
	run_id: string;
	worktree_path: string;
	branch_name: string;
	state: string;
	parent_agent: string | null;
	depth: number;
	pid: number | null;
	runtime_session_id: string | null;
	started_at: string;
	last_activity: string;
}

function rowToRun(row: RunRow): RunRecord {
	// `status` is constrained to 'active' | 'completed' by our own writes; the DB
	// column is plain TEXT so we narrow on read. `label` is optional on the record
	// (omit the key entirely when the column is NULL rather than carrying `null`,
	// since RunRecord.label is `string | undefined`, not nullable).
	const record: RunRecord = {
		id: row.id,
		createdAt: row.created_at,
		status: row.status as RunRecord["status"],
	};
	if (row.label !== null) record.label = row.label;
	return record;
}

function rowToSession(row: SessionRow): AgentSession {
	return {
		id: row.id,
		agentName: row.agent_name,
		// `capability` is constrained to Capability by writers; narrow on read.
		capability: row.capability as Capability,
		taskId: row.task_id,
		runId: row.run_id,
		worktreePath: row.worktree_path,
		branchName: row.branch_name,
		state: row.state as SessionState,
		parentAgent: row.parent_agent,
		depth: row.depth,
		pid: row.pid,
		runtimeSessionId: row.runtime_session_id,
		startedAt: row.started_at,
		lastActivity: row.last_activity,
	};
}

// SQL IN-list of active states, built from the single ACTIVE_STATES source.
// Values are hard-coded literals (no user input), so quoting them is safe; we
// still derive the list programmatically so it never drifts from the constant.
const ACTIVE_STATES_SQL = `(${ACTIVE_STATES.map((s) => `'${s}'`).join(", ")})`;

/**
 * Open (or create) the session/run store at `dbPath`.
 *
 * Pass `":memory:"` for an ephemeral in-process database (tests). For a file
 * path the parent directory is created if missing, so callers don't have to
 * pre-make `.agentplate/` themselves.
 */
export function createSessionStore(dbPath: string): SessionStore {
	// openDatabase (bun:sqlite under it) will not create intermediate
	// directories, so ensure the parent exists for file-backed databases.
	if (dbPath !== ":memory:") {
		mkdirSync(dirname(dbPath), { recursive: true });
	}
	// Guard on `runs.created_at`: the unrelated @ag-eco/agentplate-cli creates a
	// `runs` table with `started_at` instead, which would break our inserts.
	const db = openDatabase(dbPath, { guard: { table: "runs", columns: ["created_at"] } });
	db.exec(SCHEMA);

	// --- Runs ---

	function createRun(label?: string): RunRecord {
		// Short, human-scannable id: `run-` + first 8 hex chars of a UUID.
		// Collision risk across a single project's run history is negligible.
		const id = `run-${crypto.randomUUID().slice(0, 8)}`;
		const createdAt = new Date().toISOString();
		db.query("INSERT INTO runs (id, created_at, status, label) VALUES (?, ?, 'active', ?)").run(
			id,
			createdAt,
			label ?? null,
		);
		const record: RunRecord = { id, createdAt, status: "active" };
		if (label !== undefined) record.label = label;
		return record;
	}

	function getRun(id: string): RunRecord | null {
		const row = db.query("SELECT * FROM runs WHERE id = ?").get(id) as RunRow | null;
		return row ? rowToRun(row) : null;
	}

	function listRuns(limit = 50): RunRecord[] {
		// Newest first: the orchestrator usually cares about the current/last run.
		const rows = db
			.query("SELECT * FROM runs ORDER BY created_at DESC LIMIT ?")
			.all(limit) as RunRow[];
		return rows.map(rowToRun);
	}

	function completeRun(id: string): void {
		// RunRecord has no completedAt; completion is captured by status alone.
		db.query("UPDATE runs SET status = 'completed' WHERE id = ?").run(id);
	}

	// --- Sessions ---

	function upsertSession(session: AgentSession): void {
		// Idempotent upsert keyed on the session id. `started_at` is intentionally
		// NOT overwritten on conflict (a session keeps its original birth time);
		// every other field, including `last_activity`, reflects the latest write.
		db.query(
			`INSERT INTO sessions (
				id, agent_name, capability, task_id, run_id, worktree_path, branch_name,
				state, parent_agent, depth, pid, runtime_session_id, started_at, last_activity
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT(id) DO UPDATE SET
				agent_name = excluded.agent_name,
				capability = excluded.capability,
				task_id = excluded.task_id,
				run_id = excluded.run_id,
				worktree_path = excluded.worktree_path,
				branch_name = excluded.branch_name,
				state = excluded.state,
				parent_agent = excluded.parent_agent,
				depth = excluded.depth,
				pid = excluded.pid,
				runtime_session_id = excluded.runtime_session_id,
				last_activity = excluded.last_activity`,
		).run(
			session.id,
			session.agentName,
			session.capability,
			session.taskId,
			session.runId,
			session.worktreePath,
			session.branchName,
			session.state,
			session.parentAgent,
			session.depth,
			session.pid,
			session.runtimeSessionId,
			session.startedAt,
			session.lastActivity,
		);
	}

	function getSession(id: string): AgentSession | null {
		const row = db.query("SELECT * FROM sessions WHERE id = ?").get(id) as SessionRow | null;
		return row ? rowToSession(row) : null;
	}

	function getSessionByAgent(agentName: string): AgentSession | null {
		// Agent names can be reused across runs; return the most recent session for
		// that name so callers see the live one.
		const row = db
			.query("SELECT * FROM sessions WHERE agent_name = ? ORDER BY started_at DESC LIMIT 1")
			.get(agentName) as SessionRow | null;
		return row ? rowToSession(row) : null;
	}

	function listSessions(filter?: SessionListFilter): AgentSession[] {
		// Build the WHERE clause dynamically; params stay positional so values are
		// always parameterized (no string interpolation of user-supplied data).
		const clauses: string[] = [];
		const params: string[] = [];
		if (filter?.runId !== undefined) {
			clauses.push("run_id = ?");
			params.push(filter.runId);
		}
		if (filter?.state !== undefined) {
			clauses.push("state = ?");
			params.push(filter.state);
		}
		const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
		const rows = db
			.query(`SELECT * FROM sessions ${where} ORDER BY started_at ASC`)
			.all(...params) as SessionRow[];
		return rows.map(rowToSession);
	}

	function updateSessionState(id: string, state: SessionState): void {
		// A state change is, by definition, activity — bump last_activity too.
		const now = new Date().toISOString();
		db.query("UPDATE sessions SET state = ?, last_activity = ? WHERE id = ?").run(state, now, id);
	}

	function setRuntimeSessionId(id: string, runtimeSessionId: string): void {
		// Learning the runtime session id (e.g. for `--resume`) counts as activity.
		const now = new Date().toISOString();
		db.query("UPDATE sessions SET runtime_session_id = ?, last_activity = ? WHERE id = ?").run(
			runtimeSessionId,
			now,
			id,
		);
	}

	function touch(id: string): void {
		// Pure heartbeat: refresh last_activity without changing any other field.
		const now = new Date().toISOString();
		db.query("UPDATE sessions SET last_activity = ? WHERE id = ?").run(now, id);
	}

	function countActive(runId?: string): number {
		// Active = booting | working | idle (see ACTIVE_STATES). Used by schedulers
		// to enforce per-run / global concurrency caps.
		if (runId !== undefined) {
			const row = db
				.query(
					`SELECT COUNT(*) AS n FROM sessions WHERE run_id = ? AND state IN ${ACTIVE_STATES_SQL}`,
				)
				.get(runId) as { n: number };
			return row.n;
		}
		const row = db
			.query(`SELECT COUNT(*) AS n FROM sessions WHERE state IN ${ACTIVE_STATES_SQL}`)
			.get() as { n: number };
		return row.n;
	}

	function close(): void {
		db.close();
	}

	return {
		createRun,
		getRun,
		listRuns,
		completeRun,
		upsertSession,
		getSession,
		getSessionByAgent,
		listSessions,
		updateSessionState,
		setRuntimeSessionId,
		touch,
		countActive,
		close,
	};
}
