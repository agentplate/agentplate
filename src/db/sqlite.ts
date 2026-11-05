/**
 * SQLite helper.
 *
 * Every Agentplate store (mail, sessions, events, skills, deploys, merge queue)
 * opens its database through {@link openDatabase} so WAL mode and a busy timeout
 * are applied consistently — both required for safe concurrent access from
 * multiple agent processes.
 *
 * Schema versioning: a store may pass ordered {@link OpenDatabaseOptions.migrations}.
 * The DB's `PRAGMA user_version` records the last applied step; on open, every
 * newer step runs in order inside one `BEGIN IMMEDIATE` transaction, so a column
 * or index added later reaches existing projects instead of relying on
 * `CREATE TABLE IF NOT EXISTS` (which never alters a table that already exists).
 *
 * Self-healing schema guard: `.agentplate/*.db` files are gitignored, regenerable
 * runtime state. Because this tool shares the `.agentplate/` directory name (and
 * db filenames) with the unrelated `@ag-eco/agentplate-cli`, a project that used
 * the other tool can leave behind a `sessions.db`/`mail.db` with a *different*
 * schema. `CREATE TABLE IF NOT EXISTS` then silently keeps the foreign table and
 * later inserts fail (e.g. "table runs has no column named created_at"). The
 * optional {@link OpenDatabaseOptions.guard} detects that case, writes a backup
 * of the incompatible contents, and resets the database in place.
 *
 * WHY in place, under a write lock (not "rename the file and create a new one"):
 * several agent processes can open the same file at once. A rename lets a process
 * that still holds the old inode pass the guard and then rename away the fresh DB
 * another process just created, after which writes land in a file nobody reads.
 * Resetting the one shared file inside `BEGIN IMMEDIATE`, and re-checking once the
 * lock is held, means only the first opener heals and every other opener (whose
 * handle points at the same file) sees the healed, migrated schema.
 */

import { Database } from "bun:sqlite";
import { writeFileSync } from "node:fs";
import { ValidationError } from "../errors.ts";

/** A required-columns check used to detect a foreign/stale schema. */
export interface SchemaGuard {
	/** Table that must exist with the listed columns (if it exists at all). */
	table: string;
	/** Columns our schema requires on that table. */
	columns: string[];
}

/** One ordered schema step (see {@link OpenDatabaseOptions.migrations}). */
export interface Migration {
	/** The `user_version` this step brings the DB to: positive, strictly ascending. */
	version: number;
	/** SQL to run; may hold several statements. */
	sql: string;
}

export interface OpenDatabaseOptions {
	/** Open read-only (no schema creation, no heal, no migrations). */
	readonly?: boolean;
	/** Busy timeout in milliseconds (default 5000). */
	busyTimeoutMs?: number;
	/**
	 * Verify an existing file-backed DB has our schema. If the guarded table
	 * exists but is missing any required column, the DB was created by a
	 * different tool/version: its contents are written to a
	 * `<path>.incompatible-<ts>-<id>` backup and the database is emptied in place
	 * (then `migrations`, if any, rebuild it in the same transaction). When
	 * `migrations` are given, their first step must create the guarded table: a
	 * DB stamped with a user_version but missing that table is treated as foreign.
	 */
	guard?: SchemaGuard;
	/**
	 * Ordered schema migrations, applied when `PRAGMA user_version` is below the
	 * newest step. Version 1 is the baseline and must be idempotent
	 * (`IF NOT EXISTS`): databases created before versioning existed sit at
	 * user_version 0 but already hold the tables. A DB at a *higher* version
	 * than the newest step (written by a newer Agentplate) is left as it is.
	 */
	migrations?: readonly Migration[];
}

/** Rows returned when a caller passes an invalid `limit` (see {@link resolveLimit}). */
export const DEFAULT_LIST_LIMIT = 100;

/**
 * Normalize a caller-supplied row cap for a SQL `LIMIT`. `undefined` means "no
 * limit" (internal callers that want every row). Any other value is truncated to
 * an integer and must be positive: 0, negatives, NaN and ±Infinity fall back to
 * `fallback` instead of becoming an unbounded read (SQLite treats a negative
 * LIMIT as "no limit") or a bind error (NaN is a datatype mismatch).
 */
