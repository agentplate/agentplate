import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEventStore } from "../events/store.ts";
import { createMailStore } from "../mail/store.ts";
import { createMergeQueue } from "../merge/queue.ts";
import {
	agentStateDir,
	eventsDbPath,
	mailDbPath,
	mergeDbPath,
	sessionsDbPath,
	worktreesDir,
} from "../paths.ts";
import type { AgentSession } from "../types.ts";
import { createWorktree } from "../worktree/manager.ts";
import { isPidAlive, isRemovableWorktree, reapIdleSessions, selectIdleSessions } from "./reaper.ts";
import { createSessionStore } from "./store.ts";

/** Run git in `cwd`; returns exit code + trimmed stdout (real git, no mocks). */
async function git(cwd: string, args: string[]): Promise<{ code: number; out: string }> {
	const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
	const [out, , code] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	return { code, out: out.trim() };
}

async function gitOk(cwd: string, args: string[]): Promise<string> {
	const { code, out } = await git(cwd, args);
	if (code !== 0) throw new Error(`git ${args.join(" ")} failed (${code})`);
	return out;
}

/** Real temp repo on `main` with one commit and a deterministic identity. */
async function initRepo(dir: string): Promise<void> {
	await gitOk(dir, ["init", "-q"]);
	await gitOk(dir, ["config", "user.email", "test@agentplate.dev"]);
	await gitOk(dir, ["config", "user.name", "Agentplate Test"]);
	writeFileSync(join(dir, "README.md"), "# temp\n");
	await gitOk(dir, ["add", "README.md"]);
	await gitOk(dir, ["commit", "-q", "-m", "init"]);
	await gitOk(dir, ["branch", "-M", "main"]);
}

