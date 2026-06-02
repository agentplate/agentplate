/**
 * `agentplate watch` tests. Real initialized temp project + real (mock) turns,
 * driven deterministically via `--once`. Asserts which idle agents get advanced.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	AGENTPLATE_DIR,
	CONFIG_FILE,
	DEFAULT_CONFIG,
	serializeConfig,
	setProjectRootOverride,
} from "../config.ts";
import { createMailClient } from "../mail/client.ts";
import { sessionsDbPath } from "../paths.ts";
import { createSessionStore } from "../sessions/store.ts";
import type { AgentSession } from "../types.ts";
import { createWatchCommand } from "./watch.ts";

let root: string;
let worktree: string;

function seedSession(over: Partial<AgentSession>): void {
	const store = createSessionStore(sessionsDbPath(root));
	const now = new Date().toISOString();
	try {
		store.upsertSession({
			id: `session-${crypto.randomUUID()}`,
			agentName: "builder-1",
			capability: "builder",
			taskId: "task-1",
			runId: "run-1",
			worktreePath: worktree,
			branchName: "agentplate/builder-1",
			state: "idle",
			parentAgent: "lead-1",
			depth: 1,
			pid: null,
			runtimeSessionId: "sess-prior",
			startedAt: now,
			lastActivity: now,
			...over,
		});
	} finally {
		store.close();
	}
}

function sendMailTo(agent: string): void {
	const mail = createMailClient(root);
	try {
		mail.send({ from: "lead-1", to: agent, subject: "ping", body: "continue", type: "status" });
	} finally {
		mail.close();
	}
}

/** Run `watch --once --json` and return the parsed summary. */
async function watchOnce(): Promise<{ driven: number; turns: Array<{ agent: string }> }> {
	const original = process.stdout.write.bind(process.stdout);
	let out = "";
	process.stdout.write = (chunk: string | Uint8Array): boolean => {
		out += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
		return true;
	};
	try {
		await createWatchCommand().parseAsync(["--once", "--json"], { from: "user" });
	} finally {
		process.stdout.write = original;
	}
	// jsonOutput wraps the payload in the standard { ok, data } envelope.
	return JSON.parse(out.trim()).data;
}

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "agentplate-watch-"));
	worktree = mkdtempSync(join(tmpdir(), "agentplate-watch-wt-"));
	mkdirSync(join(root, AGENTPLATE_DIR), { recursive: true });
	const config = structuredClone(DEFAULT_CONFIG);
	config.runtime.default = "mock";
	writeFileSync(join(root, AGENTPLATE_DIR, CONFIG_FILE), serializeConfig(config), "utf8");
	setProjectRootOverride(root);
	process.env.AGENTPLATE_MOCK_CMD = "true";
});

afterEach(() => {
	setProjectRootOverride(null);
	rmSync(root, { recursive: true, force: true });
	rmSync(worktree, { recursive: true, force: true });
	process.env.AGENTPLATE_MOCK_CMD = undefined;
});

describe("agentplate watch --once", () => {
	test("drives an idle agent that has unread mail", async () => {
		seedSession({ agentName: "builder-1", state: "idle" });
		sendMailTo("builder-1");
		const out = await watchOnce();
		expect(out.driven).toBe(1);
		expect(out.turns[0]?.agent).toBe("builder-1");
	});

	test("skips an idle agent with no unread mail", async () => {
		seedSession({ agentName: "builder-1", state: "idle" });
		const out = await watchOnce();
		expect(out.driven).toBe(0);
	});

	test("never drives a terminal agent, even with mail", async () => {
		seedSession({ agentName: "builder-1", state: "completed" });
		sendMailTo("builder-1");
		const out = await watchOnce();
		expect(out.driven).toBe(0);
	});

	test("drives only the idle-with-mail agents in a mixed fleet", async () => {
		seedSession({ agentName: "has-mail", state: "idle" });
		seedSession({ agentName: "no-mail", state: "idle" });
		sendMailTo("has-mail");
		const out = await watchOnce();
		expect(out.driven).toBe(1);
		expect(out.turns.map((t) => t.agent)).toEqual(["has-mail"]);
	});
});
