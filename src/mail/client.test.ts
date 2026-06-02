// Tests for the high-level mail client. Uses a REAL temp project root and a REAL
// SQLite mail database (no mocks) per the project's testing philosophy: the only
// thing we exercise is observable client behavior, so the underlying store runs for
// real against a throwaway file.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createMailClient, resolveRecipients } from "./client.ts";

let root: string;
let client: ReturnType<typeof createMailClient>;

beforeEach(() => {
	// A fresh temp project root with the .agentplate dir the client expects.
	root = mkdtempSync(join(tmpdir(), "agentplate-mail-"));
	mkdirSync(join(root, ".agentplate"), { recursive: true });
	client = createMailClient(root);
});

afterEach(() => {
	client.close();
	rmSync(root, { recursive: true, force: true });
});

describe("createMailClient", () => {
	test("rejects an empty root", () => {
		expect(() => createMailClient("")).toThrow();
		expect(() => createMailClient("   ")).toThrow();
	});

	test("send then check returns the message as unread", () => {
		const sent = client.send({
			from: "orchestrator",
			to: "builder-1",
			subject: "start",
			body: "begin task",
			type: "dispatch",
		});

		expect(sent.id).toBeTruthy();

		const inbox = client.check("builder-1");
		expect(inbox.length).toBe(1);
		expect(inbox[0]?.id).toBe(sent.id);

		const unread = client.check("builder-1", { unreadOnly: true });
		expect(unread.length).toBe(1);
		expect(unread[0]?.read).toBe(false);
	});

	test("check only returns the addressed agent's mail", () => {
		client.send({ from: "a", to: "builder-1", subject: "s1", body: "b1", type: "status" });
		client.send({ from: "a", to: "builder-2", subject: "s2", body: "b2", type: "status" });

		expect(client.check("builder-1").length).toBe(1);
		expect(client.check("builder-2").length).toBe(1);
		expect(client.check("nobody").length).toBe(0);
	});

	test("checkInject formats unread mail and marks it read", () => {
		client.send({
			from: "scout-1",
			to: "lead",
			subject: "found it",
			body: "the bug is in foo.ts",
			type: "result",
		});
		client.send({
			from: "scout-2",
			to: "lead",
			subject: "second",
			body: "also check bar.ts",
			type: "status",
		});

		const block = client.checkInject("lead");

		// Header reflects the count.
		expect(block).toContain("You have 2 new message(s):");
		// Per-message metadata is present.
		expect(block).toContain("From: scout-1");
		expect(block).toContain("Subject: found it");
		expect(block).toContain("Type: result");
		// Bodies are included.
		expect(block).toContain("the bug is in foo.ts");
		expect(block).toContain("also check bar.ts");

		// Side effect: the injected mail is now read, so a second inject is empty...
		expect(client.checkInject("lead")).toBe("");
		// ...and an unread-only check confirms nothing remains unread.
		expect(client.check("lead", { unreadOnly: true }).length).toBe(0);
		// The messages still exist (read, not deleted).
		expect(client.check("lead").length).toBe(2);
	});

	test("checkInject returns empty string when there is no unread mail", () => {
		expect(client.checkInject("ghost")).toBe("");
	});

	test("reply keeps the conversation in the same thread", () => {
		const original = client.send({
			from: "builder-1",
			to: "lead",
			subject: "question",
			body: "which branch?",
			type: "question",
		});

		// The store's reply takes the replying agent as the third argument and routes
		// the reply back to the original sender.
		const replied = client.reply(original.id, "use main", "lead");

		// The reply is a real, distinct message.
		expect(replied.id).toBeTruthy();
		expect(replied.id).not.toBe(original.id);
		// It is addressed back to the original sender.
		expect(replied.to).toBe("builder-1");
		expect(replied.from).toBe("lead");

		// It belongs to the same thread as the original. The original started a new
		// thread (threadId === null), so the store adopts the original's id as the
		// shared thread root.
		const expectedThread = original.threadId ?? original.id;
		expect(replied.threadId).toBe(expectedThread);

		// The original sender now has the reply waiting (unread).
		const builderInbox = client.check("builder-1", { unreadOnly: true });
		expect(builderInbox.some((m) => m.id === replied.id)).toBe(true);
	});

	test("markRead marks a single message read", () => {
		const sent = client.send({
			from: "a",
			to: "builder-9",
			subject: "s",
			body: "b",
			type: "status",
		});
		expect(client.check("builder-9", { unreadOnly: true }).length).toBe(1);

		client.markRead(sent.id);
		expect(client.check("builder-9", { unreadOnly: true }).length).toBe(0);
		// Still present, just read.
		expect(client.check("builder-9").length).toBe(1);
	});

	test("list is a passthrough to the store", () => {
		client.send({ from: "a", to: "x", subject: "s", body: "b", type: "status" });
		client.send({ from: "a", to: "y", subject: "s", body: "b", type: "status" });
		expect(client.list().length).toBe(2);
		expect(client.list({ to: "x" }).length).toBe(1);
	});

	test("purge removes messages and reports the count", () => {
		client.send({ from: "a", to: "x", subject: "s", body: "b", type: "status" });
		client.send({ from: "a", to: "y", subject: "s", body: "b", type: "status" });

		const removed = client.purge({ all: true });
		expect(removed).toBe(2);
		expect(client.list().length).toBe(0);
	});
});

describe("resolveRecipients", () => {
	test("expands @all to every known agent", () => {
		const agents = ["builder-1", "scout-1", "lead"];
		expect(client.resolveRecipients("@all", agents)).toEqual(agents);
		// Pure helper behaves identically.
		expect(resolveRecipients("@all", agents)).toEqual(agents);
	});

	test("@all de-duplicates and drops blanks", () => {
		expect(resolveRecipients("@all", ["a", "a", "", "  ", "b"])).toEqual(["a", "b"]);
	});

	test("@all over an empty roster yields no recipients", () => {
		expect(resolveRecipients("@all", [])).toEqual([]);
	});

	test("a concrete address routes to itself", () => {
		expect(resolveRecipients("builder-1", ["builder-1", "scout-1"])).toEqual(["builder-1"]);
		// Unknown-but-concrete addresses still route to themselves (roster is advisory).
		expect(resolveRecipients("ghost", ["builder-1"])).toEqual(["ghost"]);
	});

	test("trims surrounding whitespace on the address", () => {
		expect(resolveRecipients("  builder-1  ", [])).toEqual(["builder-1"]);
	});
});
