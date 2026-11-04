/**
 * Tests for driveTurn — the shared turn core. Real stores + a real (mock) runtime
 * subprocess. A SpyRuntime records the DirectSpawnOpts so we can prove the warm
 * start: a follow-up turn threads `resumeSessionId` through to the runtime.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../config.ts";
import { createEventStore, type EventStore } from "../events/store.ts";
import { createMailClient, type MailClient } from "../mail/client.ts";
import { eventsDbPath, sessionsDbPath } from "../paths.ts";
import { claudeRuntime } from "../runtimes/claude.ts";
import { MockRuntime } from "../runtimes/mock.ts";
import type { AgentEvent, DirectSpawnOpts } from "../runtimes/types.ts";
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

	test("a stop that lands mid-turn sticks: the finishing turn never resurrects it", async () => {
		const session = makeSession();
		store.upsertSession(session);
		// Terminal mail already sent, so without the stop this turn would be 'completed'.
		mail.send({
			from: session.agentName,
			to: "lead-1",
			subject: "d",
			body: "",
			type: "worker_done",
		});
		process.env.AGENTPLATE_MOCK_CMD = "sleep 0.4";
		const config = cfg();
		config.skills.enabled = false;

		const pending = driveTurn({
			root,
			config,
			runtime: new SpyRuntime(),
			store,
			events,
			mail,
			session,
			model: { model: "m", env: {} },
			prompt: "go",
		});
		await waitFor(() => store.getSession(session.id)?.pid != null);
		store.updateSessionState(session.id, "stopped"); // what `agentplate stop` does

		const out = await pending;
		expect(out.finalState).toBe("stopped");
		expect(store.getSession(session.id)?.state).toBe("stopped");
	});
});

/** Poll `cond` until true (or fail after `ms`). */
async function waitFor(cond: () => boolean, ms = 5000): Promise<void> {
	const deadline = Date.now() + ms;
	while (!cond()) {
		if (Date.now() > deadline) throw new Error("waitFor: timed out");
		await Bun.sleep(10);
	}
}

/** A runtime whose binary doesn't exist, so Bun.spawn throws before any turn runs. */
class MissingBinaryRuntime extends MockRuntime {
	override buildDirectSpawn(_opts: DirectSpawnOpts): string[] {
		return [join(root, "no-such-runtime-binary")];
	}
}

/** Mock runtime that streams one runtime error event (as claude does for API errors). */
class ErrorEventRuntime extends MockRuntime {
	constructor(private readonly message: string) {
		super();
	}
	async *parseEvents(stream: ReadableStream<Uint8Array>): AsyncIterable<AgentEvent> {
		await new Response(stream).text();
		yield { type: "error", error: this.message, raw: { is_error: true, result: this.message } };
	}
}

describe("driveTurn — failure handling", () => {
	test("a spawn that throws leaves the session 'failed' (not 'working') and records why", async () => {
		const session = makeSession({ state: "booting" });
		store.upsertSession(session);

		await expect(
			driveTurn({
				root,
				config: cfg(),
				runtime: new MissingBinaryRuntime(),
				store,
				events,
				mail,
				session,
				model: { model: "m", env: {} },
				prompt: "go",
			}),
		).rejects.toThrow();

		const row = store.getSession(session.id);
		expect(row?.state).toBe("failed");
		expect(row?.pid).toBeNull();
		expect(store.countActive()).toBe(0); // no longer holds a concurrency slot
		const errors = events.list({ agentName: session.agentName }).filter((e) => e.type === "error");
		expect(errors.some((e) => e.detail?.startsWith("Turn failed:"))).toBe(true);
	});

	test("records the live turn's pid while it runs and clears it when the turn ends", async () => {
		const session = makeSession();
		store.upsertSession(session);
		const pidFile = join(worktree, "pid.txt");
		// `$$` is the spawned bash itself — the pid runTurn hands back.
		process.env.AGENTPLATE_MOCK_CMD = `echo $$ > '${pidFile}'; sleep 0.3`;

		const pending = driveTurn({
			root,
			config: cfg(),
			runtime: new SpyRuntime(),
			store,
			events,
			mail,
			session,
			model: { model: "m", env: {} },
			prompt: "go",
		});
		await waitFor(() => store.getSession(session.id)?.pid != null && existsSync(pidFile));
		await waitFor(() => readFileSync(pidFile, "utf8").trim() !== "");
		expect(store.getSession(session.id)?.pid).toBe(Number(readFileSync(pidFile, "utf8").trim()));

		await pending;
		expect(store.getSession(session.id)?.pid).toBeNull();
	});
});

describe("driveTurn — secret redaction in recorded errors", () => {
	const KEY = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789";

	test("redacts secrets in runtime stderr before it reaches events.db", async () => {
		const session = makeSession();
		store.upsertSession(session);
		process.env.AGENTPLATE_MOCK_CMD = `echo 'crash: ANTHROPIC_API_KEY=${KEY} rejected' >&2; exit 3`;

		await driveTurn({
			root,
			config: cfg(),
			runtime: new SpyRuntime(),
			store,
			events,
			mail,
			session,
			model: { model: "m", env: {} },
			prompt: "go",
		});

		const details = events.list({ agentName: session.agentName }).map((e) => e.detail ?? "");
		expect(details.some((d) => d.includes("crash:") && d.includes("[REDACTED]"))).toBe(true);
		expect(details.some((d) => d.includes(KEY))).toBe(false);
	});

	test("redacts secrets in streamed runtime error events", async () => {
		const session = makeSession();
		store.upsertSession(session);

		await driveTurn({
			root,
			config: cfg(),
			runtime: new ErrorEventRuntime(`401 from gateway: invalid x-api-key ${KEY}`),
			store,
			events,
			mail,
			session,
			model: { model: "m", env: {} },
			prompt: "go",
		});

		const details = events.list({ agentName: session.agentName }).map((e) => e.detail ?? "");
		expect(details.some((d) => d.includes("401 from gateway") && d.includes("[REDACTED]"))).toBe(
			true,
		);
		expect(details.some((d) => d.includes(KEY))).toBe(false);
	});
});
