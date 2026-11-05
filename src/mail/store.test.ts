/**
 * Tests for the low-level SQLite mail store.
 *
 * Uses a real temp-file SQLite database (not a mock and not `:memory:`) so the
 * tests exercise the same WAL-mode file path agents use in production. Each test
 * gets a fresh file via beforeEach/afterEach.
 */

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_LIST_LIMIT, openDatabase } from "../db/sqlite.ts";
import { NotFoundError, ValidationError } from "../errors.ts";
import type { NewMail } from "../types.ts";
import { createMailStore, MAIL_MIGRATIONS, type MailStore } from "./store.ts";

/** Minimal valid NewMail with overridable fields. */
function newMail(overrides: Partial<NewMail> = {}): NewMail {
	return {
		from: "alice",
		to: "bob",
		subject: "hello",
		body: "world",
		type: "status",
		...overrides,
	};
}

describe("mail store", () => {
	let tmpRoot: string;
	let dbPath: string;
	let store: MailStore;

	beforeEach(() => {
		tmpRoot = mkdtempSync(join(tmpdir(), "agentplate-mail-"));
		dbPath = join(tmpRoot, "mail.db");
		store = createMailStore(dbPath);
	});

	afterEach(() => {
		store.close();
		rmSync(tmpRoot, { recursive: true, force: true });
	});

	describe("send", () => {
		test("assigns id, createdAt, read=false and default priority/threadId", () => {
			const msg = store.send(newMail());
			expect(msg.id).toBeTruthy();
			expect(msg.read).toBe(false);
			expect(msg.priority).toBe("normal");
			expect(msg.threadId).toBeNull();
			expect(msg.payload).toBeNull();
			// createdAt is an ISO-8601 string the Date constructor round-trips.
			expect(new Date(msg.createdAt).toISOString()).toBe(msg.createdAt);
		});

		test("assigns unique ids across sends", () => {
			const a = store.send(newMail());
			const b = store.send(newMail());
			expect(a.id).not.toBe(b.id);
		});

		test("honors explicit priority, threadId and payload", () => {
			const msg = store.send(
				newMail({ priority: "urgent", threadId: "thread-1", payload: '{"k":1}' }),
			);
			expect(msg.priority).toBe("urgent");
			expect(msg.threadId).toBe("thread-1");
			expect(msg.payload).toBe('{"k":1}');
		});

		test("persists across a reopen of the same db file", () => {
			const sent = store.send(newMail({ subject: "persisted" }));
			store.close();
			const reopened = createMailStore(dbPath);
			try {
				const fetched = reopened.getById(sent.id);
				expect(fetched?.subject).toBe("persisted");
			} finally {
				reopened.close();
			}
		});

		test("rejects empty to/from addresses", () => {
			expect(() => store.send(newMail({ to: "" }))).toThrow(ValidationError);
			expect(() => store.send(newMail({ from: "  " }))).toThrow(ValidationError);
		});
	});

	describe("getInbox", () => {
		test("returns only messages addressed to the agent, newest first", () => {
			store.send(newMail({ to: "bob", subject: "first" }));
			store.send(newMail({ to: "carol", subject: "other" }));
			const second = store.send(newMail({ to: "bob", subject: "second" }));

			const inbox = store.getInbox("bob");
			expect(inbox).toHaveLength(2);
			// Newest first: the last "bob" message leads.
			expect(inbox[0]?.id).toBe(second.id);
			expect(inbox.every((m) => m.to === "bob")).toBe(true);
		});

		test("unreadOnly filters out read messages", () => {
			const a = store.send(newMail({ to: "bob" }));
			store.send(newMail({ to: "bob" }));
			store.markRead(a.id);

			const unread = store.getInbox("bob", { unreadOnly: true });
			expect(unread).toHaveLength(1);
			expect(unread[0]?.read).toBe(false);

			// Without the filter, both messages come back.
			expect(store.getInbox("bob")).toHaveLength(2);
		});

		test("returns an empty array for an unknown agent", () => {
			expect(store.getInbox("nobody")).toEqual([]);
		});
	});

	describe("markRead / getById", () => {
		test("markRead flips the read flag", () => {
			const msg = store.send(newMail());
			expect(store.getById(msg.id)?.read).toBe(false);
			store.markRead(msg.id);
			expect(store.getById(msg.id)?.read).toBe(true);
		});

		test("markRead on a missing id is a no-op", () => {
			expect(() => store.markRead("does-not-exist")).not.toThrow();
		});

		test("getById returns null for a missing id", () => {
			expect(store.getById("missing")).toBeNull();
		});
	});

	describe("reply", () => {
		test("starts a thread from a thread-less original (adopts original id)", () => {
			const original = store.send(newMail({ from: "alice", to: "bob", subject: "ping" }));
			const reply = store.reply(original.id, "pong", "bob");

			expect(reply.threadId).toBe(original.id);
			expect(reply.to).toBe("alice"); // routed back to the sender
			expect(reply.from).toBe("bob");
			expect(reply.type).toBe("result");
			expect(reply.subject).toBe("ping"); // inherits the subject
		});

		test("propagates an existing threadId across replies", () => {
			const original = store.send(newMail({ from: "alice", to: "bob", threadId: "t-42" }));
			const reply = store.reply(original.id, "re", "bob");
			expect(reply.threadId).toBe("t-42");

			// A reply to the reply stays on the same thread.
			const second = store.reply(reply.id, "re re", "alice");
			expect(second.threadId).toBe("t-42");
			expect(second.to).toBe("bob");
		});

		test("throws NotFoundError when the original is missing", () => {
			expect(() => store.reply("missing", "body", "bob")).toThrow(NotFoundError);
		});
	});

	describe("list", () => {
		beforeEach(() => {
			store.send(newMail({ from: "alice", to: "bob", subject: "a" }));
			store.send(newMail({ from: "carol", to: "bob", subject: "b" }));
			store.send(newMail({ from: "alice", to: "dave", subject: "c" }));
		});

		test("filters by from", () => {
			const fromAlice = store.list({ from: "alice" });
			expect(fromAlice).toHaveLength(2);
			expect(fromAlice.every((m) => m.from === "alice")).toBe(true);
		});

		test("filters by to", () => {
			const toBob = store.list({ to: "bob" });
			expect(toBob).toHaveLength(2);
			expect(toBob.every((m) => m.to === "bob")).toBe(true);
		});

		test("combines from + to filters", () => {
			const combined = store.list({ from: "alice", to: "bob" });
			expect(combined).toHaveLength(1);
			expect(combined[0]?.subject).toBe("a");
		});

		test("filters by unread", () => {
			const all = store.list();
			expect(all).toHaveLength(3);
			const first = all[0];
			expect(first).toBeDefined();
			if (first) store.markRead(first.id);

			expect(store.list({ unread: true })).toHaveLength(2);
			expect(store.list({ unread: false })).toHaveLength(1);
		});

		test("applies a limit (newest first)", () => {
			const limited = store.list({ limit: 2 });
			expect(limited).toHaveLength(2);
			// The most recently inserted message ("c") should lead.
			expect(limited[0]?.subject).toBe("c");
		});

		test("with no filter returns everything", () => {
			expect(store.list()).toHaveLength(3);
		});
	});

	describe("purge", () => {
		test("all deletes every message and reports the count", () => {
			store.send(newMail());
			store.send(newMail());
			expect(store.purge({ all: true })).toBe(2);
			expect(store.list()).toHaveLength(0);
		});

		test("agent deletes messages the agent sent or received", () => {
			store.send(newMail({ from: "alice", to: "bob" }));
			store.send(newMail({ from: "carol", to: "alice" }));
			store.send(newMail({ from: "carol", to: "dave" }));

			const deleted = store.purge({ agent: "alice" });
			expect(deleted).toBe(2);

			const remaining = store.list();
			expect(remaining).toHaveLength(1);
			expect(remaining[0]?.from).toBe("carol");
			expect(remaining[0]?.to).toBe("dave");
		});

		test("olderThanDays deletes only sufficiently old messages", () => {
			const fresh = store.send(newMail({ subject: "fresh" }));
			const old = store.send(newMail({ subject: "old" }));

			// Backdate the "old" message 30 days into the past by writing created_at
			// directly. We use a real second connection to the same file (allowed —
			// these are real-SQLite tests, no mocks) because the public API
			// intentionally has no "set timestamp" surface.
			const backdated = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
			const raw = openDatabase(dbPath);
			try {
				raw.query("UPDATE messages SET created_at = $ts WHERE id = $id").run({
					$ts: backdated,
					$id: old.id,
				});
			} finally {
				raw.close();
			}

			// Purge anything older than 7 days: only the backdated message qualifies.
			expect(store.purge({ olderThanDays: 7 })).toBe(1);
			expect(store.getById(old.id)).toBeNull();
			expect(store.getById(fresh.id)).not.toBeNull();

			// A 10-year window now matches nothing (the only old row is gone).
			expect(store.purge({ olderThanDays: 3650 })).toBe(0);
		});

		test("with no options deletes nothing (all flag required to wipe)", () => {
			store.send(newMail());
			expect(store.purge()).toBe(0);
			expect(store.purge({})).toBe(0);
			expect(store.list()).toHaveLength(1);
		});

		test("combines olderThanDays + agent (returns 0 when nothing matches)", () => {
			store.send(newMail({ from: "alice", to: "bob", subject: "recent" }));
			// Nothing is both old AND involving zoe, so count is 0 and the row stays.
			expect(store.purge({ olderThanDays: 1, agent: "zoe" })).toBe(0);
			expect(store.list()).toHaveLength(1);
		});
	});

	describe("list limit hardening", () => {
		test("0 / negative / NaN fall back to the default cap instead of dumping or throwing", () => {
			const total = DEFAULT_LIST_LIMIT + 5;
			for (let i = 0; i < total; i++) store.send(newMail({ subject: `m${i}` }));

			// -1 used to bind as SQLite's "no limit"; NaN threw "datatype mismatch".
			for (const limit of [0, -1, Number.NaN]) {
				const rows = store.list({ limit });
				expect(rows).toHaveLength(DEFAULT_LIST_LIMIT);
				expect(rows[0]?.subject).toBe(`m${total - 1}`);
			}
			expect(store.list()).toHaveLength(total);
		});
	});

	describe("schema versioning and indexes", () => {
		/** The query plan's detail lines for `sql` on the store's file. */
		function plan(sql: string): string[] {
			const db = new Database(dbPath);
			const rows = db.query(`EXPLAIN QUERY PLAN ${sql}`).all() as Array<{ detail: string }>;
			db.close();
			return rows.map((r) => r.detail);
		}

		test("newest-first list() and list({ from }) are served by an index, with no temp sort", () => {
			// Same query shapes MailStore.list() builds.
			const newest = plan("SELECT * FROM messages ORDER BY created_at DESC, seq DESC LIMIT 40");
			const fromAgent = plan(
				"SELECT * FROM messages WHERE from_agent = 'a' ORDER BY created_at DESC, seq DESC",
			);
			for (const detail of [newest, fromAgent]) {
				expect(detail.join("\n")).not.toContain("TEMP B-TREE");
				expect(detail.join("\n")).not.toMatch(/SCAN messages$/m);
			}
			expect(fromAgent.join("\n")).toContain("idx_messages_from");
			// The inbox lookup still uses its own (to_agent, read) index.
			expect(plan("SELECT * FROM messages WHERE to_agent = 'b' AND read = 0").join("\n")).toContain(
				"idx_messages_inbox",
			);
		});

		test("a pre-versioning mail.db gains the new indexes and keeps its messages", () => {
			store.send(newMail({ subject: "kept" }));
			store.close();
			// Rewind to what the pre-versioning code left behind: user_version 0 and
			// only the original two indexes.
			const raw = new Database(dbPath);
			raw.exec("DROP INDEX idx_messages_from");
			raw.exec("DROP INDEX idx_messages_created");
			raw.exec("PRAGMA user_version = 0");
			raw.close();

			store = createMailStore(dbPath);
			expect(store.list().map((m) => m.subject)).toEqual(["kept"]);
			const check = new Database(dbPath);
			const indexes = (
				check
					.query("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'messages'")
					.all() as Array<{ name: string }>
			).map((r) => r.name);
			const { user_version } = check.query("PRAGMA user_version").get() as {
				user_version: number;
			};
			check.close();
			expect(indexes).toEqual(
				expect.arrayContaining(["idx_messages_from", "idx_messages_created", "idx_messages_inbox"]),
			);
			expect(user_version).toBe(MAIL_MIGRATIONS.at(-1)?.version ?? -1);
		});
	});
});
