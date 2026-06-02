/**
 * SQLite helper.
 *
 * Every Agentplate store (mail, sessions, events, skills, deploys, merge queue)
 * opens its database through {@link openDatabase} so WAL mode and a busy timeout
 * are applied consistently — both required for safe concurrent access from
 * multiple agent processes.
 *
 * Self-healing schema guard: `.agentplate/*.db` files are gitignored, regenerable
 * runtime state. Because this tool shares the `.agentplate/` directory name (and
 * db filenames) with the unrelated `@ag-eco/agentplate-cli`, a project that used
 * the other tool can leave behind a `sessions.db`/`mail.db` with a *different*
 * schema. `CREATE TABLE IF NOT EXISTS` then silently keeps the foreign table and
 * later inserts fail (e.g. "table runs has no column named created_at"). The
 * optional {@link OpenDatabaseOptions.guard} detects that case, backs up the
 * incompatible file, and recreates a clean database.
 */

import { Database } from "bun:sqlite";
import { existsSync, renameSync } from "node:fs";

/** A required-columns check used to detect a foreign/stale schema. */
export interface SchemaGuard {
	/** Table that must exist with the listed columns (if it exists at all). */
	table: string;
	/** Columns our schema requires on that table. */
	columns: string[];
}

export interface OpenDatabaseOptions {
	/** Open read-only (no schema creation). */
	readonly?: boolean;
	/** Busy timeout in milliseconds (default 5000). */
	busyTimeoutMs?: number;
	/**
	 * Verify an existing file-backed DB has our schema. If the guarded table
	 * exists but is missing any required column, the DB was created by a
	 * different tool/version; the file (and -wal/-shm) is renamed to a
	 * `.incompatible-<ts>` backup and a fresh DB is created in its place.
	 */
	guard?: SchemaGuard;
}

/** Apply our standard PRAGMAs to a freshly opened connection. */
function applyPragmas(db: Database, busyTimeoutMs: number): void {
	db.exec("PRAGMA journal_mode = WAL");
	db.exec(`PRAGMA busy_timeout = ${busyTimeoutMs}`);
	db.exec("PRAGMA foreign_keys = ON");
}

/** Does `table` exist but lack one of the required columns? */
function tableIsIncompatible(db: Database, guard: SchemaGuard): boolean {
	const exists = db
		.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
		.get(guard.table);
	if (!exists) return false; // absent → our CREATE TABLE will make it correctly
	const cols = db.query(`PRAGMA table_info(${guard.table})`).all() as Array<{ name: string }>;
	const present = new Set(cols.map((c) => c.name));
	return guard.columns.some((c) => !present.has(c));
}

/** Rename a stale DB file plus its WAL/SHM sidecars out of the way. */
function backupStaleDb(path: string): string {
	const stamp = new Date().toISOString().replace(/[:.]/g, "-");
	const backup = `${path}.incompatible-${stamp}`;
	for (const suffix of ["", "-wal", "-shm"]) {
		const file = `${path}${suffix}`;
		if (existsSync(file)) {
			try {
				renameSync(file, `${backup}${suffix}`);
			} catch {
				// Best-effort: if a sidecar can't be moved, continue; the main file
				// rename is what matters for recreating a clean DB.
			}
		}
	}
	return backup;
}

/**
 * Open (or create) a SQLite database with WAL journaling and a busy timeout.
 * Pass `":memory:"` as the path for ephemeral test databases. When `guard` is
 * provided and an existing file has an incompatible schema, the file is backed
 * up and recreated.
 */
export function openDatabase(path: string, options: OpenDatabaseOptions = {}): Database {
	const busyTimeoutMs = options.busyTimeoutMs ?? 5000;
	const readonly = options.readonly ?? false;

	let db = new Database(path, { readonly, create: true });
	applyPragmas(db, busyTimeoutMs);

	// Self-heal a foreign/stale schema (file-backed DBs only; never :memory:).
	if (options.guard && !readonly && path !== ":memory:" && tableIsIncompatible(db, options.guard)) {
		db.close();
		backupStaleDb(path);
		db = new Database(path, { readonly: false, create: true });
		applyPragmas(db, busyTimeoutMs);
	}

	return db;
}