export function resolveLimit(
	limit: number | undefined,
	fallback: number = DEFAULT_LIST_LIMIT,
): number | undefined {
	if (limit === undefined) return undefined;
	const n = Math.trunc(limit);
	return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Apply our standard PRAGMAs to a freshly opened connection. */
function applyPragmas(db: Database, busyTimeoutMs: number): void {
	db.exec("PRAGMA journal_mode = WAL");
	db.exec(`PRAGMA busy_timeout = ${busyTimeoutMs}`);
	db.exec("PRAGMA foreign_keys = ON");
}

/** Quote an SQL identifier (doubling embedded quotes). */
function quoteIdent(name: string): string {
	return `"${name.replaceAll('"', '""')}"`;
}

/**
 * Does `table` exist but lack one of the required columns? With `versioned`
 * (the store migrates, and its baseline step creates the guarded table), a DB
 * that carries a user_version but not the table also counts: that version stamp
 * is not ours, and trusting it would skip our migrations.
 */
function tableIsIncompatible(db: Database, guard: SchemaGuard, versioned: boolean): boolean {
	const exists = db
		.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
		.get(guard.table);
	// Absent → our CREATE TABLE will make it correctly (unless a foreign version
	// stamp would stop our migrations from running).
	if (!exists) return versioned && userVersion(db) > 0;
	const cols = db.query(`PRAGMA table_info(${quoteIdent(guard.table)})`).all() as Array<{
		name: string;
	}>;
	const present = new Set(cols.map((c) => c.name));
	return guard.columns.some((c) => !present.has(c));
}

/** The DB's current schema version (`PRAGMA user_version`; 0 when never set). */
function userVersion(db: Database): number {
	const row = db.query("PRAGMA user_version").get() as { user_version: number } | null;
	return row?.user_version ?? 0;
}

/** Validate migration ordering and return the newest version (0 when there are none). */
function latestVersion(migrations: readonly Migration[]): number {
	let previous = 0;
	for (const m of migrations) {
		if (!Number.isInteger(m.version) || m.version <= previous) {
			throw new ValidationError(
				`Schema migrations must have strictly ascending positive integer versions (got ${m.version} after ${previous})`,
			);
		}
		previous = m.version;
	}
	return previous;
}

/**
 * Write a consistent snapshot of the open DB (main file + WAL contents) to a new,
 * uniquely named backup next to `path`. The random suffix and the exclusive `wx`
 * flag mean two heals in the same millisecond can never overwrite each other.
 */
function backupStaleDb(db: Database, path: string): string {
	const stamp = new Date().toISOString().replace(/[:.]/g, "-");
	const backup = `${path}.incompatible-${stamp}-${crypto.randomUUID().slice(0, 8)}`;
	writeFileSync(backup, db.serialize(), { flag: "wx" });
	return backup;
}

/** Drop every user table, view and trigger (indexes go with their tables). */
function dropAllObjects(db: Database): void {
	const objects = db
		.query(
			"SELECT type, name FROM sqlite_master WHERE type IN ('view', 'trigger', 'table') AND name NOT GLOB 'sqlite_*'",
		)
		.all() as Array<{ type: "view" | "trigger" | "table"; name: string }>;
	// Views and triggers first, so dropping a table never leaves one dangling.
	const rank = { view: 0, trigger: 1, table: 2 } as const;
	objects.sort((a, b) => rank[a.type] - rank[b.type]);
	for (const o of objects) {
		db.exec(`DROP ${o.type.toUpperCase()} IF EXISTS ${quoteIdent(o.name)}`);
	}
	db.exec("PRAGMA user_version = 0");
}

/**
 * Heal a foreign schema and/or apply pending migrations. The cheap checks run
 * first without a lock; only when there is work to do is the write lock taken,
 * and both checks are repeated under it because a concurrent opener may have
 * finished the same work while this connection waited.
 */
function prepareSchema(db: Database, path: string, options: OpenDatabaseOptions): void {
	// Only file-backed DBs can hold a foreign schema; :memory: is always fresh.
	const guard = path === ":memory:" || path === "" ? undefined : options.guard;
	const migrations = options.migrations ?? [];
	const target = latestVersion(migrations);
	const isForeign = (): boolean =>
		guard !== undefined && tableIsIncompatible(db, guard, migrations.length > 0);
	if (!isForeign() && userVersion(db) >= target) return;

	// DROP TABLE would run FK checks against a foreign parent/child pair, and
	// schema changes should not be FK-checked mid-migration. The pragma is a no-op
	// inside a transaction, so toggle it around BEGIN/COMMIT.
	db.exec("PRAGMA foreign_keys = OFF");
	try {
		db.exec("BEGIN IMMEDIATE");
		try {
			if (isForeign()) {
				backupStaleDb(db, path);
				dropAllObjects(db);
			}
			const from = userVersion(db);
			if (from < target) {
				for (const m of migrations) {
					if (m.version > from) db.exec(m.sql);
				}
				db.exec(`PRAGMA user_version = ${target}`);
			}
			db.exec("COMMIT");
		} catch (err) {
			if (db.inTransaction) db.exec("ROLLBACK");
			throw err;
		}
	} finally {
		db.exec("PRAGMA foreign_keys = ON");
	}
}

/**
 * Open (or create) a SQLite database with WAL journaling and a busy timeout.
 * Pass `":memory:"` as the path for ephemeral test databases. When `guard` is
 * provided and an existing file has an incompatible schema, its contents are
 * backed up and the DB is reset; pending `migrations` are then applied.
 */
export function openDatabase(path: string, options: OpenDatabaseOptions = {}): Database {
	const busyTimeoutMs = options.busyTimeoutMs ?? 5000;
	const readonly = options.readonly ?? false;

	const db = new Database(path, { readonly, create: true });
	try {
		applyPragmas(db, busyTimeoutMs);
		if (!readonly) prepareSchema(db, path, options);
	} catch (err) {
		db.close();
		throw err;
	}
	return db;
}
