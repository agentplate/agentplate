/**
 * FIFO merge queue backed by SQLite.
 *
 * WHY a persisted queue (and not an in-memory array): agent branches become
 * mergeable asynchronously and from different processes — a worker signals
 * `merge_ready`, the coordinator (a separate process, possibly a separate run)
 * drains the queue later. The queue therefore has to survive process exits and
 * be safe under concurrent access, which is exactly what our WAL-mode SQLite
 * helper (`openDatabase`) provides.
 *
 * FIFO ordering: rows carry a monotonically increasing integer `seq`
 * (AUTOINCREMENT) used only for ordering. The caller-facing `id` is a random
 * UUID (per project convention) and says nothing about insertion order, so we
 * cannot order by it. `seq` is an internal column and never leaves this module.
 */

import type { Database } from "bun:sqlite";

import { openDatabase } from "../db/sqlite.ts";
import { NotFoundError } from "../errors.ts";
import type { MergeEntry, MergeStatus } from "../types.ts";

/** A merge queue handle bound to one SQLite database. */
export interface MergeQueue {
	/**
	 * Append a new entry to the queue. `id`, `createdAt`, and `status` are
	 * assigned here (status starts as "pending"); the caller supplies the rest.
	 */
	enqueue(entry: Omit<MergeEntry, "id" | "createdAt" | "status">): MergeEntry;
	/** All pending entries, oldest first. */
	listPending(): MergeEntry[];
	/** Set the status of an entry by id. Throws {@link NotFoundError} if absent. */
	markStatus(id: string, status: MergeStatus): void;
	/**
	 * Remove and return the oldest pending entry, or null if none remain.
	 * The returned object reflects its pre-removal `status` ("pending").
	 */
	dequeue(): MergeEntry | null;
	/** Close the underlying database connection. */
	close(): void;
}

/** Row shape as stored in SQLite (snake_case columns + internal `seq`). */
interface MergeQueueRow {
	seq: number;
	id: string;
	branch_name: string;
	agent_name: string;
	task_id: string;
	target_branch: string;
	status: string;
	created_at: string;
}

// `seq` drives FIFO ordering; `id` is the stable public identifier. We index
// status because every read path (listPending / dequeue) filters on it.
const CREATE_TABLE = `
CREATE TABLE IF NOT EXISTS merge_queue (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  branch_name TEXT NOT NULL,
  agent_name TEXT NOT NULL,
  task_id TEXT NOT NULL,
  target_branch TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK(status IN ('pending','merged','failed')),
  created_at TEXT NOT NULL
)`;

const CREATE_INDEX = `
CREATE INDEX IF NOT EXISTS idx_merge_queue_status_seq ON merge_queue(status, seq)`;

/** Map a stored row to the public {@link MergeEntry} shape (drops `seq`). */
function rowToEntry(row: MergeQueueRow): MergeEntry {
	return {
		id: row.id,
		branchName: row.branch_name,
		agentName: row.agent_name,
		taskId: row.task_id,
		targetBranch: row.target_branch,
		// The CHECK constraint guarantees this is a valid MergeStatus.
		status: row.status as MergeStatus,
		createdAt: row.created_at,
	};
}

/**
 * Open (or create) a FIFO merge queue at `dbPath`. Pass `":memory:"` for an
 * ephemeral queue in tests. The standard project path is
 * `<root>/.agentplate/merge-queue.db`.
 */
export function createMergeQueue(dbPath: string): MergeQueue {
	const db: Database = openDatabase(dbPath);
	db.exec(CREATE_TABLE);
	db.exec(CREATE_INDEX);

	// Prepared statements are reused across calls for the hot paths.
	const insertStmt = db.query<
		MergeQueueRow,
		{
			$id: string;
			$branch_name: string;
			$agent_name: string;
			$task_id: string;
			$target_branch: string;
			$created_at: string;
		}
	>(
		`INSERT INTO merge_queue (id, branch_name, agent_name, task_id, target_branch, created_at)
		 VALUES ($id, $branch_name, $agent_name, $task_id, $target_branch, $created_at)
		 RETURNING *`,
	);

	const listPendingStmt = db.query<MergeQueueRow, []>(
		"SELECT * FROM merge_queue WHERE status = 'pending' ORDER BY seq ASC",
	);

	const firstPendingStmt = db.query<MergeQueueRow, []>(
		"SELECT * FROM merge_queue WHERE status = 'pending' ORDER BY seq ASC LIMIT 1",
	);

	const getByIdStmt = db.query<MergeQueueRow, { $id: string }>(
		"SELECT * FROM merge_queue WHERE id = $id",
	);

	const updateStatusStmt = db.query<void, { $id: string; $status: string }>(
		"UPDATE merge_queue SET status = $status WHERE id = $id",
	);

	const deleteBySeqStmt = db.query<void, { $seq: number }>(
		"DELETE FROM merge_queue WHERE seq = $seq",
	);

	return {
		enqueue(entry): MergeEntry {
			const row = insertStmt.get({
				$id: crypto.randomUUID(),
				$branch_name: entry.branchName,
				$agent_name: entry.agentName,
				$task_id: entry.taskId,
				$target_branch: entry.targetBranch,
				$created_at: new Date().toISOString(),
			});
			// RETURNING * always yields a row on a successful INSERT; the guard is
			// here only to satisfy noUncheckedIndexedAccess-style strictness.
			if (row === null) {
				throw new NotFoundError("merge queue insert returned no row");
			}
			return rowToEntry(row);
		},

		listPending(): MergeEntry[] {
			return listPendingStmt.all().map(rowToEntry);
		},

		markStatus(id, status): void {
			const existing = getByIdStmt.get({ $id: id });
			if (existing === null) {
				throw new NotFoundError(`No merge queue entry with id "${id}"`);
			}
			updateStatusStmt.run({ $id: id, $status: status });
		},

		dequeue(): MergeEntry | null {
			const row = firstPendingStmt.get();
			if (row === null) return null;
			// Remove by the internal seq so we delete exactly the row we read,
			// even if two entries somehow shared other column values.
			deleteBySeqStmt.run({ $seq: row.seq });
			return rowToEntry(row);
		},

		close(): void {
			db.close();
		},
	};
}
