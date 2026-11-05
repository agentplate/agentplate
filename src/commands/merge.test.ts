/**
 * `agentplate merge` command tests. Real temp git repo + real session store.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
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
import type { MergeResult } from "../types.ts";
import { createMergeCommand } from "./merge.ts";

let root: string;

async function gitOk(args: string[]): Promise<string> {
	const proc = Bun.spawn(["git", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
	const [out, err, code] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	if (code !== 0) throw new Error(`git ${args.join(" ")} failed (${code}): ${err}`);
	return out.trim();
}

function seedCompleted(agentName: string, branchName: string): void {
	const store = createSessionStore(sessionsDbPath(root));
	const now = new Date().toISOString();
	try {
		store.upsertSession({
			id: `session-${crypto.randomUUID()}`,
			agentName,
			capability: "builder",
			taskId: `task-${agentName}`,
			runId: "run-1",
			worktreePath: join(root, AGENTPLATE_DIR, "worktrees", agentName),
			branchName,
			state: "completed",
			parentAgent: null,
			depth: 1,
			pid: null,
			runtimeSessionId: null,
			startedAt: now,
			lastActivity: now,
		});
	} finally {
		store.close();
	}
}

/** Run `merge` with --json and return the unwrapped payload. */
async function runMergeJson(args: string[]): Promise<{ predictions: MergeResult[] }> {
	const original = process.stdout.write.bind(process.stdout);
	let buffer = "";
	process.stdout.write = ((chunk: unknown): boolean => {
		buffer += typeof chunk === "string" ? chunk : String(chunk);
		return true;
	}) as typeof process.stdout.write;
	try {
		const program = createMergeCommand();
		program.exitOverride();
		await program.parseAsync([...args, "--json"], { from: "user" });
	} finally {
		process.stdout.write = original;
	}
	const envelope = JSON.parse(buffer) as { ok: boolean; data: { predictions: MergeResult[] } };
	return envelope.data;
}

beforeEach(async () => {
	root = realpathSync(mkdtempSync(join(tmpdir(), "agentplate-merge-cmd-")));
	await gitOk(["init", "-q"]);
	await gitOk(["config", "user.email", "test@agentplate.dev"]);
	await gitOk(["config", "user.name", "Agentplate Test"]);
	await gitOk(["checkout", "-q", "-b", "main"]);
	writeFileSync(join(root, "README.md"), "# temp\n");
	await gitOk(["add", "README.md"]);
	await gitOk(["commit", "-q", "-m", "init"]);
	await gitOk(["branch", "agentplate/ok"]);

	mkdirSync(join(root, AGENTPLATE_DIR), { recursive: true });
	writeFileSync(
		join(root, AGENTPLATE_DIR, CONFIG_FILE),
		serializeConfig(structuredClone(DEFAULT_CONFIG)),
		"utf8",
	);
	setProjectRootOverride(root);
});

afterEach(() => {
	setProjectRootOverride(null);
	rmSync(root, { recursive: true, force: true });
});

describe("agentplate merge --all --dry-run", () => {
	test("a missing branch is reported per entry instead of aborting the run", async () => {
		seedCompleted("builder-gone", "agentplate/gone"); // branch was deleted
		seedCompleted("builder-ok", "agentplate/ok");

		const { predictions } = await runMergeJson(["--all", "--dry-run"]);

		const byBranch = new Map(predictions.map((p) => [p.branchName, p]));
		expect(predictions).toHaveLength(2);
		expect(byBranch.get("agentplate/gone")?.status).toBe("failed");
		expect(byBranch.get("agentplate/gone")?.message).toContain("not a local branch");
		expect(byBranch.get("agentplate/ok")?.status).toBe("pending");
		expect(byBranch.get("agentplate/ok")?.tier).toBe("clean-merge");
	});
});
