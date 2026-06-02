/**
 * Tests for auto-merge (maybeAutoMerge).
 *
 * Real git repos in temp dirs (per "never mock what you can use for real"), the
 * real merge queue + lock, and a recording mail stub so we can assert the outcome
 * notifications without a mail DB. Covers the mode gate, the capability skip, the
 * gates-pass fail-closed rule, a clean landing, and a reported conflict.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Capability, NewMail } from "../types.ts";
import { type AutoMergeParams, maybeAutoMerge } from "./auto.ts";

let repo: string;

async function git(...args: string[]): Promise<string> {
	const proc = Bun.spawn(["git", ...args], { cwd: repo, stdout: "pipe", stderr: "pipe" });
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	if (exitCode !== 0) throw new Error(`git ${args.join(" ")} failed (${exitCode}): ${stderr}`);
	return stdout;
}

/** Recording mail stub satisfying the `{ send }` surface maybeAutoMerge needs. */
function recordingMail() {
	const sent: Array<{ type: string; subject: string; to: string }> = [];
	return {
		sent,
		send: (m: NewMail) => {
			sent.push({ type: m.type, subject: m.subject, to: m.to });
		},
	};
}

/** Build params with sensible defaults; override per test. */
function params(
	over: Partial<AutoMergeParams> & { mail: ReturnType<typeof recordingMail> },
): AutoMergeParams {
	return {
		root: repo,
		branchName: "agentplate/builder-x",
		targetBranch: "main",
		capability: "builder" as Capability,
		agentName: "builder-x",
		taskId: "task-x",
		parent: "lead-1",
		mode: "on-complete",
		aiResolveEnabled: true,
		gateStatus: null,
		...over,
	};
}

beforeEach(async () => {
	repo = mkdtempSync(join(tmpdir(), "agentplate-automerge-"));
	mkdirSync(join(repo, ".agentplate"), { recursive: true });
	await git("init", "-q");
	await git("config", "user.email", "test@agentplate.dev");
	await git("config", "user.name", "Agentplate Test");
	await git("checkout", "-q", "-b", "main");
	await Bun.write(join(repo, "base.txt"), "base\n");
	await git("add", "-A");
	await git("commit", "-q", "-m", "initial");
});

afterEach(() => {
	rmSync(repo, { recursive: true, force: true });
});

/** Create a worker branch with a new-file commit, then return to main. */
async function workerBranchWithCommit(branch: string, file: string): Promise<void> {
	await git("checkout", "-q", "-b", branch);
	await Bun.write(join(repo, file), "from worker\n");
	await git("add", "-A");
	await git("commit", "-q", "-m", `add ${file}`);
	await git("checkout", "-q", "main");
}

describe("maybeAutoMerge — gating", () => {
	test("mode 'off' never merges", async () => {
		const mail = recordingMail();
		await workerBranchWithCommit("agentplate/builder-x", "feature.txt");
		const out = await maybeAutoMerge(params({ mail, mode: "off" }));
		expect(out).toEqual({ merged: false, reason: "disabled" });
		expect(existsSync(join(repo, "feature.txt"))).toBe(false);
		expect(mail.sent).toHaveLength(0);
	});

	test("read-only capabilities are skipped", async () => {
		const mail = recordingMail();
		for (const capability of ["scout", "merger"] as Capability[]) {
			const out = await maybeAutoMerge(params({ mail, capability }));
			expect(out).toEqual({ merged: false, reason: "capability-skipped" });
		}
		expect(mail.sent).toHaveLength(0);
	});

	test("on-gates-pass holds (fail-closed) when gates did not pass", async () => {
		const mail = recordingMail();
		await workerBranchWithCommit("agentplate/builder-x", "feature.txt");
		for (const gateStatus of [null, "failure", "partial"] as const) {
			const out = await maybeAutoMerge(params({ mail, mode: "on-gates-pass", gateStatus }));
			expect(out).toEqual({ merged: false, reason: "gates-not-passed" });
		}
		expect(existsSync(join(repo, "feature.txt"))).toBe(false);
		expect(mail.sent.every((m) => m.type === "status")).toBe(true);
	});
});

describe("maybeAutoMerge — landing", () => {
	test("on-complete lands the branch and reports 'merged'", async () => {
		const mail = recordingMail();
		await workerBranchWithCommit("agentplate/builder-x", "feature.txt");
		const out = await maybeAutoMerge(params({ mail, mode: "on-complete" }));
		expect(out).toEqual({ merged: true, status: "merged", tier: "clean-merge" });
		expect(existsSync(join(repo, "feature.txt"))).toBe(true); // landed on main
		expect(mail.sent).toHaveLength(1);
		expect(mail.sent[0]).toMatchObject({ type: "merged", to: "lead-1" });
	});

	test("on-gates-pass merges on a clean gate success", async () => {
		const mail = recordingMail();
		await workerBranchWithCommit("agentplate/builder-x", "feature.txt");
		const out = await maybeAutoMerge(
			params({ mail, mode: "on-gates-pass", gateStatus: "success" }),
		);
		expect(out).toMatchObject({ merged: true, status: "merged" });
		expect(existsSync(join(repo, "feature.txt"))).toBe(true);
	});

	test("an unresolved conflict reports 'merge_failed' (never throws)", async () => {
		const mail = recordingMail();
		// Both branches edit base.txt differently -> conflict; aiResolveEnabled=false
		// makes mergeBranch abort and fail.
		await git("checkout", "-q", "-b", "agentplate/builder-x");
		await Bun.write(join(repo, "base.txt"), "worker change\n");
		await git("add", "-A");
		await git("commit", "-q", "-m", "worker edits base");
		await git("checkout", "-q", "main");
		await Bun.write(join(repo, "base.txt"), "main change\n");
		await git("add", "-A");
		await git("commit", "-q", "-m", "main edits base");

		const out = await maybeAutoMerge(
			params({ mail, mode: "on-complete", aiResolveEnabled: false }),
		);
		expect(out.merged).toBe(false);
		expect(out).toMatchObject({ reason: "merge-failed" });
		expect(mail.sent[0]).toMatchObject({ type: "merge_failed" });
	});
});
