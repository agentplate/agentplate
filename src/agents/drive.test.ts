/**
 * Tests for driveTurn — the shared turn core. Real stores + a real (mock) runtime
 * subprocess. A SpyRuntime records the DirectSpawnOpts so we can prove the warm
 * start: a follow-up turn threads `resumeSessionId` through to the runtime.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../config.ts";
import { createEventStore, type EventStore } from "../events/store.ts";
import { createMailClient, type MailClient } from "../mail/client.ts";
import { eventsDbPath, sessionsDbPath } from "../paths.ts";
import { MockRuntime } from "../runtimes/mock.ts";
import type { DirectSpawnOpts } from "../runtimes/types.ts";
import { createSessionStore, type SessionStore } from "../sessions/store.ts";
import type { AgentplateConfig, AgentSession } from "../types.ts";
import { driveTurn } from "./drive.ts";

/** Mock runtime that records the spawn opts (so we can assert the resume id). */
class SpyRuntime extends MockRuntime {
	lastOpts: DirectSpawnOpts | null = null;
	override buildDirectSpawn(opts: DirectSpawnOpts): string[] {
		this.lastOpts = opts;
		return super.buildDirectSpawn(opts);
	}
}

let root: string;
let worktree: string;
let store: SessionStore;
let events: EventStore;
let mail: MailClient;

function cfg(): AgentplateConfig {
	const c = structuredClone(DEFAULT_CONFIG);
	c.project.root = root;
	c.project.canonicalBranch = "main";
	return c;
}

function makeSession(over: Partial<AgentSession> = {}): AgentSession {
	const now = new Date().toISOString();
	return {
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
		runtimeSessionId: null,
		startedAt: now,
		lastActivity: now,
		...over,
	};
}

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "agentplate-drive-"));
	mkdirSync(join(root, ".agentplate"), { recursive: true });
	worktree = mkdtempSync(join(tmpdir(), "agentplate-drive-wt-"));
	store = createSessionStore(sessionsDbPath(root));
	events = createEventStore(eventsDbPath(root));
	mail = createMailClient(root);
	process.env.AGENTPLATE_MOCK_CMD = "true"; // no-op turn, exits 0
});

afterEach(() => {
	store.close();
	events.close();
	mail.close();
	rmSync(root, { recursive: true, force: true });
	rmSync(worktree, { recursive: true, force: true });
	process.env.AGENTPLATE_MOCK_CMD = undefined;
});

describe("driveTurn — warm start", () => {
	test("threads resumeSessionId through to the runtime spawn (follow-up turn)", async () => {
		const session = makeSession();
		store.upsertSession(session);
		const runtime = new SpyRuntime();

		const out = await driveTurn({
			root,
			config: cfg(),
			runtime,
			store,
			events,
			mail,
			session,
			model: { model: "m", env: {} },
			prompt: "continue",
			resumeSessionId: "sess-abc",
		});

		expect(runtime.lastOpts?.resumeSessionId).toBe("sess-abc"); // warm start
		expect(out.finalState).toBe("idle"); // no terminal mail emitted → paused
		expect(store.getSession(session.id)?.state).toBe("idle");
	});

	test("omits resume on the first turn (cold start)", async () => {
		const session = makeSession();
		store.upsertSession(session);
		const runtime = new SpyRuntime();
		await driveTurn({
			root,
			config: cfg(),
			runtime,
			store,
			events,
			mail,
			session,
			model: { model: "m", env: {} },
			prompt: "begin",
		});
		expect(runtime.lastOpts?.resumeSessionId).toBeUndefined();
	});
});

describe("driveTurn — state transition", () => {
	test("becomes 'completed' when the agent has emitted its terminal mail", async () => {
		const session = makeSession();
		store.upsertSession(session);
		// The agent's own worker_done mail marks the task complete.
		mail.send({
			from: session.agentName,
			to: "lead-1",
			subject: "done",
			body: "",
			type: "worker_done",
		});

		const config = cfg();
		config.skills.enabled = false; // keep the completed path free of distillation work
		const out = await driveTurn({
			root,
			config,
			runtime: new SpyRuntime(),
			store,
			events,
			mail,
			session,
			model: { model: "m", env: {} },
			prompt: "finish",
		});
		expect(out.finalState).toBe("completed");
		expect(store.getSession(session.id)?.state).toBe("completed");
	});
});
