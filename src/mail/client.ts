// High-level mail client. Wraps the low-level SQLite mail store (createMailStore)
// with the operations the orchestrator and agents actually use: sending, checking
// an inbox, formatting unread mail for prompt injection, threading replies, and
// expanding broadcast recipients like "@all".
//
// WHY a separate layer over the store: the store is intentionally a thin,
// schema-faithful persistence API (rows in/rows out). The ergonomics callers want
// -- "give me an injectable markdown block of my unread mail and mark it read", or
// "expand @all into the live agent list" -- are policy, not storage, so they live
// here. This keeps the store reusable and unopinionated.

import { join } from "node:path";

import { AGENTPLATE_DIR } from "../config.ts";
import { ValidationError } from "../errors.ts";
import type { MailMessage, NewMail } from "../types.ts";
import { createMailStore, type MailListFilter, type MailPurgeOptions } from "./store.ts";

// Broadcast sentinel: a recipient address that fans out to every known agent.
// Mirrors the agentplate mail convention. Kept as a single constant so the
// expansion rule and any future group sentinels have one source of truth.
const BROADCAST_ALL = "@all";

/** Optional filters when checking an inbox. */
export interface CheckOptions {
	/** Return only unread messages (default: all). */
	unreadOnly?: boolean;
}

/** The high-level mail client surface returned by {@link createMailClient}. */
export interface MailClient {
	/** Persist a new message. Delegates to the store. */
	send(mail: NewMail): MailMessage;
	/** Messages addressed to `agent`, newest first (optionally unread-only). */
	check(agent: string, opts?: CheckOptions): MailMessage[];
	/**
	 * Format an agent's UNREAD messages as a compact markdown block suitable for
	 * injecting into the agent's prompt, THEN mark those messages read. Returns ""
	 * when there is nothing unread. The mark-as-read side effect is intentional:
	 * once mail is in the prompt it is considered delivered, so a later inject for
	 * the same agent won't re-surface it.
	 */
	checkInject(agent: string): string;
	/** List messages with optional filters (passthrough to the store). */
	list(filter?: MailListFilter): MailMessage[];
	/**
	 * Reply to a message in the same thread. `from` is the replying agent; the
	 * store routes the reply back to the original sender. Passthrough to the store.
	 */
	reply(id: string, body: string, from: string): MailMessage;
	/** Mark a single message read (passthrough). */
	markRead(id: string): void;
	/** Delete messages per the given criteria; returns how many were removed. */
	purge(opts?: MailPurgeOptions): number;
	/**
	 * Expand a recipient address against the live agent roster. "@all" becomes the
	 * full `knownAgents` list; any other address is returned as a single recipient.
	 */
	resolveRecipients(to: string, knownAgents: string[]): string[];
	/** Close the underlying database handle. */
	close(): void;
}

/**
 * Create a mail client rooted at a project directory. Opens (and owns) the mail
 * database at `<root>/.agentplate/mail.db`.
 *
 * @param root Absolute path to the project root containing `.agentplate/`.
 */
export function createMailClient(root: string): MailClient {
	if (!root || root.trim().length === 0) {
		throw new ValidationError("createMailClient requires a non-empty project root");
	}

	const dbPath = join(root, AGENTPLATE_DIR, "mail.db");
	const store = createMailStore(dbPath);

	function check(agent: string, opts?: CheckOptions): MailMessage[] {
		const recipient = normalizeAgent(agent);
		// Let the store filter on both recipient and (optionally) unread so we lean on
		// its indexed query rather than re-implementing the predicate. The store treats
		// an absent `unread` filter as "all", which matches our default.
		const filter: MailListFilter = { to: recipient };
		if (opts?.unreadOnly) {
			filter.unread = true;
		}
		return store.list(filter);
	}

	function checkInject(agent: string): string {
		const unread = check(agent, { unreadOnly: true });
		if (unread.length === 0) {
			return "";
		}

		const block = formatInjection(unread);

		// Mark each injected message read AFTER formatting, so a failure mid-format
		// does not silently consume mail the agent never saw.
		for (const message of unread) {
			store.markRead(message.id);
		}

		return block;
	}

	return {
		send(mail: NewMail): MailMessage {
			return store.send(mail);
		},
		check,
		checkInject,
		list(filter?: MailListFilter): MailMessage[] {
			return store.list(filter);
		},
		reply(id: string, body: string, from: string): MailMessage {
			return store.reply(id, body, from);
		},
		markRead(id: string): void {
			store.markRead(id);
		},
		purge(opts?: MailPurgeOptions): number {
			return store.purge(opts);
		},
		resolveRecipients(to: string, knownAgents: string[]): string[] {
			return resolveRecipients(to, knownAgents);
		},
		close(): void {
			store.close();
		},
	};
}

/**
 * Expand a recipient address. "@all" fans out to every known agent (de-duplicated,
 * blanks dropped); any other address routes to itself. Exported as a pure helper so
 * callers (and tests) can use the expansion rule without opening a database.
 */
export function resolveRecipients(to: string, knownAgents: string[]): string[] {
	const target = normalizeAgent(to);
	if (target === BROADCAST_ALL) {
		// Dedupe while preserving roster order; skip blank entries defensively.
		const seen = new Set<string>();
		const expanded: string[] = [];
		for (const agent of knownAgents) {
			const name = agent.trim();
			if (name.length === 0 || seen.has(name)) {
				continue;
			}
			seen.add(name);
			expanded.push(name);
		}
		return expanded;
	}
	return [target];
}

/** Trim and validate an agent/recipient identifier. */
function normalizeAgent(agent: string): string {
	const name = agent?.trim();
	if (!name) {
		throw new ValidationError("mail recipient must be a non-empty string");
	}
	return name;
}

/**
 * Render unread messages as a compact markdown block for prompt injection.
 * Shape (per the agent mail convention):
 *
 *   You have 2 new message(s):
 *
 *   1. From: alice | Subject: build done | Type: status
 *      <body>
 *
 *   2. From: bob | ...
 */
function formatInjection(messages: MailMessage[]): string {
	const header = `You have ${messages.length} new message(s):`;
	const entries = messages.map((m, index) => {
		const meta = `${index + 1}. From: ${m.from} | Subject: ${m.subject} | Type: ${m.type}`;
		// Indent the body two spaces so it reads as part of the numbered item; a blank
		// body (allowed by the schema) just omits the body line.
		const indentedBody = m.body.length > 0 ? `\n   ${m.body.split("\n").join("\n   ")}` : "";
		return `${meta}${indentedBody}`;
	});
	return `${header}\n\n${entries.join("\n\n")}`;
}
