/**
 * `agentplate turn` command tests. Real initialized temp project + a real (mock)
 * runtime turn. Drives the exported command's action via parseAsync.
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
import { NotFoundError, ValidationError } from "../errors.ts";
import { sessionsDbPath } from "../paths.ts";
import { createSessionStore } from "../sessions/store.ts";
import type { AgentSession, SessionState } from "../types.ts";
import { createTurnCommand } from "./turn.ts";

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

function sessionState(agent: string): SessionState | undefined {
	const store = createSessionStore(sessionsDbPath(root));
	try {
		return store.getSessionByAgent(agent)?.state;
	} finally {
		store.close();
	}
}

async function runTurnCmd(agent: string): Promise<void> {
	await createTurnCommand().parseAsync([agent], { from: "user" });
}

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "agentplate-turn-cmd-"));
	worktree = mkdtempSync(join(tmpdir(), "agentplate-turn-wt-"));
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

describe("agentplate turn — refusals", () => {
	test("throws NotFoundError for an unknown agent", async () => {
		await expect(runTurnCmd("ghost")).rejects.toBeInstanceOf(NotFoundError);
	});

	test("refuses a terminal (completed) agent", async () => {
		seedSession({ state: "completed" });
		await expect(runTurnCmd("builder-1")).rejects.toBeInstanceOf(ValidationError);
	});
});

describe("agentplate turn — runs the next turn", () => {
	test("an idle agent takes another turn and transitions", async () => {
		seedSession({ state: "idle" });
		await runTurnCmd("builder-1");
		// No terminal mail from the mock no-op → stays idle (ran without throwing).
		expect(sessionState("builder-1")).toBe("idle");
	});
});
