/**
 * Tests for driveTurn — the shared turn core. Real stores + a real (mock) runtime
 * subprocess. A SpyRuntime records the DirectSpawnOpts so we can prove the warm
 * start: a follow-up turn threads `resumeSessionId` through to the runtime.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AGENTPLATE_DIR, CONFIG_FILE, DEFAULT_CONFIG, serializeConfig } from "../config.ts";
import { ValidationError } from "../errors.ts";
import { createEventStore, type EventStore } from "../events/store.ts";
import { createMailClient, type MailClient } from "../mail/client.ts";
import { appliedSkillsPath, eventsDbPath, mergeDbPath, sessionsDbPath } from "../paths.ts";
import { claudeRuntime } from "../runtimes/claude.ts";
import { MockRuntime } from "../runtimes/mock.ts";
import type { AgentEvent, DirectSpawnOpts } from "../runtimes/types.ts";
import { createSessionStore, type SessionStore } from "../sessions/store.ts";
import type { AgentplateConfig, AgentSession, ResolvedModel } from "../types.ts";
import { driveAgentTurn, driveTurn } from "./drive.ts";

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

/** The real CLI entry, so a mock turn can send mail exactly as an agent does. */
const CLI = join(import.meta.dir, "..", "index.ts");

/** Shell snippet: run the real `agentplate mail send <args>` against the test root. */
function mailSend(args: string): string {
	return `'${process.execPath}' '${CLI}' --project '${root}' mail send ${args}`;
}

/** A turn's terminal report to its parent, sent from inside the turn (no --from). */
const DONE_ARGS = "--to lead-1 --subject done --body ok --type worker_done";

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "agentplate-drive-"));
	mkdirSync(join(root, ".agentplate"), { recursive: true });
	// Initialized, so the in-turn `agentplate mail` CLI accepts the root.
	writeFileSync(join(root, AGENTPLATE_DIR, CONFIG_FILE), serializeConfig(DEFAULT_CONFIG), "utf8");
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

