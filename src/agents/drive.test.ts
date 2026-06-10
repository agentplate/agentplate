/**
 * Tests for driveTurn — the shared turn core. Real stores + a real (mock) runtime
 * subprocess. A SpyRuntime records the DirectSpawnOpts so we can prove the warm
 * start: a follow-up turn threads `resumeSessionId` through to the runtime.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../config.ts";
import { createEventStore, type EventStore } from "../events/store.ts";
import { createMailClient, type MailClient } from "../mail/client.ts";
import { eventsDbPath, sessionsDbPath } from "../paths.ts";
import { claudeRuntime } from "../runtimes/claude.ts";
import { MockRuntime } from "../runtimes/mock.ts";
import type { DirectSpawnOpts } from "../runtimes/types.ts";
import { createSessionStore, type SessionStore } from "../sessions/store.ts";
import type { AgentplateConfig, AgentSession, ResolvedModel } from "../types.ts";
import { driveTurn } from "./drive.ts";

/** Mock runtime that records the spawn opts (so we can assert the resume id). */
class SpyRuntime extends MockRuntime {
	lastOpts: DirectSpawnOpts | null = null;
	override buildDirectSpawn(opts: DirectSpawnOpts): string[] {
		this.lastOpts = opts;
		return super.buildDirectSpawn(opts);
	}
}

/**
 * Mock-spawned runtime with the REAL claude env shaping: the turn still runs the
 * scripted bash command (never a real `claude`), but the env merged into the
 * child comes from {@link claudeRuntime.buildEnv} — so a test can prove what a
 * keyless-local provider's worker turn actually exports to the subprocess.
 */
class ClaudeEnvRuntime extends MockRuntime {
	override buildEnv(model: ResolvedModel): Record<string, string> {
		return claudeRuntime.buildEnv(model);
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

describe("driveTurn — keyless-local provider env (authMode 'none')", () => {
	test("forwards authMode so the claude keyless env reaches the spawned child", async () => {
		const session = makeSession();
		store.upsertSession(session);

		// The probe writes the keyless-local env vars to a file from INSIDE the
		// spawned child (`-unset` distinguishes set-but-empty from unset), proving
		// what buildEnv actually exported through the worker path — not just what
		// drive.ts intended to pass.
		const probeFile = join(worktree, "env-probe.txt");
		process.env.AGENTPLATE_MOCK_CMD = `printf '%s|%s|%s|%s' "\${ANTHROPIC_BASE_URL-unset}" "\${ANTHROPIC_AUTH_TOKEN-unset}" "\${ANTHROPIC_API_KEY-unset}" "\${ANTHROPIC_SMALL_FAST_MODEL-unset}" > '${probeFile}'`;

		await driveTurn({
			root,
			config: cfg(),
			runtime: new ClaudeEnvRuntime(),
			store,
			events,
			mail,
			session,
			model: {
				model: "local-m",
				env: {},
				baseUrl: "http://127.0.0.1:11434",
				authMode: "none",
			},
			prompt: "go",
		});

		// Base URL mapped, dummy bearer injected, inherited ANTHROPIC_API_KEY
		// neutralized to "" (NOT unset), and the small-fast model pinned.
		expect(readFileSync(probeFile, "utf8")).toBe(
			"http://127.0.0.1:11434|agentplate-local||local-m",
		);
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
