/**
 * SQLite-backed mail store (low-level).
 *
 * The mail bus is how agents talk to each other and to the orchestrator. This
 * module is the *storage* layer: a thin, synchronous CRUD wrapper over a single
 * `messages` table. The higher-level mail client (broadcast resolution,
 * `--inject` formatting, protocol semantics) is built on top of this store.
 *
 * Design notes:
 * - The DB is opened through {@link openDatabase}, which applies WAL mode and a
 *   busy timeout — both required because many agent processes poll the same file
 *   concurrently (~ms-latency reads, occasional writes).
 * - Columns are snake_case (SQL idiom); the public {@link MailMessage} shape is
 *   camelCase. {@link rowToMessage} is the single translation point.
 * - `read` is stored as an INTEGER (0/1) because SQLite has no boolean type.
 * - This is a greenfield schema, so there is no migration logic: `CREATE TABLE
 *   IF NOT EXISTS` is the whole story.
 */

import type { Database } from "bun:sqlite";
import { openDatabase } from "../db/sqlite.ts";
import { NotFoundError, ValidationError } from "../errors.ts";
import type { MailMessage, MailPriority, MailType, NewMail } from "../types.ts";

/** Filters accepted by {@link MailStore.list}. */
export interface MailListFilter {
	from?: string;
	to?: string;
	unread?: boolean;
	limit?: number;
}

/** Options for {@link MailStore.purge}. */
export interface MailPurgeOptions {
	/** Delete messages strictly older than this many days. */
	olderThanDays?: number;
	/** Restrict to messages this agent sent or received. */
	agent?: string;
	/** Delete every message (ignores the other options when true). */
	all?: boolean;
}

/** The low-level mail storage contract. */
export interface MailStore {
	/** Persist a new message; assigns id/createdAt/read and applies defaults. */
	send(mail: NewMail): MailMessage;
	/** Messages addressed to `agent`, newest first (optionally unread-only). */
	getInbox(agent: string, opts?: { unreadOnly?: boolean }): MailMessage[];
	/** Mark a single message read (no-op if the id does not exist). */
	markRead(id: string): void;
	/** Fetch one message by id, or null if absent. */
	getById(id: string): MailMessage | null;
	/** Query messages with optional filters, newest first. */
	list(filter?: MailListFilter): MailMessage[];
	/** Reply to a message in the same thread; returns the stored reply. */
	reply(id: string, body: string, from: string): MailMessage;
	/** Delete messages matching `opts`; returns the number deleted. */
	purge(opts?: MailPurgeOptions): number;
	/** Close the underlying database connection. */
	close(): void;
}

/**
 * Row shape as stored in SQLite. Distinct from {@link MailMessage} because
 * columns are snake_case and `read` is an integer rather than a boolean.
 */
interface MessageRow {
	/** Monotonic insertion sequence; the deterministic ordering tiebreak. */
	seq: number;
	id: string;
	from_agent: string;
	to_agent: string;
	subject: string;
	body: string;
	type: string;
	priority: string;
	thread_id: string | null;
	payload: string | null;
	read: number;
	created_at: string;
}

const CREATE_TABLE = `
CREATE TABLE IF NOT EXISTS messages (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  from_agent TEXT NOT NULL,
  to_agent TEXT NOT NULL,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  type TEXT NOT NULL,
  priority TEXT NOT NULL DEFAULT 'normal',
  thread_id TEXT,
  payload TEXT,
  read INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
)`;

// Indexes target the two hot read paths: inbox lookups (to_agent + read) and
// thread reconstruction (thread_id). Created up front, not per query.
const CREATE_INDEXES = `
CREATE INDEX IF NOT EXISTS idx_messages_inbox ON messages(to_agent, read);
CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(thread_id)`;

/** Translate a stored row (snake_case, int boolean) into a {@link MailMessage}. */
function rowToMessage(row: MessageRow): MailMessage {
	return {
		id: row.id,
		from: row.from_agent,
		to: row.to_agent,
		subject: row.subject,
		body: row.body,
		// The CHECK-free schema trusts callers (typed at NewMail) for valid values;
		// narrow back to the union here so consumers get the precise types.
		type: row.type as MailType,
		priority: row.priority as MailPriority,
		threadId: row.thread_id,
		payload: row.payload,
		read: row.read === 1,
		createdAt: row.created_at,
	};
}

/** Insert one fully-resolved message and return the public view of it. */
function insertMessage(db: Database, message: MailMessage): MailMessage {
	db.query(
		`INSERT INTO messages
			(id, from_agent, to_agent, subject, body, type, priority, thread_id, payload, read, created_at)
		VALUES
			($id, $from, $to, $subject, $body, $type, $priority, $threadId, $payload, $read, $createdAt)`,
	).run({
		$id: message.id,
		$from: message.from,
		$to: message.to,
		$subject: message.subject,
		$body: message.body,
		$type: message.type,
		$priority: message.priority,
		$threadId: message.threadId,
		$payload: message.payload,
		// SQLite stores booleans as integers.
		$read: message.read ? 1 : 0,
		$createdAt: message.createdAt,
	});
	return message;
}

/**
 * Open (or create) a mail store backed by the SQLite database at `dbPath`.
 * Pass `":memory:"` for an ephemeral store (used in tests).
 */
