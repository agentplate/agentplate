/**
 * `agentplate sling` — unit tests for the spec-contract path.
 *
 * These cover the two pure pieces that fix the launch/mail race without spinning
 * up a full spawn: `readSpecContract` (the --spec guard) and `dispatchBody` (which
 * inlines the contract into the agent's first prompt). Real temp files, no mocks.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	AGENTPLATE_DIR,
	CONFIG_FILE,
	DEFAULT_CONFIG,
	serializeConfig,
	setProjectRootOverride,
} from "../config.ts";
import { CapacityError, ValidationError, WorktreeError } from "../errors.ts";
import { sessionsDbPath, worktreesDir } from "../paths.ts";
import { createSessionStore, type SessionStore } from "../sessions/store.ts";
import type { AgentplateConfig, OverlayConfig } from "../types.ts";
import { createSlingCommand, dispatchBody, readSpecContract } from "./sling.ts";

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "agentplate-sling-spec-"));
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe("readSpecContract", () => {
	test("returns empty string when no --spec is given (spec is optional)", () => {
		expect(readSpecContract(undefined, "task-1")).toBe("");
	});

	test("returns the file content when the spec exists and is non-empty", () => {
		const f = join(dir, "task-1.md");
		writeFileSync(f, "Goal: build the thing\n", "utf8");
		expect(readSpecContract(f, "task-1")).toBe("Goal: build the thing\n");
	});

	test("throws when the --spec file is missing (points at `spec write`)", () => {
		const missing = join(dir, "absent.md");
		expect(() => readSpecContract(missing, "task-1")).toThrow(ValidationError);
		try {
			readSpecContract(missing, "task-1");
		} catch (e) {
			expect((e as Error).message).toContain("agentplate spec write task-1");
		}
	});

	test("throws when the --spec file is empty/whitespace (blank contract)", () => {
		const f = join(dir, "blank.md");
		writeFileSync(f, "   \n\t\n", "utf8");
		expect(() => readSpecContract(f, "task-1")).toThrow(ValidationError);
	});
});

const baseCfg: OverlayConfig = {
	agentName: "lead-task-1",
	capability: "lead",
	taskId: "task-1",
	specPath: ".agentplate/specs/task-1.md",
	branchName: "agentplate/lead-task-1",
	worktreePath: "/tmp/wt",
	parentAgent: "coordinator",
	depth: 1,
	fileScope: [],
	baseDefinition: "",
	canSpawn: true,
	qualityGates: [],
	constraints: [],
};

describe("dispatchBody", () => {
	test("inlines the spec contract into the dispatch when present", () => {
		const body = dispatchBody("task-1", "lead", baseCfg, "Goal: build the thing");
		expect(body).toContain("=== SPEC");
		expect(body).toContain("Goal: build the thing");
		expect(body).toContain("Task: task-1");
	});

	test("omits the SPEC block when there is no spec body", () => {
		const body = dispatchBody("task-1", "lead", baseCfg, "");
		expect(body).not.toContain("=== SPEC");
		expect(body).toContain("Task: task-1");
	});
});

describe("sling task-id validation", () => {
	let root: string;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "agentplate-sling-id-"));
		mkdirSync(join(root, AGENTPLATE_DIR), { recursive: true });
		writeFileSync(join(root, AGENTPLATE_DIR, CONFIG_FILE), serializeConfig(DEFAULT_CONFIG), "utf8");
		setProjectRootOverride(root);
	});

	afterEach(() => {
		setProjectRootOverride(null);
		rmSync(root, { recursive: true, force: true });
	});

	test("rejects a path-traversal / flag-like task id before touching any state", async () => {
		for (const taskId of ["../../README", "a/b", "a..b", "-rf"]) {
			const cmd = createSlingCommand();
			await expect(cmd.parseAsync(["--", taskId], { from: "user" })).rejects.toThrow(
				ValidationError,
			);
		}
		// Validation ran before the session store / worktree were created.
		expect(existsSync(sessionsDbPath(root))).toBe(false);
		expect(existsSync(worktreesDir(root))).toBe(false);
	});
});

describe("sling spawn path (real git repo + mock runtime)", () => {
	const GIT_ID = ["-c", "user.email=t@example.com", "-c", "user.name=t"];
	let root: string;
	let mainSha: string;

	function git(args: string[]): string {
		const proc = Bun.spawnSync(["git", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
		if (proc.exitCode !== 0) {
			throw new Error(`git ${args.join(" ")} failed: ${proc.stderr.toString()}`);
		}
		return proc.stdout.toString().trim();
	}

	function writeProjectConfig(edit: (c: AgentplateConfig) => void = () => {}): void {
		const config = structuredClone(DEFAULT_CONFIG);
		config.runtime.default = "mock";
		config.skills.enabled = false;
		edit(config);
		writeFileSync(join(root, AGENTPLATE_DIR, CONFIG_FILE), serializeConfig(config), "utf8");
	}

	function withStore<T>(fn: (store: SessionStore) => T): T {
		const store = createSessionStore(sessionsDbPath(root));
		try {
			return fn(store);
		} finally {
			store.close();
		}
	}

	/** Run `sling --json` with its stdout swallowed. */
	function sling(args: string[]): Promise<unknown> {
		return createSlingCommand().parseAsync([...args, "--json"], { from: "user" });
	}

	/** Run `fn` with process stdout muted (sling prints its JSON result). */
	async function quiet<T>(fn: () => Promise<T>): Promise<T> {
		const original = process.stdout.write.bind(process.stdout);
		process.stdout.write = (): boolean => true;
		try {
			return await fn();
		} finally {
			process.stdout.write = original;
		}
	}

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "agentplate-sling-e2e-"));
		git(["init", "-q", "-b", "main"]);
		writeFileSync(join(root, "README.md"), "hello\n", "utf8");
		writeFileSync(join(root, ".gitignore"), ".agentplate/\n", "utf8");
		git(["add", "-A"]);
		git([...GIT_ID, "commit", "-qm", "init"]);
		mainSha = git(["rev-parse", "HEAD"]);
		mkdirSync(join(root, AGENTPLATE_DIR), { recursive: true });
		writeProjectConfig();
		setProjectRootOverride(root);
		process.env.AGENTPLATE_MOCK_CMD = "true"; // no-op turn → agent ends idle (still active)
	});

	afterEach(() => {
		setProjectRootOverride(null);
		process.env.AGENTPLATE_MOCK_CMD = undefined;
		rmSync(root, { recursive: true, force: true });
	});

	test("concurrent slings cannot overshoot agents.maxConcurrent", async () => {
		writeProjectConfig((c) => {
			c.agents.maxConcurrent = 2;
		});
		const runId = withStore((s) => s.createRun().id);

		const results = await quiet(() =>
			Promise.allSettled(["t1", "t2", "t3", "t4"].map((t) => sling([t, "--run", runId]))),
		);

		const refused = results.filter((r) => r.status === "rejected");
		expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(2);
		expect(refused).toHaveLength(2);
		for (const r of refused) expect(r.reason).toBeInstanceOf(CapacityError);
		expect(withStore((s) => s.countActive(runId))).toBe(2);
		expect(readdirSync(worktreesDir(root))).toHaveLength(2); // refused ones made no worktree
	});

	test("concurrent slings under one parent cannot overshoot agents.maxAgentsPerLead", async () => {
		writeProjectConfig((c) => {
			c.agents.maxAgentsPerLead = 1;
		});
		const runId = withStore((s) => s.createRun().id);

		const results = await quiet(() =>
			Promise.allSettled(
				["t1", "t2", "t3"].map((t) =>
					sling([t, "--run", runId, "--parent", "lead-1", "--depth", "1"]),
				),
			),
		);

		expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
		expect(withStore((s) => s.countActiveByParent("lead-1", runId))).toBe(1);
	});

	test("concurrent slings of the same task get distinct agent names", async () => {
		const runId = withStore((s) => s.createRun().id);

		const results = await quiet(() =>
			Promise.allSettled([sling(["t1", "--run", runId]), sling(["t1", "--run", runId])]),
		);

		expect(results.map((r) => r.status)).toEqual(["fulfilled", "fulfilled"]);
		const names = withStore((s) => s.listSessions({ runId }).map((x) => x.agentName));
		expect(names.sort()).toEqual(["builder-t1", "builder-t1-2"]);
	});

	test("a failed worktree add releases the reserved slot (no stranded session row)", async () => {
		writeProjectConfig((c) => {
			c.agents.maxConcurrent = 1;
		});

		await expect(quiet(() => sling(["t1", "--base-branch", "no-such-branch"]))).rejects.toThrow(
			WorktreeError,
		);
		expect(withStore((s) => s.listSessions())).toEqual([]);

		// The slot is free again, so a good spawn still fits under maxConcurrent = 1.
		await quiet(() => sling(["t2"]));
		expect(withStore((s) => s.listSessions().map((x) => x.agentName))).toEqual(["builder-t2"]);
	});

	test("worker branches come off the canonical branch, not the root checkout's HEAD", async () => {
		// The operator is on a feature branch with an unmerged commit.
		git(["checkout", "-q", "-b", "feature/wip"]);
		writeFileSync(join(root, "wip.txt"), "experimental\n", "utf8");
		git(["add", "wip.txt"]);
		git([...GIT_ID, "commit", "-qm", "wip"]);
		const featureSha = git(["rev-parse", "HEAD"]);

		await quiet(() => sling(["t1"]));
		expect(git(["rev-parse", "agentplate/builder-t1"])).toBe(mainSha);

		// An explicit --base-branch still wins.
		await quiet(() => sling(["t2", "--base-branch", "feature/wip"]));
		expect(git(["rev-parse", "agentplate/builder-t2"])).toBe(featureSha);
	});

	test("rejects a flag-like base branch before reserving anything", async () => {
		await expect(quiet(() => sling(["t1", "--base-branch=--orphan"]))).rejects.toThrow(
			ValidationError,
		);
		expect(withStore((s) => s.listSessions())).toEqual([]);
	});
});
