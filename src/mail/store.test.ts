/**
 * Tests for the low-level SQLite mail store.
 *
 * Uses a real temp-file SQLite database (not a mock and not `:memory:`) so the
 * tests exercise the same WAL-mode file path agents use in production. Each test
 * gets a fresh file via beforeEach/afterEach.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../db/sqlite.ts";
import { NotFoundError, ValidationError } from "../errors.ts";
import type { NewMail } from "../types.ts";
import { createMailStore, type MailStore } from "./store.ts";

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
});