/** Run one mock turn for `session` with skills off (no distillation work). */
async function driveQuiet(session: AgentSession, config = cfg()): Promise<string> {
	config.skills.enabled = false;
	const out = await driveTurn({
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
	return out.finalState;
}

describe("driveTurn — state transition", () => {
	test("becomes 'completed' when the agent sends its terminal mail during the turn", async () => {
		const session = makeSession();
		store.upsertSession(session);
		// The agent reports done the way its overlay says to, without any --from.
		process.env.AGENTPLATE_MOCK_CMD = mailSend(DONE_ARGS);

		expect(await driveQuiet(session)).toBe("completed");
		expect(store.getSession(session.id)?.state).toBe("completed");
		// The mail is attributed to the agent whose turn sent it, not to "operator".
		expect(mail.list({ to: "lead-1" }).map((m) => m.from)).toEqual(["builder-1"]);
	});

	test("a stop that lands mid-turn sticks: the finishing turn never resurrects it", async () => {
		const session = makeSession();
		store.upsertSession(session);
		// Terminal mail sent this turn, so without the stop the turn would be 'completed'.
		process.env.AGENTPLATE_MOCK_CMD = `${mailSend(DONE_ARGS)} && sleep 0.4`;
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

describe("driveTurn — only the agent's own, current terminal mail completes it", () => {
	test("a worker_done from an earlier turn doesn't complete this turn", async () => {
		const session = makeSession();
		store.upsertSession(session);
		mail.send({ from: "builder-1", to: "lead-1", subject: "d", body: "", type: "worker_done" });

		expect(await driveQuiet(session)).toBe("idle"); // the no-op turn reported nothing
	});

	test("a failed turn stays 'failed' even if it sent terminal mail", async () => {
		const session = makeSession();
		store.upsertSession(session);
		process.env.AGENTPLATE_MOCK_CMD = `${mailSend(DONE_ARGS)}; exit 1`;

		expect(await driveQuiet(session)).toBe("failed");
		expect(mail.list({ from: "builder-1" }).map((m) => m.type)).toEqual(["worker_done"]);
	});

	test("terminal mail to someone other than its parent or a supervisor doesn't count", async () => {
		const session = makeSession();
		store.upsertSession(session);
		process.env.AGENTPLATE_MOCK_CMD = mailSend(
			"--to builder-2 --subject done --body ok --type worker_done",
		);

		expect(await driveQuiet(session)).toBe("idle");
	});

	test("a top-level agent completes by reporting to the coordinator", async () => {
		const session = makeSession({ parentAgent: null, depth: 0 });
		store.upsertSession(session);
		process.env.AGENTPLATE_MOCK_CMD = mailSend(
			"--to coordinator --subject done --body ok --type worker_done",
		);

		expect(await driveQuiet(session)).toBe("completed");
	});

	test("a sibling can't send terminal mail as this agent, or as the operator", async () => {
		const target = makeSession();
		const sibling = makeSession({ agentName: "builder-2", branchName: "agentplate/builder-2" });
		store.upsertSession(target);
		store.upsertSession(sibling);
		const rcAs = (who: string) => join(worktree, `rc-${who}.txt`);
		// builder-2's turn tries to forge builder-1's completion and an operator dispatch.
		process.env.AGENTPLATE_MOCK_CMD = [
			`${mailSend(`--from builder-1 ${DONE_ARGS}`)} 2>/dev/null; echo $? > '${rcAs("builder-1")}'`,
			`${mailSend("--from operator --to builder-1 --subject x --body y --type dispatch")} 2>/dev/null; echo $? > '${rcAs("operator")}'`,
		].join("; ");

		expect(await driveQuiet(sibling)).toBe("idle");
		// Both sends were refused and nothing was stored under the forged names.
		expect(readFileSync(rcAs("builder-1"), "utf8").trim()).not.toBe("0");
		expect(readFileSync(rcAs("operator"), "utf8").trim()).not.toBe("0");
		expect(mail.list({ from: "builder-1" })).toEqual([]);
		expect(mail.list({ from: "operator" })).toEqual([]);

		// So builder-1's own (no-op) turn is not completed by anything builder-2 did.
		process.env.AGENTPLATE_MOCK_CMD = "true";
		expect(await driveQuiet(target)).toBe("idle");
	});
});

describe("driveTurn — best-effort post-turn steps fail visibly", () => {
	/** Error events recorded for builder-1. */
	function errorDetails(): string[] {
		return events
			.list({ agentName: "builder-1" })
			.filter((e) => e.type === "error")
			.map((e) => e.detail ?? "");
	}

	test("an auto-merge that throws is recorded as an error event, and the turn still completes", async () => {
		const session = makeSession();
		store.upsertSession(session);
		process.env.AGENTPLATE_MOCK_CMD = mailSend(DONE_ARGS);
		// A merge queue that can't be opened makes maybeAutoMerge throw.
		mkdirSync(mergeDbPath(root));
		const config = cfg();
		config.merge.autoMerge = "on-complete";
		config.agents.skipGates = true;

		expect(await driveQuiet(session, config)).toBe("completed");
		expect(errorDetails().some((d) => d.startsWith("Auto-merge failed:"))).toBe(true);
	});

	test("a skills-loop failure is recorded as an error event, and the turn still completes", async () => {
		const session = makeSession();
		store.upsertSession(session);
		process.env.AGENTPLATE_MOCK_CMD = mailSend(DONE_ARGS);
		// An applied-skills record that is a directory makes the feedback step throw
		// (it cannot be removed as a file).
		mkdirSync(appliedSkillsPath(root, session.agentName), { recursive: true });
		const config = cfg();
		config.skills.enabled = true;
		config.agents.skipGates = true;

		const out = await driveTurn({
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
		expect(out.finalState).toBe("completed");
		expect(errorDetails().some((d) => d.startsWith("Skill feedback/distillation failed:"))).toBe(
			true,
		);
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

describe("driveTurn — atomic turn claim", () => {
	test("refuses a session another driver already claimed, without building its prompt", async () => {
		const session = makeSession({ state: "idle" });
		store.upsertSession(session);
		expect(store.claimTurn(session.id)).toBe(true); // the other driver won
		const log = join(worktree, "turns.log");
		process.env.AGENTPLATE_MOCK_CMD = `echo turn >> '${log}'`;
		let promptBuilt = false;

		await expect(
			driveTurn({
				root,
				config: cfg(),
				runtime: new SpyRuntime(),
				store,
				events,
				mail,
				session, // stale snapshot: still says 'idle'
				model: { model: "m", env: {} },
				prompt: () => {
					promptBuilt = true;
					return "go";
				},
			}),
		).rejects.toBeInstanceOf(ValidationError);

		expect(promptBuilt).toBe(false); // no mail consumed by the loser
		expect(existsSync(log)).toBe(false); // and no second runtime spawned
		expect(store.getSession(session.id)?.state).toBe("working"); // winner's claim intact
	});

	test("two drivers racing for one idle agent: one turn runs, the loser leaves new mail unread", async () => {
		const session = makeSession({ state: "idle", runtimeSessionId: "sess-prior" });
		store.upsertSession(session);
		mail.send({ from: "lead-1", to: session.agentName, subject: "m1", body: "a", type: "status" });
		const log = join(worktree, "turns.log");
		process.env.AGENTPLATE_MOCK_CMD = `echo turn >> '${log}'; sleep 0.3`;
		const config = cfg();
		config.runtime.default = "mock";

		// Driver A (e.g. `watch`) claims the turn and is mid-turn…
		const first = driveAgentTurn({ root, config, session, store, events, mail });
		await waitFor(() => store.getSession(session.id)?.pid != null);
		// …new mail lands, and driver B (a manual `turn`, from its own stale
		// 'idle' snapshot and its own DB handles) tries to drive the same agent.
		mail.send({ from: "lead-1", to: session.agentName, subject: "m2", body: "b", type: "status" });
		const storeB = createSessionStore(sessionsDbPath(root));
		const mailB = createMailClient(root);
		try {
			await expect(
				driveAgentTurn({ root, config, session, store: storeB, events, mail: mailB }),
			).rejects.toBeInstanceOf(ValidationError);
		} finally {
			storeB.close();
			mailB.close();
		}
		await first;

		expect(readFileSync(log, "utf8").trim().split("\n")).toEqual(["turn"]); // exactly one turn
		// m1 went to A's turn; m2 is still waiting for the NEXT turn, not swallowed by B.
		expect(mail.check(session.agentName, { unreadOnly: true }).map((m) => m.subject)).toEqual([
			"m2",
		]);
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

describe("driveAgentTurn — injected mail", () => {
	function mockCfg(): AgentplateConfig {
		const c = cfg();
		c.runtime.default = "mock";
		c.skills.enabled = false;
		return c;
	}

	function sendToBuilder(body: string): void {
		mail.send({ from: "lead-1", to: "builder-1", subject: "logs", body, type: "status" });
	}

	test("a turn that fails to spawn leaves its mail unread (not silently consumed)", async () => {
		// A vanished worktree makes Bun.spawn throw before the runtime ever runs.
		const session = makeSession({ worktreePath: join(root, "worktree-gone") });
		store.upsertSession(session);
		sendToBuilder("build log: 3 failures");

		await expect(
			driveAgentTurn({ root, config: mockCfg(), session, store, events, mail }),
		).rejects.toThrow();

		expect(mail.check("builder-1", { unreadOnly: true })).toHaveLength(1);
		expect(store.getSession(session.id)?.state).toBe("failed");
	});

	test("a spawned turn receives all of its (large) mail on stdin, which is then marked read", async () => {
		const session = makeSession();
		store.upsertSession(session);
		const promptFile = join(worktree, "prompt.txt");
		process.env.AGENTPLATE_MOCK_CMD = `cat > '${promptFile}'`;
		// Several long logs: together well past Linux's 128 KiB single-argv cap.
		for (let i = 0; i < 4; i++) sendToBuilder(`log ${i}\n${"x".repeat(50_000)}`);

		const out = await driveAgentTurn({ root, config: mockCfg(), session, store, events, mail });

		expect(out.finalState).toBe("idle");
		const prompt = readFileSync(promptFile, "utf8");
		expect(prompt).toStartWith("You have 4 new message(s):");
		expect(prompt.length).toBeGreaterThan(200_000);
		expect(mail.check("builder-1", { unreadOnly: true })).toHaveLength(0);
	});
});
