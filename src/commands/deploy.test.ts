/**
 * `agentplate target` / `agentplate deploy` / `agentplate rollback` command tests.
 *
 * Real implementations throughout (no mocks): every test runs against a real
 * temp git repo with an initialized `.agentplate/` tree (a real `config.yaml`), so
 * `loadConfig`/`isInitialized` work and `git rev-parse HEAD` yields a real sha
 * for the audit row. The deploy core (registry, context, secrets, audit) and the
 * real `docker-gha` target are exercised; the only thing we never invoke is
 * `docker` itself — a `--dry-run` plan generates + writes artifacts but runs no
 * subprocess, which is exactly the path under test.
 *
 * The Commander actions resolve the project root via `findProjectRoot()` (which
 * honors `setProjectRootOverride`), but the heavy assertions drive the exported
 * action helpers (`runDeploy`, `detectTargets`, `runRollback`, `configureTarget`,
 * `readAuditHistory`) directly with an explicit `root`, since `index.ts` does not
 * register these commands yet.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	AGENTPLATE_DIR,
	CONFIG_FILE,
	DEFAULT_CONFIG,
	serializeConfig,
	setProjectRootOverride,
} from "../config.ts";
import { createDeployAudit } from "../deploy/audit.ts";
import { deploysDbPath } from "../paths.ts";
import { SECRETS_FILE } from "../secrets.ts";
import type { AgentplateConfig } from "../types.ts";
import {
	buildTargetList,
	configureTarget,
	createDeployCommand,
	createRollbackCommand,
	createTargetCommand,
	detectTargets,
	readAuditHistory,
	runDeploy,
	runRollback,
} from "./deploy.ts";

// --- temp git-repo harness -------------------------------------------------

let root: string;

/** Run a git command in `cwd`, throwing on non-zero exit (test-local helper). */
async function git(cwd: string, args: string[]): Promise<void> {
	const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
	const [stderr, exitCode] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
	if (exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${stderr}`);
}

/**
 * Create a real temp git repo, initialize `.agentplate/` with a committed config,
 * and (optionally) seed a package.json so the docker-gha target detects a Node
 * app. Returns the absolute root. The repo has one commit so `git rev-parse HEAD`
 * resolves for the audit row.
 */
async function initRepo(
	opts: { pkg?: Record<string, unknown>; config?: AgentplateConfig } = {},
): Promise<string> {
	const dir = mkdtempSync(join(tmpdir(), "agentplate-deploy-cmd-"));
	await git(dir, ["init", "-q"]);
	await git(dir, ["config", "user.email", "test@agentplate.dev"]);
	await git(dir, ["config", "user.name", "Agentplate Test"]);

	mkdirSync(join(dir, AGENTPLATE_DIR), { recursive: true });
	const config = opts.config ?? DEFAULT_CONFIG;
	writeFileSync(join(dir, AGENTPLATE_DIR, CONFIG_FILE), serializeConfig(config), "utf8");

	if (opts.pkg) {
		writeFileSync(join(dir, "package.json"), `${JSON.stringify(opts.pkg, null, 2)}\n`, "utf8");
	}
	// A real commit so readCommitSha() returns a sha (not the empty fallback).
	await git(dir, ["add", "-A"]);
	await git(dir, ["commit", "-q", "-m", "init"]);
	return dir;
}

/** A package.json that detects as a built Bun service. */
function servicePkg(): Record<string, unknown> {
	return {
		name: "demo-service",
		scripts: { build: "tsc", start: "bun run server.ts" },
		dependencies: { hono: "^4.0.0" },
	};
}

/** Clone DEFAULT_CONFIG with a chosen default target + gate policy override. */
function configWith(overrides: {
	default?: string;
	gates?: Record<string, "confirm" | "auto">;
}): AgentplateConfig {
	const cfg: AgentplateConfig = structuredClone(DEFAULT_CONFIG);
	if (overrides.default !== undefined) cfg.deploy.default = overrides.default;
	if (overrides.gates) {
		for (const [env, policy] of Object.entries(overrides.gates)) cfg.deploy.gates[env] = policy;
	}
	return cfg;
}

beforeEach(() => {
	setProjectRootOverride(null);
});

afterEach(() => {
	setProjectRootOverride(null);
	if (root) rmSync(root, { recursive: true, force: true });
});

// --- command builders ------------------------------------------------------

describe("command builders", () => {
	test("createTargetCommand builds with list/detect/configure subcommands", () => {
		const cmd = createTargetCommand();
		expect(cmd.name()).toBe("target");
		const subs = cmd.commands.map((c) => c.name()).sort();
		expect(subs).toEqual(["configure", "detect", "list"]);
	});

	test("createDeployCommand builds with status/history subcommands and gate flags", () => {
		const cmd = createDeployCommand();
		expect(cmd.name()).toBe("deploy");
		const subs = cmd.commands.map((c) => c.name()).sort();
		expect(subs).toEqual(["history", "status"]);
		const optionNames = cmd.options.map((o) => o.long);
		expect(optionNames).toContain("--target");
		expect(optionNames).toContain("--dry-run");
		expect(optionNames).toContain("--yes");
	});

	test("createRollbackCommand builds without throwing", () => {
		const cmd = createRollbackCommand();
		expect(cmd.name()).toBe("rollback");
		expect(cmd.options.map((o) => o.long)).toContain("--target");
	});
});

// --- target list -----------------------------------------------------------

describe("target list", () => {
	test("includes the registered docker-gha target with its caps", () => {
		const items = buildTargetList();
		const docker = items.find((i) => i.id === "docker-gha");
		expect(docker).toBeDefined();
		expect(docker?.label).toBe("Docker + GitHub Actions");
		expect(docker?.caps.canRollback).toBe(true);
		expect(docker?.caps.irreversible).toBe(false);
		expect(docker?.caps.environments).toContain("production");
	});
});

// --- target detect ---------------------------------------------------------

describe("target detect", () => {
	test("detects docker-gha as the chosen target for a Node service", async () => {
		root = await initRepo({ pkg: servicePkg() });
		const report = await detectTargets(root);
		expect(report.dir).toBe(root);
		expect(report.chosenTarget).toBe("docker-gha");
		expect(report.chosenProfile).not.toBeNull();
		expect(report.chosenProfile?.kind).toBe("service");
		// Every registered target appears in the ranked list.
		expect(report.detections.some((d) => d.id === "docker-gha")).toBe(true);
	});

	test("returns no chosen target for an empty directory", async () => {
		root = await initRepo();
		const report = await detectTargets(root);
		// docker-gha does not fit a bare repo (no package.json/index.html/Dockerfile).
		expect(report.chosenTarget).toBeNull();
		expect(report.chosenProfile).toBeNull();
	});
});

// --- target configure ------------------------------------------------------

describe("target configure", () => {
	test("reports docker-gha's required secret (GHCR_TOKEN) as missing by default", async () => {
		root = await initRepo({ pkg: servicePkg() });
		// Make sure the env doesn't accidentally satisfy the secret.
		const saved = process.env.GHCR_TOKEN;
		delete process.env.GHCR_TOKEN;
		try {
			const report = await configureTarget(root, "docker-gha", "production");
			expect(report.target).toBe("docker-gha");
			expect(report.requiredSecretKeys).toContain("GHCR_TOKEN");
			expect(report.missingSecretKeys).toContain("GHCR_TOKEN");
		} finally {
			if (saved !== undefined) process.env.GHCR_TOKEN = saved;
		}
	});

	test("required secret is no longer missing once present in the secrets file", async () => {
		root = await initRepo({ pkg: servicePkg() });
		const saved = process.env.GHCR_TOKEN;
		delete process.env.GHCR_TOKEN;
		writeFileSync(join(root, AGENTPLATE_DIR, SECRETS_FILE), "GHCR_TOKEN: tok-abc\n", {
			mode: 0o600,
		});
		try {
			const report = await configureTarget(root, "docker-gha", "production");
			expect(report.requiredSecretKeys).toContain("GHCR_TOKEN");
			expect(report.missingSecretKeys).not.toContain("GHCR_TOKEN");
		} finally {
			if (saved !== undefined) process.env.GHCR_TOKEN = saved;
		}
	});
});

// --- deploy --dry-run (the core scenario) ----------------------------------

describe("deploy --dry-run", () => {
	test("writes Dockerfile + workflow, plans, and records a dryRun row but NO success deploy", async () => {
		root = await initRepo({ pkg: servicePkg(), config: configWith({ default: "docker-gha" }) });

		const result = await runDeploy(root, {
			target: "docker-gha",
			environment: "production",
			dryRun: true,
			yes: false,
			agentName: "operator",
		});

		// Plan, not a deploy.
		expect(result.dryRun).toBe(true);
		expect(result.refused).toBe(false);
		expect(result.deploy).toBeNull();
		expect(result.verify).toBeNull();

		// Artifacts written to the project root.
		expect(existsSync(join(root, "Dockerfile"))).toBe(true);
		expect(existsSync(join(root, ".github", "workflows", "deploy.yml"))).toBe(true);
		expect(existsSync(join(root, ".dockerignore"))).toBe(true);
		const dockerfile = readFileSync(join(root, "Dockerfile"), "utf8");
		expect(dockerfile).toContain("FROM");
		const workflow = readFileSync(join(root, ".github", "workflows", "deploy.yml"), "utf8");
		expect(workflow).toContain("name: deploy");
		expect(workflow).toContain("GHCR_TOKEN");

		// The written-artifact list is absolute and includes the Dockerfile.
		expect(result.writtenArtifacts.some((p) => p.endsWith("/Dockerfile"))).toBe(true);

		// Required secret surfaced, not deployed.
		expect(result.requiredSecretKeys).toContain("GHCR_TOKEN");

		// Audit: exactly one row, flagged dryRun, NOT a real deploy success.
		const rows = readAuditHistory(root, {});
		expect(rows.length).toBe(1);
		expect(rows[0]?.dryRun).toBe(true);
		expect(rows[0]?.action).toBe("deploy");
		// latest() (used by rollback) must ignore dry runs entirely.
		const audit = createDeployAudit(deploysDbPath(root));
		try {
			expect(audit.latest("docker-gha", "production")).toBeNull();
		} finally {
			audit.close();
		}
	});

	test("dry-run records a real commit sha on the audit row", async () => {
		root = await initRepo({ pkg: servicePkg(), config: configWith({ default: "docker-gha" }) });
		const result = await runDeploy(root, {
			target: "docker-gha",
			environment: "preview",
			dryRun: true,
			yes: false,
			agentName: "operator",
		});
		expect(result.audit).not.toBeNull();
		// A real git repo with one commit → a 40-char sha, not the empty fallback.
		expect(result.audit?.commitSha).toMatch(/^[0-9a-f]{40}$/);
	});

	test("a confirm-gated production deploy is NOT refused under --dry-run", async () => {
		// production defaults to a "confirm" gate; dry runs are exempt.
		root = await initRepo({ pkg: servicePkg(), config: configWith({ default: "docker-gha" }) });
		const result = await runDeploy(root, {
			target: "docker-gha",
			environment: "production",
			dryRun: true,
			yes: false,
			agentName: "operator",
		});
		expect(result.refused).toBe(false);
		expect(result.dryRun).toBe(true);
	});
});

// --- deploy gate (refusal) -------------------------------------------------

describe("deploy gate", () => {
	test("refuses a confirm-gated real deploy without --yes (denied audit row, no artifacts)", async () => {
		root = await initRepo({
			pkg: servicePkg(),
			config: configWith({ default: "docker-gha", gates: { production: "confirm" } }),
		});

		const result = await runDeploy(root, {
			target: "docker-gha",
			environment: "production",
			dryRun: false,
			yes: false,
			agentName: "operator",
		});

		expect(result.refused).toBe(true);
		expect(result.gateDecision).toBe("denied");
		expect(result.refusalReason).toContain("--yes");
		// No artifacts written when the gate denies up front.
		expect(existsSync(join(root, "Dockerfile"))).toBe(false);
		// A denied row IS recorded (failed status), and it is not a deploy target.
		const rows = readAuditHistory(root, {});
		expect(rows.length).toBe(1);
		expect(rows[0]?.gateDecision).toBe("denied");
		expect(rows[0]?.status).toBe("failed");
	});

	test("an auto-gated environment is not refused (proven via a docker-free dry-run)", async () => {
		// staging defaults to "auto". We assert the gate never refuses; the dry-run
		// path proves this without ever reaching target.deploy() (no docker invoked,
		// per the test rules).
		root = await initRepo({
			pkg: servicePkg(),
			config: configWith({ default: "docker-gha", gates: { staging: "auto" } }),
		});
		const result = await runDeploy(root, {
			target: "docker-gha",
			environment: "staging",
			dryRun: true,
			yes: false,
			agentName: "operator",
		});
		expect(result.refused).toBe(false);
		expect(result.gateDecision).toBe("auto");
		expect(existsSync(join(root, "Dockerfile"))).toBe(true);
	});

	test("--yes maps a confirm-gated deploy to gateDecision 'approved' (docker-free dry-run)", async () => {
		// The gateDecision is computed before the dry-run/real split, so a dry-run
		// with --yes exercises the same approval mapping a real run would — and it
		// never calls target.deploy(), so no docker is invoked.
		root = await initRepo({
			pkg: servicePkg(),
			config: configWith({ default: "docker-gha", gates: { production: "confirm" } }),
		});
		const result = await runDeploy(root, {
			target: "docker-gha",
			environment: "production",
			dryRun: true,
			yes: true,
			agentName: "operator",
		});
		expect(result.refused).toBe(false);
		expect(result.gateDecision).toBe("approved");
		const rows = readAuditHistory(root, {});
		expect(rows[0]?.gateDecision).toBe("approved");
	});
});

// --- deploy fail-fast on missing secrets -----------------------------------

describe("deploy missing-secret fail-fast", () => {
	test("a real auto deploy throws when a required secret is absent", async () => {
		root = await initRepo({
			pkg: servicePkg(),
			config: configWith({ default: "docker-gha", gates: { staging: "auto" } }),
		});
		const saved = process.env.GHCR_TOKEN;
		delete process.env.GHCR_TOKEN;
		try {
			await expect(
				runDeploy(root, {
					target: "docker-gha",
					environment: "staging",
					dryRun: false,
					yes: false,
					agentName: "operator",
				}),
			).rejects.toThrow(/missing required secret/i);
		} finally {
			if (saved !== undefined) process.env.GHCR_TOKEN = saved;
		}
	});
});

// --- target resolution failures --------------------------------------------

describe("target resolution", () => {
	test("runDeploy throws when no target is given and config.deploy.default is unset", async () => {
		root = await initRepo({ pkg: servicePkg() }); // DEFAULT_CONFIG → deploy.default === ""
		await expect(
			runDeploy(root, {
				environment: "preview",
				dryRun: true,
				yes: false,
				agentName: "operator",
			}),
		).rejects.toThrow(/No deploy target specified/i);
	});

	test("runDeploy throws on an unknown target name", async () => {
		root = await initRepo({ pkg: servicePkg() });
		await expect(
			runDeploy(root, {
				target: "does-not-exist",
				environment: "preview",
				dryRun: true,
				yes: false,
				agentName: "operator",
			}),
		).rejects.toThrow(/Unknown deploy target/i);
	});
});

// --- rollback --------------------------------------------------------------

describe("rollback", () => {
	test("throws NotFoundError when there is no prior successful deploy", async () => {
		root = await initRepo({ pkg: servicePkg(), config: configWith({ default: "docker-gha" }) });
		await expect(
			runRollback(root, { target: "docker-gha", environment: "production", agentName: "operator" }),
		).rejects.toThrow(/No prior successful deploy/i);
	});

	test("rolls back to the latest successful deploy and records a rollback row", async () => {
		root = await initRepo({ pkg: servicePkg(), config: configWith({ default: "docker-gha" }) });
		// Seed a real successful deploy row directly through the audit store so
		// latest() has something to revert to (without invoking docker).
		const seedAudit = createDeployAudit(deploysDbPath(root));
		try {
			seedAudit.record({
				runId: null,
				agentName: "deployer-seed",
				target: "docker-gha",
				environment: "staging",
				action: "deploy",
				dryRun: false,
				gateDecision: "auto",
				approvedBy: null,
				status: "success",
				deploymentId: "ghcr.io/demo/app:abc123",
				urls: [],
				outputs: { imageRef: "ghcr.io/demo/app:abc123" },
				commitSha: "deadbeef",
			});
		} finally {
			seedAudit.close();
		}

		const result = await runRollback(root, {
			target: "docker-gha",
			environment: "staging",
			agentName: "operator",
		});

		expect(result.previous).not.toBeNull();
		expect(result.previous?.deploymentId).toBe("ghcr.io/demo/app:abc123");
		expect(result.rollback).not.toBeNull();
		expect(result.audit?.action).toBe("rollback");
		expect(result.audit?.gateDecision).toBe("n/a");

		// History now has two rows (the seeded deploy + the rollback), newest first.
		const rows = readAuditHistory(root, { target: "docker-gha", environment: "staging" });
		expect(rows.length).toBe(2);
		expect(rows[0]?.action).toBe("rollback");
		expect(rows[1]?.action).toBe("deploy");
	});
});

// --- audit history read ----------------------------------------------------

describe("deploy history / status read", () => {
	test("readAuditHistory returns rows newest-first and honors the limit", async () => {
		root = await initRepo({ pkg: servicePkg(), config: configWith({ default: "docker-gha" }) });
		// Two dry-run plans → two audit rows.
		await runDeploy(root, {
			target: "docker-gha",
			environment: "preview",
			dryRun: true,
			yes: false,
			agentName: "operator",
		});
		await runDeploy(root, {
			target: "docker-gha",
			environment: "staging",
			dryRun: true,
			yes: false,
			agentName: "operator",
		});
		const all = readAuditHistory(root, {});
		expect(all.length).toBe(2);
		const limited = readAuditHistory(root, { limit: 1 });
		expect(limited.length).toBe(1);
		// Filter by environment.
		const previewOnly = readAuditHistory(root, { environment: "preview" });
		expect(previewOnly.length).toBe(1);
		expect(previewOnly[0]?.environment).toBe("preview");
	});
});
