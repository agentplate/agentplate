/**
 * Lifecycle distill-threading tests.
 *
 * Real implementations throughout: a REAL temp git repo, the REAL config loader
 * (`.agentplate/config.yaml` + the gitignored secrets file) and the REAL
 * `resolveModel`, with a FAKE runtime whose `buildPrintCommand` is a bash probe
 * that records which env vars the one-shot distill subprocess actually saw.
 * This pins the FIX-402 invariant: the distiller's model call runs with the
 * ACTIVE PROVIDER's env (API key, base URL) merged over process.env — never the
 * bare inherited environment.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentRuntime, DirectSpawnOpts } from "../runtimes/types.ts";
import type { ResolvedModel, SkillsConfig } from "../types.ts";
import { runSkillFeedbackAndDistill } from "./lifecycle.ts";

/** A skills config with distillation gated on passing gates (the default posture). */
function makeSkillsConfig(): SkillsConfig {
	return {
		enabled: true,
		retrieval: { budgetChars: 4000, maxFull: 2 },
		distill: { onlyOnGatesPass: true, model: "distill-override-model" },
		prune: { quarantineBelow: 0.2, minSamples: 5, maxAgeDays: 30 },
	};
}

/** Run a git command in a repo, throwing on failure (test-only convenience). */
async function git(cwd: string, ...args: string[]): Promise<string> {
	const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
	const stdout = await new Response(proc.stdout).text();
	const exitCode = await proc.exited;
	if (exitCode !== 0) {
		const stderr = await new Response(proc.stderr).text();
		throw new Error(`git ${args.join(" ")} failed: ${stderr}`);
	}
	return stdout.trim();
}

/**
 * Create a real git repo with an initial commit plus one change commit (so
 * baseRef..HEAD is non-empty), and write an `.agentplate/` config naming a
 * keyed gateway provider whose secret lives in the gitignored secrets file.
 * Returns the base ref to diff against.
 */
async function setupProject(dir: string): Promise<string> {
	await git(dir, "init", "-q");
	await git(dir, "config", "user.email", "test@agentplate.dev");
	await git(dir, "config", "user.name", "Agentplate Test");
	writeFileSync(join(dir, "README.md"), "# base\n");
	await git(dir, "add", ".");
	await git(dir, "commit", "-q", "-m", "initial");
	const baseRef = await git(dir, "rev-parse", "HEAD");

	writeFileSync(join(dir, "src.ts"), "export const answer = 42;\n");
	await git(dir, "add", ".");
	await git(dir, "commit", "-q", "-m", "work");

	const agentplateDir = join(dir, ".agentplate");
	mkdirSync(agentplateDir, { recursive: true });
	writeFileSync(
		join(agentplateDir, "config.yaml"),
		[
			"activeProvider: test-local",
			"providers:",
			"  test-local:",
			"    type: gateway",
			"    authMode: api-key",
			"    baseUrl: http://localhost:9999/v1",
			"    authTokenEnv: AGENTPLATE_TEST_DISTILL_KEY",
			"    model: local-distill-model",
			"",
		].join("\n"),
	);
	writeFileSync(
		join(agentplateDir, "secrets.local.yaml"),
		"AGENTPLATE_TEST_DISTILL_KEY: key-from-secrets-file\n",
	);
	return baseRef;
}

describe("runSkillFeedbackAndDistill", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "agentplate-lifecycle-"));
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	test("threads the resolved provider env + baseUrl into the distill spawn", async () => {
		const baseRef = await setupProject(dir);

		// The probe writes the provider key and the runtime's baseUrl mapping to a
		// file from INSIDE the spawned subprocess, then emits a skip draft. Each
		// field is only non-empty if buildEnv(resolvedModel) actually reached the
		// child env — i.e. if lifecycle resolved the model and distiller merged it.
		const probeFile = join(dir, "env-probe.txt");
		let printModel: string | undefined;
		const runtime: AgentRuntime = {
			id: "fake-env",
			stability: "experimental",
			instructionPath: "CLAUDE.md",
			buildDirectSpawn(_opts: DirectSpawnOpts): string[] {
				return ["true"];
			},
			buildEnv(model: ResolvedModel): Record<string, string> {
				// Mirror real adapters: pass provider env through and map baseUrl to
				// a CLI env var — proves the WHOLE resolved object arrived here.
				const env: Record<string, string> = { ...(model.env ?? {}) };
				if (model.baseUrl !== undefined) env.FAKE_BASE_URL = model.baseUrl;
				return env;
			},
			buildPrintCommand(_prompt: string, model?: string): string[] {
				printModel = model;
				return [
					"bash",
					"-lc",
					`printf '%s|%s' "\${AGENTPLATE_TEST_DISTILL_KEY-}" "\${FAKE_BASE_URL-}" > '${probeFile}'; echo '{"action":"skip"}'`,
				];
			},
		};

		const result = await runSkillFeedbackAndDistill({
			root: dir,
			agentName: "builder-x",
			capability: "builder",
			taskId: "task-1",
			worktreePath: dir,
			baseRef,
			runtime,
			outcomeStatus: "success",
			skills: makeSkillsConfig(),
			model: "agent-session-model",
		});

		// The distill call ran (and skipped, per the scripted draft) …
		expect(result.distill.action).toBe("skipped");
		// … with the secret resolved from the secrets file and the provider's
		// baseUrl, both visible inside the subprocess.
		expect(readFileSync(probeFile, "utf8")).toBe("key-from-secrets-file|http://localhost:9999/v1");
		// The distiller's own model selection is preserved (distill override wins).
		expect(printModel).toBe("distill-override-model");
	});

	test("does not spawn the distill call when gates failed", async () => {
		const baseRef = await setupProject(dir);
		const probeFile = join(dir, "env-probe.txt");
		const runtime: AgentRuntime = {
			id: "fake-env",
			stability: "experimental",
			instructionPath: "CLAUDE.md",
			buildDirectSpawn(_opts: DirectSpawnOpts): string[] {
				return ["true"];
			},
			buildEnv(model: ResolvedModel): Record<string, string> {
				return { ...(model.env ?? {}) };
			},
			buildPrintCommand(_prompt: string, _model?: string): string[] {
				return ["bash", "-lc", `touch '${probeFile}'; echo '{"action":"skip"}'`];
			},
		};

		const result = await runSkillFeedbackAndDistill({
			root: dir,
			agentName: "builder-x",
			capability: "builder",
			taskId: "task-1",
			worktreePath: dir,
			baseRef,
			runtime,
			outcomeStatus: "failure",
			skills: makeSkillsConfig(),
		});

		expect(result.distill.action).toBe("skipped");
		expect(existsSync(probeFile)).toBe(false);
	});
});
