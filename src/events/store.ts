// Events SQLite store.
//
// A deliberately small, single-table event log for agent activity. Each row is
// an `EventRecord` (see src/types.ts): an append-only fact about what an agent
// did (a tool call, a state transition, etc.). The store is intentionally much
// simpler than agentplate's blueprint — no timelines, no error rollups, no
// arg filtering. It exists so observability commands (feed/trace/errors) have a
// uniform place to read from, and so multiple agents can append concurrently.
//
// WHY a single insert + one filtered SELECT: high-frequency writes from many
// worktrees dominate this workload, so we keep the schema flat and let WAL mode
// (configured by openDatabase) handle concurrency. Filtering/limiting is pushed
// into SQL so callers never load the whole log into memory.

import type { Database } from "bun:sqlite";
import { openDatabase } from "../db/sqlite.ts";
import type { EventRecord } from "../types.ts";

/** Input accepted by `record()`. `id`/`createdAt` are assigned by the store. */
export interface RecordEventInput {
	agentName: string;
	// Optional run grouping. `undefined` and `null` are treated identically and
	// stored as SQL NULL so "no run" is a single canonical value.
	runId?: string | null;
	type: string;
	// Optional tool name (e.g. "Bash", "Edit") and free-form detail string.
	tool?: string | null;
	detail?: string | null;
}

/** Filters for `list()`. All fields are optional; omitted fields are ignored. */
export interface ListEventsFilter {
	agentName?: string;
	runId?: string;
	type?: string;
	// Max rows to return. Must be a positive integer when provided; otherwise the
	// whole (filtered) log is returned newest-first.
	limit?: number;
}

/** Public surface returned by {@link createEventStore}. */
export interface EventStore {
	record(event: RecordEventInput): EventRecord;
	list(filter?: ListEventsFilter): EventRecord[];
	/**
	 * Delete every event logged by `agentName` (optionally scoped to one run);
	 * returns the number of rows removed. Used when fully purging a reaped agent's
	 * data. The log is otherwise append-only — this is the sole deletion path.
	 */
	deleteByAgent(agentName: string, runId?: string): number;
	close(): void;
}

// Raw column shape as returned by bun:sqlite. SQLite has no boolean/null typing
// at the JS boundary beyond "value or null", so we map TEXT columns to
// `string | null` and convert to the `EventRecord` shape in one place.
//
// `seq` is an internal, monotonically increasing insertion counter (autoincrement
// rowid). It is NOT part of the public `EventRecord` — it exists solely so we can
// order strictly by insertion order. We can't rely on `created_at` for ordering
// because many events can land in the same millisecond (ISO-8601 has ms
// resolution), and the public `id` is a random UUID with no temporal meaning.
interface EventRow {
	seq: number;
	id: string;
	agent_name: string;
	run_id: string | null;
	type: string;
	tool: string | null;
	detail: string | null;
	created_at: string;
}

// Translate a DB row into the shared `EventRecord` type. Centralised so the
// snake_case <-> camelCase mapping lives in exactly one spot. `seq` is dropped
// here because it is an internal ordering key, not part of the public contract.
function rowToRecord(row: EventRow): EventRecord {
	return {
		id: row.id,
		agentName: row.agent_name,
		runId: row.run_id,
		type: row.type,
		tool: row.tool,
		detail: row.detail,
		createdAt: row.created_at,
	};
}

/**
 * Open (creating if needed) the events store at `dbPath`.
 *
 * `dbPath` may be ":memory:" for tests or an absolute file path in a project's
 * `.agentplate/` directory. The table is created on open so callers never need a
 * separate migration step.
 */
