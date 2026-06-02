/**
 * `agentplate mail` — inter-agent messaging over the SQLite mail bus.
 *
 * Subcommands: send, check, list, read, reply, purge. Used by agents (from
 * inside worktrees, via `--project`) and by operators.
 */

import { Command } from "commander";
import { findProjectRoot, isInitialized } from "../config.ts";
import { ValidationError } from "../errors.ts";
import { jsonOutput } from "../json.ts";
import { muted, printInfo, printSuccess } from "../logging/color.ts";
import { createMailClient } from "../mail/client.ts";
import type { MailMessage, MailType } from "../types.ts";

function requireInit(): string {
	const root = findProjectRoot();
	if (!isInitialized(root)) {
		throw new ValidationError("Not initialized. Run `agentplate setup` first.");
	}
	return root;
}

function printMessage(m: MailMessage): void {
	printInfo(`${m.read ? " " : "•"} [${m.type}] ${m.from} → ${m.to}: ${m.subject}`);
	printInfo(muted(`    ${m.body.replace(/\n/g, "\n    ")}`));
}

function sendCommand(): Command {
	return new Command("send")
		.description("Send a message")
		.requiredOption("--to <agent>", "recipient")
		.requiredOption("--subject <text>", "subject")
		.requiredOption("--body <text>", "body")
		.option("--from <name>", "sender", "operator")
		.option("--type <type>", "message type", "status")
		.option("--priority <level>", "low|normal|high|urgent", "normal")
		.option("--payload <json>", "structured JSON payload")
		.option("--json", "output JSON")
		.action(
			(
				opts: {
					to: string;
					subject: string;
					body: string;
					from: string;
					type: string;
					priority: string;
					payload?: string;
					json?: boolean;
				},
				command: Command,
			) => {
				const useJson = command.optsWithGlobals().json === true;
				const root = requireInit();
				const client = createMailClient(root);
				try {
					const message = client.send({
						from: opts.from,
						to: opts.to,
						subject: opts.subject,
						body: opts.body,
						type: opts.type as MailType,
						priority: opts.priority as MailMessage["priority"],
						payload: opts.payload ?? null,
					});
					if (useJson) jsonOutput(message);
					else printSuccess(`Sent ${message.id} to ${opts.to}`);
				} finally {
					client.close();
				}
			},
		);
}

function checkCommand(): Command {
	return new Command("check")
		.description("Check an agent's inbox")
		.requiredOption("--agent <name>", "agent whose inbox to check")
		.option("--inject", "format unread for prompt injection and mark read")
		.option("--json", "output JSON")
		.action((opts: { agent: string; inject?: boolean; json?: boolean }, command: Command) => {
			const useJson = command.optsWithGlobals().json === true;
			const root = requireInit();
			const client = createMailClient(root);
			try {
				if (opts.inject) {
					const text = client.checkInject(opts.agent);
					if (useJson) jsonOutput({ injected: text });
					else printInfo(text || muted("(no new mail)"));
					return;
				}
				const messages = client.check(opts.agent, { unreadOnly: true });
				if (useJson) {
					jsonOutput(messages);
					return;
				}
				if (messages.length === 0) printInfo(muted("(no unread mail)"));
				for (const m of messages) printMessage(m);
			} finally {
				client.close();
			}
		});
}

function listCommand(): Command {
	return new Command("list")
		.description("List messages")
		.option("--from <name>")
		.option("--to <name>")
		.option("--unread", "only unread")
		.option("--json", "output JSON")
		.action(
			(
				opts: { from?: string; to?: string; unread?: boolean; json?: boolean },
				command: Command,
			) => {
				const useJson = command.optsWithGlobals().json === true;
				const root = requireInit();
				const client = createMailClient(root);
				try {
					const messages = client.list({ from: opts.from, to: opts.to, unread: opts.unread });
					if (useJson) jsonOutput(messages);
					else for (const m of messages) printMessage(m);
				} finally {
					client.close();
				}
			},
		);
}

function readCommand(): Command {
	return new Command("read")
		.description("Mark a message as read")
		.argument("<id>", "message id")
		.action((id: string) => {
			const root = requireInit();
			const client = createMailClient(root);
			try {
				client.markRead(id);
				printSuccess(`Marked ${id} read`);
			} finally {
				client.close();
			}
		});
}

function replyCommand(): Command {
	return new Command("reply")
		.description("Reply to a message in the same thread")
		.argument("<id>", "message id to reply to")
		.requiredOption("--body <text>", "reply body")
		.option("--from <name>", "sender", "operator")
		.action((id: string, opts: { body: string; from: string }) => {
			const root = requireInit();
			const client = createMailClient(root);
			try {
				const message = client.reply(id, opts.body, opts.from);
				printSuccess(`Replied (${message.id})`);
			} finally {
				client.close();
			}
		});
}

function purgeCommand(): Command {
	return new Command("purge")
		.description("Delete old messages")
		.option("--all", "delete everything")
		.option("--days <n>", "delete older than N days")
		.option("--agent <name>", "delete for one agent")
		.action((opts: { all?: boolean; days?: string; agent?: string }) => {
			const root = requireInit();
			const client = createMailClient(root);
			try {
				const count = client.purge({
					all: opts.all,
					olderThanDays: opts.days ? Number(opts.days) : undefined,
					agent: opts.agent,
				});
				printSuccess(`Purged ${count} message(s)`);
			} finally {
				client.close();
			}
		});
}

export function createMailCommand(): Command {
	return new Command("mail")
		.description("Inter-agent messaging")
		.addCommand(sendCommand())
		.addCommand(checkCommand())
		.addCommand(listCommand())
		.addCommand(readCommand())
		.addCommand(replyCommand())
		.addCommand(purgeCommand());
}