export function createMailStore(dbPath: string): MailStore {
	// Guard on `messages.seq`: the unrelated @ag-eco/agentplate-cli uses a
	// `messages` table without our `seq` column and a stricter `type` CHECK that
	// would reject Agentplate's delivery-pipeline message types.
	const db = openDatabase(dbPath, { guard: { table: "messages", columns: ["seq"] } });
	db.exec(CREATE_TABLE);
	db.exec(CREATE_INDEXES);

	return {
		send(mail: NewMail): MailMessage {
			// `to`/`from` are the routing keys; an empty address would silently
			// strand the message, so reject it early with a clear error.
			if (mail.to.trim() === "") {
				throw new ValidationError("mail.to must be a non-empty agent name");
			}
			if (mail.from.trim() === "") {
				throw new ValidationError("mail.from must be a non-empty agent name");
			}

			const message: MailMessage = {
				id: crypto.randomUUID(),
				from: mail.from,
				to: mail.to,
				subject: mail.subject,
				body: mail.body,
				type: mail.type,
				priority: mail.priority ?? "normal",
				threadId: mail.threadId ?? null,
				payload: mail.payload ?? null,
				read: false,
				createdAt: new Date().toISOString(),
			};
			return insertMessage(db, message);
		},

		getInbox(agent: string, opts?: { unreadOnly?: boolean }): MailMessage[] {
			// Newest first so callers see the most recent messages at the top. The
			// seq tiebreak makes ordering deterministic even when many messages
			// share a created_at (sub-millisecond inserts); UUID ids would not.
			const sql = opts?.unreadOnly
				? `SELECT * FROM messages WHERE to_agent = $agent AND read = 0 ORDER BY created_at DESC, seq DESC`
				: `SELECT * FROM messages WHERE to_agent = $agent ORDER BY created_at DESC, seq DESC`;
			const rows = db.query(sql).all({ $agent: agent }) as MessageRow[];
			return rows.map(rowToMessage);
		},

		markRead(id: string): void {
			db.query("UPDATE messages SET read = 1 WHERE id = $id").run({ $id: id });
		},

		getById(id: string): MailMessage | null {
			const row = db
				.query("SELECT * FROM messages WHERE id = $id")
				.get({ $id: id }) as MessageRow | null;
			return row ? rowToMessage(row) : null;
		},

		list(filter?: MailListFilter): MailMessage[] {
			// Build the WHERE clause dynamically from whichever filters are set.
			// Parameters are always bound (never interpolated) to avoid injection.
			const conditions: string[] = [];
			const params: Record<string, string | number> = {};

			if (filter?.from !== undefined) {
				conditions.push("from_agent = $from");
				params.$from = filter.from;
			}
			if (filter?.to !== undefined) {
				conditions.push("to_agent = $to");
				params.$to = filter.to;
			}
			if (filter?.unread !== undefined) {
				conditions.push("read = $read");
				params.$read = filter.unread ? 0 : 1;
			}

			const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
			let sql = `SELECT * FROM messages ${where} ORDER BY created_at DESC, seq DESC`;
			if (filter?.limit !== undefined) {
				sql += " LIMIT $limit";
				params.$limit = filter.limit;
			}

			const rows = db.query(sql).all(params) as MessageRow[];
			return rows.map(rowToMessage);
		},

		reply(id: string, body: string, from: string): MailMessage {
			const original = this.getById(id);
			if (!original) {
				throw new NotFoundError(`Cannot reply: message "${id}" not found`);
			}

			// A reply joins the original's thread. If the original started a new
			// thread (threadId === null) we adopt its id as the thread root so the
			// whole exchange shares one thread id.
			const reply: MailMessage = {
				id: crypto.randomUUID(),
				from,
				to: original.from,
				subject: original.subject,
				body,
				type: "result",
				priority: original.priority,
				threadId: original.threadId ?? original.id,
				payload: null,
				read: false,
				createdAt: new Date().toISOString(),
			};
			return insertMessage(db, reply);
		},

		purge(opts?: MailPurgeOptions): number {
			// `all` is the nuclear option and ignores the finer-grained filters.
			if (opts?.all) {
				const before = countRows(db, "", {});
				db.query("DELETE FROM messages").run();
				return before;
			}

			const conditions: string[] = [];
			const params: Record<string, string> = {};

			if (opts?.olderThanDays !== undefined) {
				// Cutoff is an ISO timestamp so the comparison matches created_at's
				// lexicographic ordering (ISO-8601 sorts chronologically as text).
				const cutoffMs = Date.now() - opts.olderThanDays * 24 * 60 * 60 * 1000;
				conditions.push("created_at < $cutoff");
				params.$cutoff = new Date(cutoffMs).toISOString();
			}
			if (opts?.agent !== undefined) {
				conditions.push("(from_agent = $agent OR to_agent = $agent)");
				params.$agent = opts.agent;
			}

			// With no criteria there is nothing to purge — refuse to wipe the table
			// implicitly (that path is reserved for the explicit `all` flag).
			if (conditions.length === 0) {
				return 0;
			}

			const where = `WHERE ${conditions.join(" AND ")}`;
			const before = countRows(db, where, params);
			db.query(`DELETE FROM messages ${where}`).run(params);
			return before;
		},

		close(): void {
			db.close();
		},
	};
}

/** Count rows matching an optional WHERE clause (used to report purge totals). */
function countRows(db: Database, where: string, params: Record<string, string | number>): number {
	const row = db.query(`SELECT COUNT(*) AS n FROM messages ${where}`).get(params) as {
		n: number;
	} | null;
	return row?.n ?? 0;
}