export function createEventStore(dbPath: string): EventStore {
	// Guard on `events.seq` against an incompatible foreign `events` table.
	const db: Database = openDatabase(dbPath, { guard: { table: "events", columns: ["seq"] } });

	// Flat schema. `seq` (INTEGER PRIMARY KEY AUTOINCREMENT) is the canonical
	// insertion-order key we sort by — see EventRow for why created_at/id can't
	// serve that role. `id` is the public UUID, kept UNIQUE so callers can look up
	// by it. `created_at` is an ISO-8601 string (lexically sortable, used only for
	// display and time-range filtering, not as the primary sort key).
	db.exec(`
		CREATE TABLE IF NOT EXISTS events (
			seq INTEGER PRIMARY KEY AUTOINCREMENT,
			id TEXT NOT NULL UNIQUE,
			agent_name TEXT NOT NULL,
			run_id TEXT,
			type TEXT NOT NULL,
			tool TEXT,
			detail TEXT,
			created_at TEXT NOT NULL
		)
	`);

	// Index the columns we filter by. Ordering is on `seq` (the PRIMARY KEY), which
	// is already indexed, so no extra index is needed for the newest-first sort.
	db.exec("CREATE INDEX IF NOT EXISTS idx_events_agent ON events(agent_name)");
	db.exec("CREATE INDEX IF NOT EXISTS idx_events_run ON events(run_id)");

	function record(event: RecordEventInput): EventRecord {
		// Assign identity + timestamp here so callers stay declarative. UUID is the
		// public id; ISO-8601 keeps timestamps human-readable. `seq` is omitted from
		// the insert — SQLite autoincrements it.
		const record: EventRecord = {
			id: crypto.randomUUID(),
			agentName: event.agentName,
			// Normalise `undefined` -> `null` so the column is always an explicit value.
			runId: event.runId ?? null,
			type: event.type,
			tool: event.tool ?? null,
			detail: event.detail ?? null,
			createdAt: new Date().toISOString(),
		};

		db.query(
			`INSERT INTO events (id, agent_name, run_id, type, tool, detail, created_at)
			 VALUES ($id, $agent_name, $run_id, $type, $tool, $detail, $created_at)`,
		).run({
			$id: record.id,
			$agent_name: record.agentName,
			$run_id: record.runId,
			$type: record.type,
			$tool: record.tool,
			$detail: record.detail,
			$created_at: record.createdAt,
		});

		// We already hold every public field, so return directly rather than reading
		// the row back (the only thing the DB added is the internal `seq`).
		return record;
	}

	function list(filter: ListEventsFilter = {}): EventRecord[] {
		// Build the WHERE clause from only the provided filters. Using named
		// parameters keeps the query injection-safe and lets us add clauses
		// conditionally without positional bookkeeping.
		const clauses: string[] = [];
		// Bind values can be strings (filters) or a number (limit), so the map is
		// typed accordingly. Building one params object keeps binding injection-safe.
		const params: Record<string, string | number> = {};

		if (filter.agentName !== undefined) {
			clauses.push("agent_name = $agent_name");
			params.$agent_name = filter.agentName;
		}
		if (filter.runId !== undefined) {
			clauses.push("run_id = $run_id");
			params.$run_id = filter.runId;
		}
		if (filter.type !== undefined) {
			clauses.push("type = $type");
			params.$type = filter.type;
		}

		const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";

		// Order strictly by `seq DESC` (insertion order, newest first). This is
		// deterministic even when many events share a millisecond `created_at` — see
		// EventRow for the rationale.
		let sql = `SELECT seq, id, agent_name, run_id, type, tool, detail, created_at
		           FROM events ${where}
		           ORDER BY seq DESC`;

		// Only apply LIMIT for a positive, finite integer. Anything else (0,
		// negative, NaN, undefined) is treated as "no limit" rather than silently
		// returning nothing or erroring. Capturing into a local `const` lets TS
		// narrow it to `number` for the bind below.
		const { limit } = filter;
		if (typeof limit === "number" && Number.isInteger(limit) && limit > 0) {
			sql += " LIMIT $limit";
			params.$limit = limit;
		}

		const rows = db.query(sql).all(params) as EventRow[];

		return rows.map(rowToRecord);
	}

	function deleteByAgent(agentName: string, runId?: string): number {
		// Count first so we can report how many rows were removed (bun:sqlite's
		// run() does not surface a changes count through this query API uniformly).
		const where =
			runId !== undefined
				? "agent_name = $agent_name AND run_id = $run_id"
				: "agent_name = $agent_name";
		const params: Record<string, string> = { $agent_name: agentName };
		if (runId !== undefined) params.$run_id = runId;
		const countRow = db.query(`SELECT COUNT(*) AS n FROM events WHERE ${where}`).get(params) as {
			n: number;
		} | null;
		const n = countRow?.n ?? 0;
		if (n > 0) db.query(`DELETE FROM events WHERE ${where}`).run(params);
		return n;
	}

	function close(): void {
		db.close();
	}

	return { record, list, deleteByAgent, close };
}
