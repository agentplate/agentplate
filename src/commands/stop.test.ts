/**
 * `agentplate stop` command tests. Real temp git repos (the project is itself a
 * LINKED worktree — the setup where `git worktree remove --force <root>` would
 * succeed and delete the whole project) and a real session store.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	AGENTPLATE_DIR,
	CONFIG_FILE,
	DEFAULT_CONFIG,
	serializeConfig,
	setProjectRootOverride,
} from "../config.ts";
import { sessionsDbPath } from "../paths.ts";
import { createSessionStore } from "../sessions/store.ts";
import type { AgentSession } from "../types.ts";
import { createWorktree } from "../worktree/manager.ts";
import { createStopCommand } from "./stop.ts";

let base: string;
/** The main checkout; the project lives in a linked worktree of it. */
let mainRepo: string;
/** The agentplate project root — a linked git worktree on branch `proj`. */
let root: string;

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

async function branchExists(branch: string): Promise<boolean> {
	return (await git(root, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`])).code === 0;
}

function seed(over: Partial<AgentSession>): void {
	const store = createSessionStore(sessionsDbPath(root));
	const now = new Date().toISOString();
	try {
		store.upsertSession({
			id: `session-${crypto.randomUUID()}`,
			agentName: "builder-1",
			capability: "builder",
			taskId: "task-1",
			runId: "run-1",
			worktreePath: join(root, AGENTPLATE_DIR, "worktrees", "builder-1"),
			branchName: "agentplate/builder-1",
			state: "idle",
			parentAgent: null,
			depth: 1,
			pid: null,
			runtimeSessionId: null,
			startedAt: now,
			lastActivity: now,
			...over,
		});
	} finally {
		store.close();
	}
}

function stateOf(agent: string): string | undefined {
	const store = createSessionStore(sessionsDbPath(root));
	try {
		return store.getSessionByAgent(agent)?.state;
	} finally {
		store.close();
	}
}

async function stop(...args: string[]): Promise<void> {
	await createStopCommand().parseAsync([...args, "--json"], { from: "user" });
}

beforeEach(async () => {
	base = realpathSync(mkdtempSync(join(tmpdir(), "agentplate-stop-")));
	mainRepo = join(base, "main");
	root = join(base, "proj");
	mkdirSync(mainRepo);
	await gitOk(mainRepo, ["init", "-q"]);
	await gitOk(mainRepo, ["config", "user.email", "test@agentplate.dev"]);
	await gitOk(mainRepo, ["config", "user.name", "Agentplate Test"]);
	writeFileSync(join(mainRepo, "README.md"), "# temp\n");
	await gitOk(mainRepo, ["add", "README.md"]);
	await gitOk(mainRepo, ["commit", "-q", "-m", "init"]);
	await gitOk(mainRepo, ["branch", "-M", "main"]);
	await gitOk(mainRepo, ["worktree", "add", "-q", "-b", "proj", root]);

	mkdirSync(join(root, AGENTPLATE_DIR), { recursive: true });
	writeFileSync(
		join(root, AGENTPLATE_DIR, CONFIG_FILE),
		serializeConfig(structuredClone(DEFAULT_CONFIG)),
		"utf8",
	);
	writeFileSync(join(root, "uncommitted.txt"), "precious work\n");
	setProjectRootOverride(root);
});

afterEach(() => {
	setProjectRootOverride(null);
	rmSync(base, { recursive: true, force: true });
});

describe("agentplate stop — worktree guard", () => {
	for (const flag of ["--clean-worktree", "--purge"]) {
		test(`${flag} on the coordinator never removes the project root (a linked worktree)`, async () => {
			seed({
				agentName: "coordinator",
				capability: "coordinator",
				worktreePath: root,
				branchName: "proj",
				state: "working",
			});

			await stop("coordinator", flag);

			expect(existsSync(join(root, "uncommitted.txt"))).toBe(true);
			expect(existsSync(join(root, AGENTPLATE_DIR, CONFIG_FILE))).toBe(true);
			expect(await branchExists("proj")).toBe(true);
			if (flag === "--clean-worktree") expect(stateOf("coordinator")).toBe("stopped");
		});
	}

	test("refuses a worktree outside .agentplate/worktrees/", async () => {
		const outside = join(base, "elsewhere");
		await gitOk(mainRepo, ["worktree", "add", "-q", "-b", "elsewhere", outside]);
		seed({ worktreePath: outside, branchName: "elsewhere" });

		await stop("builder-1", "--clean-worktree");

		expect(existsSync(outside)).toBe(true);
		expect(await branchExists("elsewhere")).toBe(true);
		expect(stateOf("builder-1")).toBe("stopped");
	});

	test("removes a managed worktree but keeps a branch with unmerged commits", async () => {
		const wt = await createWorktree(root, "builder-1", "agentplate/builder-1");
		writeFileSync(join(wt.path, "feature.txt"), "work\n");
		await gitOk(wt.path, ["add", "."]);
		await gitOk(wt.path, ["commit", "-q", "-m", "builder work"]);
		seed({ worktreePath: wt.path, branchName: "agentplate/builder-1" });

		await stop("builder-1", "--clean-worktree");

		expect(existsSync(wt.path)).toBe(false);
		expect(await branchExists("agentplate/builder-1")).toBe(true);
		expect(await gitOk(root, ["log", "-1", "--format=%s", "agentplate/builder-1"])).toBe(
			"builder work",
		);
	});

	test("removes a managed worktree and its fully merged branch", async () => {
		const wt = await createWorktree(root, "builder-1", "agentplate/builder-1");
		seed({ worktreePath: wt.path, branchName: "agentplate/builder-1" });

		await stop("builder-1", "--clean-worktree");

		expect(existsSync(wt.path)).toBe(false);
		expect(await branchExists("agentplate/builder-1")).toBe(false);
	});
});

describe("agentplate stop — live turn", () => {
	test("SIGTERMs the session's live turn process", async () => {
		const turn = Bun.spawn(["sleep", "30"]);
		try {
			seed({ state: "working", pid: turn.pid });
			await stop("builder-1");
			const exited = await Promise.race([turn.exited.then(() => true), Bun.sleep(5000)]);
			expect(exited).toBe(true);
			expect(turn.signalCode).toBe("SIGTERM");
			expect(stateOf("builder-1")).toBe("stopped");
		} finally {
			turn.kill();
		}
	});

	test("--clean-worktree removes the worktree only after the turn process exited", async () => {
		const wt = await createWorktree(root, "builder-1", "agentplate/builder-1");
		// A turn that takes a moment to wind down after SIGTERM and writes on its way
		// out. Removing the worktree before it exits would leave this file behind.
		const late = join(wt.path, "late.txt");
		const turn = Bun.spawn(
			[
				"sh",
				"-c",
				`trap 'sleep 0.5; echo late > "${late}"; exit 0' TERM; echo ready; while :; do sleep 0.1; done`,
			],
			{ stdout: "pipe" },
		);
		try {
			await turn.stdout.getReader().read(); // trap installed
			seed({ state: "working", pid: turn.pid, worktreePath: wt.path });

			await stop("builder-1", "--clean-worktree");

			expect(turn.exitCode).toBe(0);
			expect(existsSync(wt.path)).toBe(false);
			expect(stateOf("builder-1")).toBe("stopped");
		} finally {
			turn.kill("SIGKILL");
			await turn.exited;
		}
	});
});