async function branchExists(repo: string, branch: string): Promise<boolean> {
	return (await git(repo, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`])).code === 0;
}

const NOW = Date.parse("2026-06-01T12:00:00.000Z");
const IDLE_MS = 10 * 60_000;

/** ISO timestamp `n` minutes before NOW. */
function minsAgo(n: number): string {
	return new Date(NOW - n * 60_000).toISOString();
}

function mk(overrides: Partial<AgentSession>): AgentSession {
	return {
		id: `s-${overrides.agentName ?? "a"}`,
		agentName: "a",
		capability: "builder",
		taskId: "t",
		runId: "r1",
		// Not under .agentplate/worktrees, so the removable-worktree guard skips git.
		worktreePath: "/tmp/not-managed/a",
		branchName: "agentplate/a",
		state: "idle",
		parentAgent: null,
		depth: 1,
		pid: null,
		runtimeSessionId: null,
		startedAt: minsAgo(60),
		lastActivity: minsAgo(60),
		...overrides,
	};
}

describe("selectIdleSessions", () => {
	test("reaps an active session idle past the window", () => {
		const out = selectIdleSessions([mk({ agentName: "old", lastActivity: minsAgo(11) })], {
			idleMs: IDLE_MS,
			now: NOW,
		});
		expect(out.map((s) => s.agentName)).toEqual(["old"]);
	});

	test("keeps a session active within the window", () => {
		const out = selectIdleSessions([mk({ agentName: "fresh", lastActivity: minsAgo(5) })], {
			idleMs: IDLE_MS,
			now: NOW,
		});
		expect(out).toEqual([]);
	});

	test("reaps exactly at the boundary", () => {
		const out = selectIdleSessions([mk({ agentName: "edge", lastActivity: minsAgo(10) })], {
			idleMs: IDLE_MS,
			now: NOW,
		});
		expect(out.map((s) => s.agentName)).toEqual(["edge"]);
	});

	test("reaps a stalled booting session and a working one whose turn pid is dead", () => {
		const sessions = [
			mk({ agentName: "hung", state: "working", pid: 4242, lastActivity: minsAgo(20) }),
			mk({ agentName: "boot", state: "booting", lastActivity: minsAgo(20) }),
		];
		expect(
			selectIdleSessions(sessions, { idleMs: IDLE_MS, now: NOW, isPidAlive: () => false })
				.map((s) => s.agentName)
				.sort(),
		).toEqual(["boot", "hung"]);
	});

	test("never reaps a quiet turn whose pid is still alive (a long tool call streams nothing)", () => {
		// process.pid is a real, live pid — exercise the default signal-0 probe.
		const sessions = [
			mk({ agentName: "busy", state: "working", pid: process.pid, lastActivity: minsAgo(60) }),
			mk({ agentName: "idle-live", state: "idle", pid: process.pid, lastActivity: minsAgo(60) }),
		];
		expect(selectIdleSessions(sessions, { idleMs: IDLE_MS, now: NOW })).toEqual([]);
	});

	test("never reaps a working session with no recorded pid (can't prove the turn is dead)", () => {
		const s = mk({ agentName: "w", state: "working", pid: null, lastActivity: minsAgo(60) });
		expect(selectIdleSessions([s], { idleMs: IDLE_MS, now: NOW })).toEqual([]);
	});

	test("never reaps a parent that is waiting on an active child", () => {
		const lead = mk({ agentName: "lead", capability: "lead", lastActivity: minsAgo(60) });
		const builder = mk({
			agentName: "b1",
			parentAgent: "lead",
			state: "idle",
			lastActivity: minsAgo(5),
		});
		const out = selectIdleSessions([lead, builder], { idleMs: IDLE_MS, now: NOW });
		expect(out).toEqual([]);
	});

	test("a child that just finished keeps its parent fresh; long-finished children don't", () => {
		const lead = mk({ agentName: "lead", capability: "lead", lastActivity: minsAgo(60) });
		const justDone = mk({
			agentName: "b1",
			parentAgent: "lead",
			state: "completed",
			lastActivity: minsAgo(1),
		});
		expect(selectIdleSessions([lead, justDone], { idleMs: IDLE_MS, now: NOW })).toEqual([]);

		const longDone = { ...justDone, lastActivity: minsAgo(30) };
		expect(
			selectIdleSessions([lead, longDone], { idleMs: IDLE_MS, now: NOW }).map((s) => s.agentName),
		).toEqual(["lead"]);
	});

	test("children are matched within the parent's run only", () => {
		const lead = mk({ agentName: "lead", capability: "lead", lastActivity: minsAgo(60) });
		const otherRun = mk({
			agentName: "b1",
			parentAgent: "lead",
			runId: "r2",
			state: "working",
			pid: process.pid,
			lastActivity: minsAgo(1),
		});
		expect(
			selectIdleSessions([lead, otherRun], { idleMs: IDLE_MS, now: NOW }).map((s) => s.agentName),
		).toEqual(["lead"]);
	});

	test("skips terminal states", () => {
		const sessions = [
			mk({ agentName: "done", state: "completed", lastActivity: minsAgo(60) }),
			mk({ agentName: "failed", state: "failed", lastActivity: minsAgo(60) }),
			mk({ agentName: "stopped", state: "stopped", lastActivity: minsAgo(60) }),
		];
		expect(selectIdleSessions(sessions, { idleMs: IDLE_MS, now: NOW })).toEqual([]);
	});

	test("excludes the coordinator by default", () => {
		const coord = mk({
			agentName: "coordinator",
			capability: "coordinator",
			state: "working",
			lastActivity: minsAgo(60),
		});
		expect(selectIdleSessions([coord], { idleMs: IDLE_MS, now: NOW })).toEqual([]);
	});

	test("honors a custom exclude list", () => {
		const lead = mk({ agentName: "l", capability: "lead", lastActivity: minsAgo(60) });
		expect(
			selectIdleSessions([lead], { idleMs: IDLE_MS, now: NOW, excludeCapabilities: ["lead"] }),
		).toEqual([]);
	});

	test("skips sessions with an unparseable lastActivity", () => {
		const bad = mk({ agentName: "bad", lastActivity: "not-a-date" });
		expect(selectIdleSessions([bad], { idleMs: IDLE_MS, now: NOW })).toEqual([]);
	});
});

describe("reapIdleSessions", () => {
	let root: string;
	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "ap-reap-"));
	});
	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	test("marks idle sessions stopped, leaves fresh ones, and reports what it reaped", async () => {
		const store = createSessionStore(sessionsDbPath(root));
		try {
			const run = store.createRun("r");
			store.upsertSession(
				mk({ id: "s-old", agentName: "old", runId: run.id, lastActivity: minsAgo(30) }),
			);
			store.upsertSession(
				mk({ id: "s-fresh", agentName: "fresh", runId: run.id, lastActivity: minsAgo(2) }),
			);

			const reaped = await reapIdleSessions(store, root, { idleMs: IDLE_MS, now: NOW });

			expect(reaped.map((r) => r.agentName)).toEqual(["old"]);
			expect(reaped[0]?.idleMs).toBe(30 * 60_000);
			// `old` is now stopped; `fresh` keeps running.
			expect(store.getSessionByAgent("old")?.state).toBe("stopped");
			expect(store.getSessionByAgent("fresh")?.state).toBe("idle");
		} finally {
			store.close();
		}
	});

	test("never touches the coordinator even when long-idle", async () => {
		const store = createSessionStore(sessionsDbPath(root));
		try {
			const run = store.createRun("r");
			store.upsertSession(
				mk({
					id: "s-coord",
					agentName: "coordinator",
					capability: "coordinator",
					state: "working",
					worktreePath: root, // coordinator runs at the project root
					runId: run.id,
					lastActivity: minsAgo(120),
				}),
			);
			const reaped = await reapIdleSessions(store, root, { idleMs: IDLE_MS, now: NOW });
			expect(reaped).toEqual([]);
			expect(store.getSessionByAgent("coordinator")?.state).toBe("working");
		} finally {
			store.close();
		}
	});

	test("purge:true erases the reaped agent's data; default reap keeps it", async () => {
		// Seed the auxiliary stores at their canonical paths, then close them so the
		// reaper opens its own handles (matching production). The `.agentplate` dir
		// must exist first — only the session store mkdirs it, and these open earlier.
		mkdirSync(join(root, ".agentplate"), { recursive: true });
		const events = createEventStore(eventsDbPath(root));
		const merge = createMergeQueue(mergeDbPath(root));
		const mail = createMailStore(mailDbPath(root));
		// Same runId as the session (mk defaults to "r1") so the run-scoped purge matches.
		events.record({ agentName: "old", runId: "r1", type: "tool-start" });
		mail.send({ from: "old", to: "lead", subject: "s", body: "b", type: "status" });
		merge.enqueue({
			branchName: "agentplate/old",
			agentName: "old",
			taskId: "t",
			targetBranch: "main",
		});
		events.close();
		merge.close();
		mail.close();
		mkdirSync(agentStateDir(root, "old"), { recursive: true });
		writeFileSync(join(agentStateDir(root, "old"), "identity.yaml"), "sessions: 1\n");

		const store = createSessionStore(sessionsDbPath(root));
		try {
			store.upsertSession(
				mk({ id: "s-old", agentName: "old", taskId: "t", lastActivity: minsAgo(30) }),
			);

			const reaped = await reapIdleSessions(store, root, {
				idleMs: IDLE_MS,
				now: NOW,
				purge: true,
			});

			// The report carries the purge counts...
			expect(reaped[0]?.purged).toEqual({
				mailDeleted: 1,
				eventsDeleted: 1,
				mergeDeleted: 1,
				stateDirRemoved: true,
				specRemoved: false, // no spec file was created
				sessionDeleted: true,
			});
			// ...and the session row is gone, not merely stopped.
			expect(store.getSession("s-old")).toBeNull();
			expect(existsSync(agentStateDir(root, "old"))).toBe(false);

			// Verify the aux stores were actually cleared (reopen fresh handles).
			const ev = createEventStore(eventsDbPath(root));
			const mq = createMergeQueue(mergeDbPath(root));
			const ml = createMailStore(mailDbPath(root));
			try {
				expect(ev.list({ agentName: "old" })).toEqual([]);
				expect(mq.listPending()).toEqual([]);
				expect(ml.list({ from: "old" })).toEqual([]);
			} finally {
				ev.close();
				mq.close();
				ml.close();
			}
		} finally {
			store.close();
		}
	});

	test("default reap (no purge) keeps the session row and reports purged: null", async () => {
		const store = createSessionStore(sessionsDbPath(root));
		try {
			store.upsertSession(mk({ id: "s-old", agentName: "old", lastActivity: minsAgo(30) }));
			const reaped = await reapIdleSessions(store, root, { idleMs: IDLE_MS, now: NOW });
			expect(reaped[0]?.purged).toBeNull();
			// Row kept for history, just marked stopped.
			expect(store.getSession("s-old")?.state).toBe("stopped");
		} finally {
			store.close();
		}
	});
});

describe("isRemovableWorktree", () => {
	const root = "/proj";
	const managed = worktreesDir(root);

	test("accepts only paths strictly inside .agentplate/worktrees/", () => {
		expect(isRemovableWorktree(root, join(managed, "builder-1"))).toBe(true);
	});

	test("refuses the project root, the worktrees dir itself, and empty paths", () => {
		expect(isRemovableWorktree(root, root)).toBe(false);
		expect(isRemovableWorktree(root, `${root}/`)).toBe(false);
		expect(isRemovableWorktree(root, managed)).toBe(false);
		expect(isRemovableWorktree(root, "")).toBe(false);
	});

	test("refuses look-alike prefixes and `..` escapes", () => {
		expect(isRemovableWorktree(root, `${managed}-evil/x`)).toBe(false);
		expect(isRemovableWorktree(root, `${managed}/../../`)).toBe(false);
		expect(isRemovableWorktree(root, `${managed}/../../../etc`)).toBe(false);
		expect(isRemovableWorktree(root, "/elsewhere/.agentplate/worktrees/x")).toBe(false);
	});
});

describe("isPidAlive", () => {
	test("true for a live pid, false once the process has exited", async () => {
		expect(isPidAlive(process.pid)).toBe(true);
		const proc = Bun.spawn(["true"]);
		await proc.exited;
		expect(isPidAlive(proc.pid)).toBe(false);
	});
});

describe("reapIdleSessions — real git worktrees", () => {
	let root: string;
	beforeEach(async () => {
		root = realpathSync(mkdtempSync(join(tmpdir(), "ap-reap-git-")));
		await initRepo(root);
	});
	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	/** A real agent worktree + branch, optionally with one unmerged commit on it. */
	async function agentWorktree(name: string, commit: boolean): Promise<string> {
		const wt = await createWorktree(root, name, `agentplate/${name}`);
		if (commit) {
			writeFileSync(join(wt.path, `${name}.txt`), "work\n");
			await gitOk(wt.path, ["add", "."]);
			await gitOk(wt.path, ["commit", "-q", "-m", `${name} work`]);
		}
		return wt.path;
	}

	test("removes an idle worker's worktree but keeps a branch with unmerged commits", async () => {
		const wt = await agentWorktree("b1", true);
		const store = createSessionStore(sessionsDbPath(root));
		try {
			store.upsertSession(
				mk({
					id: "s-b1",
					agentName: "b1",
					worktreePath: wt,
					branchName: "agentplate/b1",
					lastActivity: minsAgo(30),
				}),
			);
			const reaped = await reapIdleSessions(store, root, { idleMs: IDLE_MS, now: NOW });
			expect(reaped.map((r) => r.agentName)).toEqual(["b1"]);
			expect(reaped[0]?.worktreeRemoved).toBe(true);
			expect(existsSync(wt)).toBe(false);
			// The committed-but-unlanded work survives on its branch (no `branch -D`).
			expect(await branchExists(root, "agentplate/b1")).toBe(true);
			expect(await gitOk(root, ["log", "-1", "--format=%s", "agentplate/b1"])).toBe("b1 work");
		} finally {
			store.close();
		}
	});

	test("still deletes a fully merged branch", async () => {
		const wt = await agentWorktree("b2", false); // branch tip == main → merged
		const store = createSessionStore(sessionsDbPath(root));
		try {
			store.upsertSession(
				mk({
					id: "s-b2",
					agentName: "b2",
					worktreePath: wt,
					branchName: "agentplate/b2",
					lastActivity: minsAgo(30),
				}),
			);
			await reapIdleSessions(store, root, { idleMs: IDLE_MS, now: NOW });
			expect(existsSync(wt)).toBe(false);
			expect(await branchExists(root, "agentplate/b2")).toBe(false);
		} finally {
			store.close();
		}
	});

	test("leaves a lead waiting on builders, and a quiet live turn, completely intact", async () => {
		const leadWt = await agentWorktree("lead", true);
		const busyWt = await agentWorktree("busy", true);
		const turn = Bun.spawn(["sleep", "30"]); // stands in for a live, quiet runtime turn
		const store = createSessionStore(sessionsDbPath(root));
		try {
			store.upsertSession(
				mk({
					id: "s-lead",
					agentName: "lead",
					capability: "lead",
					worktreePath: leadWt,
					branchName: "agentplate/lead",
					lastActivity: minsAgo(30),
				}),
			);
			store.upsertSession(
				mk({
					id: "s-busy",
					agentName: "busy",
					parentAgent: "lead",
					state: "working",
					pid: turn.pid,
					worktreePath: busyWt,
					branchName: "agentplate/busy",
					lastActivity: minsAgo(30),
				}),
			);

			const reaped = await reapIdleSessions(store, root, { idleMs: IDLE_MS, now: NOW });

			expect(reaped).toEqual([]);
			expect(store.getSession("s-lead")?.state).toBe("idle");
			expect(store.getSession("s-busy")?.state).toBe("working");
			expect(existsSync(leadWt)).toBe(true);
			expect(existsSync(busyWt)).toBe(true);
			expect(await branchExists(root, "agentplate/lead")).toBe(true);
			expect(await branchExists(root, "agentplate/busy")).toBe(true);
			expect(isPidAlive(turn.pid)).toBe(true); // the reaper never signals a live turn
		} finally {
			turn.kill();
			await turn.exited;
			store.close();
		}
	});

	test("never removes the project root, even when a session points at it", async () => {
		writeFileSync(join(root, "uncommitted.txt"), "precious\n");
		const store = createSessionStore(sessionsDbPath(root));
		try {
			store.upsertSession(
				mk({
					id: "s-deploy",
					agentName: "deployer",
					capability: "deployer",
					worktreePath: root,
					branchName: "main",
					lastActivity: minsAgo(30),
				}),
			);
			const reaped = await reapIdleSessions(store, root, { idleMs: IDLE_MS, now: NOW });
			expect(reaped[0]?.worktreeRemoved).toBe(false);
			expect(existsSync(join(root, "uncommitted.txt"))).toBe(true);
			expect(await branchExists(root, "main")).toBe(true);
		} finally {
			store.close();
		}
	});
});
