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
	gatePolicyFor,
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

/**
 * Run `fn` with a stand-in `docker` first on PATH (a shell script that records
 * its argv and exits 0) and a dummy GHCR_TOKEN, so the real deploy/rollback
 * paths run end to end without ever invoking the real docker binary. Returns
 * whatever `fn` returns; `calls()` lists each recorded docker invocation.
 */
async function withFakeDocker<T>(fn: (calls: () => string[]) => Promise<T>): Promise<T> {
	const bin = mkdtempSync(join(tmpdir(), "agentplate-fake-docker-"));
	const log = join(bin, "calls.log");
	writeFileSync(log, "", "utf8");
	writeFileSync(join(bin, "docker"), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\nexit 0\n`, {
		mode: 0o755,
	});
	const savedPath = process.env.PATH;
	const savedToken = process.env.GHCR_TOKEN;
	process.env.PATH = `${bin}:${savedPath ?? ""}`;
	process.env.GHCR_TOKEN = "fake-token-for-tests";
	try {
		return await fn(() =>
			readFileSync(log, "utf8")
				.split("\n")
				.filter((line) => line !== ""),
		);
	} finally {
		process.env.PATH = savedPath;
		if (savedToken === undefined) delete process.env.GHCR_TOKEN;
		else process.env.GHCR_TOKEN = savedToken;
		rmSync(bin, { recursive: true, force: true });
	}
}

/** Seed one audit row directly (no docker), defaulting to a successful staging deploy. */
function seedRow(
	dir: string,
	overrides: Partial<Parameters<ReturnType<typeof createDeployAudit>["record"]>[0]>,
): void {
	const audit = createDeployAudit(deploysDbPath(dir));
	try {
		audit.record({
			runId: null,
			agentName: "deployer-seed",
			target: "docker-gha",
			environment: "staging",
			action: "deploy",
			dryRun: false,
			gateDecision: "auto",
			approvedBy: null,
			status: "success",
			deploymentId: null,
			urls: [],
			outputs: {},
			commitSha: "deadbeef",
			...overrides,
		});
	} finally {
		audit.close();
	}
}

/** Seed a successful release whose immutable image ref is `ref`. */
function seedRelease(dir: string, ref: string, environment = "staging"): void {
	seedRow(dir, { environment, deploymentId: ref, outputs: { imageRef: ref } });
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
	test("plans Dockerfile + workflow without writing them, and records a dryRun row but NO success deploy", async () => {
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

		// A dry run writes NOTHING to the project root.
		expect(existsSync(join(root, "Dockerfile"))).toBe(false);
		expect(existsSync(join(root, ".github", "workflows", "deploy.yml"))).toBe(false);
		expect(existsSync(join(root, ".dockerignore"))).toBe(false);
		expect(result.writtenArtifacts).toEqual([]);

		// ...but the plan carries each artifact (absolute path + content) for diffing.
		expect(result.artifacts.map((a) => a.path).sort()).toEqual([
			".dockerignore",
			".github/workflows/deploy.yml",
			"Dockerfile",
		]);
		for (const plan of result.artifacts) {
			expect(plan.action).toBe("create");
			expect(plan.written).toBe(false);
			expect(plan.absolutePath.startsWith(root)).toBe(true);
		}
		const dockerfile = result.artifacts.find((a) => a.path === "Dockerfile");
		expect(dockerfile?.content).toContain("FROM");
		const workflow = result.artifacts.find((a) => a.path === ".github/workflows/deploy.yml");
		expect(workflow?.content).toContain("name: deploy");
		// CI pushes with the job's own GITHUB_TOKEN, not the local GHCR_TOKEN.
		expect(workflow?.content).toContain("secrets.GITHUB_TOKEN");
		expect(workflow?.content).not.toContain("GHCR_TOKEN");

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
		// Planned, never written (dry run).
		expect(result.artifacts.some((a) => a.path === "Dockerfile")).toBe(true);
		expect(existsSync(join(root, "Dockerfile"))).toBe(false);
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

describe("deploy gate fails closed", () => {
	test("an environment the target does not declare is rejected before anything runs", async () => {
		root = await initRepo({ pkg: servicePkg(), config: configWith({ default: "docker-gha" }) });
		// `prod` has no gates entry: it must not be auto-approved.
		for (const environment of ["prod", "Production", "production'\n  injected: true"]) {
			await expect(
				runDeploy(root, {
					target: "docker-gha",
					environment,
					dryRun: false,
					yes: false,
					agentName: "operator",
				}),
			).rejects.toThrow(/Unknown environment/i);
		}
		// No audit row, no artifacts.
		expect(readAuditHistory(root, {})).toEqual([]);
		expect(existsSync(join(root, "Dockerfile"))).toBe(false);
		await expect(configureTarget(root, "docker-gha", "prod")).rejects.toThrow(
			/Unknown environment/i,
		);
	});

	test("production requires --yes even when its gate is configured 'auto'", async () => {
		root = await initRepo({
			pkg: servicePkg(),
			config: configWith({ default: "docker-gha", gates: { production: "auto" } }),
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
	});

	test("a malformed gate value (e.g. 'Confirm', 'manual') means confirm, not auto", async () => {
		for (const bogus of ["Confirm", "manual"]) {
			const cfg = configWith({ default: "docker-gha" });
			// Simulate a hand-edited config.yaml carrying a value outside the union.
			(cfg.deploy.gates as Record<string, string>).staging = bogus;
			root = await initRepo({ pkg: servicePkg(), config: cfg });
			const result = await runDeploy(root, {
				target: "docker-gha",
				environment: "staging",
				dryRun: false,
				yes: false,
				agentName: "operator",
			});
			expect(result.refused).toBe(true);
			expect(result.gateDecision).toBe("denied");
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("gatePolicyFor: only an explicit 'auto' on a non-production env skips confirmation", () => {
		const cfg = configWith({ gates: { staging: "auto", "prod-eu": "auto" } });
		expect(gatePolicyFor(cfg, "staging")).toBe("auto");
		expect(gatePolicyFor(cfg, "preview")).toBe("auto");
		expect(gatePolicyFor(cfg, "production")).toBe("confirm");
		// Production-like names always confirm, whatever the config says.
		expect(gatePolicyFor(cfg, "prod-eu")).toBe("confirm");
		// No gates entry at all → confirm (fail closed).
		expect(gatePolicyFor(cfg, "qa")).toBe("confirm");
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

	test("throws NotFoundError when the only release on record is the live one", async () => {
		root = await initRepo({ pkg: servicePkg(), config: configWith({ default: "docker-gha" }) });
		seedRelease(root, "ghcr.io/demo/app:aaaaaaaaaaaa");
		await withFakeDocker(async (calls) => {
			await expect(
				runRollback(root, { target: "docker-gha", environment: "staging", agentName: "operator" }),
			).rejects.toThrow(/No prior successful deploy/i);
			// Nothing was re-pushed: there is nothing earlier to restore.
			expect(calls()).toEqual([]);
		});
	});

	test("restores the PREVIOUS release (not the live one) and records a rollback row", async () => {
		root = await initRepo({ pkg: servicePkg(), config: configWith({ default: "docker-gha" }) });
		const good = "ghcr.io/demo/app:aaaaaaaaaaaa";
		const bad = "ghcr.io/demo/app:bbbbbbbbbbbb";
		seedRelease(root, good);
		seedRelease(root, bad);

		await withFakeDocker(async (calls) => {
			const result = await runRollback(root, {
				target: "docker-gha",
				environment: "staging",
				agentName: "operator",
			});

			expect(result.refused).toBe(false);
			expect(result.current?.deploymentId).toBe(bad);
			expect(result.previous?.deploymentId).toBe(good);
			expect(result.rollback?.ok).toBe(true);
			expect(result.rollback?.deploymentId).toBe(good);
			expect(result.audit?.action).toBe("rollback");
			expect(result.audit?.deploymentId).toBe(good);
			expect(result.audit?.gateDecision).toBe("auto");

			// The environment tag is re-pointed at the GOOD image and pushed (after a
			// GHCR login that reads the token from stdin); the bad image is never touched.
			expect(calls()).toEqual([
				`image inspect ${good}`,
				`tag ${good} ghcr.io/demo/app:staging`,
				"login ghcr.io --username demo --password-stdin",
				"push ghcr.io/demo/app:staging",
			]);
		});

		// History now has three rows (two seeded deploys + the rollback), newest first.
		const rows = readAuditHistory(root, { target: "docker-gha", environment: "staging" });
		expect(rows.map((r) => r.action)).toEqual(["rollback", "deploy", "deploy"]);
	});

	test("a second rollback never rolls forward to the release that was rolled back", async () => {
		root = await initRepo({ pkg: servicePkg(), config: configWith({ default: "docker-gha" }) });
		seedRelease(root, "ghcr.io/demo/app:aaaaaaaaaaaa");
		seedRelease(root, "ghcr.io/demo/app:bbbbbbbbbbbb");
		await withFakeDocker(async (calls) => {
			await runRollback(root, { target: "docker-gha", environment: "staging", agentName: "op" });
			const afterFirst = calls().length;
			// A is live again; there is nothing older than A, so this must fail
			// rather than re-push the bad release B.
			await expect(
				runRollback(root, { target: "docker-gha", environment: "staging", agentName: "op" }),
			).rejects.toThrow(/No prior successful deploy/i);
			expect(calls().length).toBe(afterFirst);
		});
	});

	test("a rollback to a commit-tagged release works after two real deploys at different commits", async () => {
		root = await initRepo({ pkg: servicePkg(), config: configWith({ default: "docker-gha" }) });
		await withFakeDocker(async (calls) => {
			const first = await runDeploy(root, {
				target: "docker-gha",
				environment: "staging",
				dryRun: false,
				yes: false,
				agentName: "operator",
			});
			await git(root, ["commit", "-q", "--allow-empty", "-m", "second"]);
			const second = await runDeploy(root, {
				target: "docker-gha",
				environment: "staging",
				dryRun: false,
				yes: false,
				agentName: "operator",
			});
			const firstRef = first.deploy?.deploymentId ?? "";
			const secondRef = second.deploy?.deploymentId ?? "";
			// Each release is tagged with its own commit, so the two refs differ.
			expect(firstRef).toMatch(/^ghcr\.io\/app:[0-9a-f]{12}$/);
			expect(secondRef).toMatch(/^ghcr\.io\/app:[0-9a-f]{12}$/);
			expect(secondRef).not.toBe(firstRef);
			expect(first.audit?.commitSha.startsWith(firstRef.split(":")[1] ?? "?")).toBe(true);

			const rollback = await runRollback(root, {
				target: "docker-gha",
				environment: "staging",
				agentName: "operator",
			});
			expect(rollback.rollback?.ok).toBe(true);
			expect(rollback.rollback?.deploymentId).toBe(firstRef);
			expect(calls()).toContain(`tag ${firstRef} ghcr.io/app:staging`);
			expect(calls().at(-1)).toBe("push ghcr.io/app:staging");
		});
	});

	test("a confirm-gated rollback is refused without --yes and runs with it", async () => {
		root = await initRepo({ pkg: servicePkg(), config: configWith({ default: "docker-gha" }) });
		seedRelease(root, "ghcr.io/demo/app:aaaaaaaaaaaa", "production");
		seedRelease(root, "ghcr.io/demo/app:bbbbbbbbbbbb", "production");
		await withFakeDocker(async (calls) => {
			const refused = await runRollback(root, {
				target: "docker-gha",
				environment: "production",
				agentName: "operator",
			});
			expect(refused.refused).toBe(true);
			expect(refused.gateDecision).toBe("denied");
			expect(refused.refusalReason).toContain("--yes");
			expect(refused.rollback).toBeNull();
			expect(refused.audit?.gateDecision).toBe("denied");
			expect(refused.audit?.status).toBe("failed");
			expect(calls()).toEqual([]);

			const approved = await runRollback(root, {
				target: "docker-gha",
				environment: "production",
				yes: true,
				agentName: "operator",
			});
			expect(approved.refused).toBe(false);
			expect(approved.gateDecision).toBe("approved");
			expect(approved.rollback?.deploymentId).toBe("ghcr.io/demo/app:aaaaaaaaaaaa");
			expect(calls()).toContain("push ghcr.io/demo/app:production");
		});
	});

	test("rejects an unknown environment", async () => {
		root = await initRepo({ pkg: servicePkg(), config: configWith({ default: "docker-gha" }) });
		await expect(
			runRollback(root, { target: "docker-gha", environment: "prod", agentName: "operator" }),
		).rejects.toThrow(/Unknown environment/i);
	});
});

// --- generated config never clobbers existing files ------------------------

describe("deploy keeps existing files", () => {
	const customDockerfile = 'FROM golang:1.23\nCOPY . .\nRUN go build -o /app\nCMD ["/app"]\n';
	const customWorkflow = "name: my-own-deploy\non: push\n";

	/** Seed the repo with a hand-written Dockerfile, .dockerignore and workflow. */
	function writeCustomFiles(dir: string): void {
		writeFileSync(join(dir, "Dockerfile"), customDockerfile, "utf8");
		writeFileSync(join(dir, ".dockerignore"), "secret-stuff\n", "utf8");
		mkdirSync(join(dir, ".github", "workflows"), { recursive: true });
		writeFileSync(join(dir, ".github", "workflows", "deploy.yml"), customWorkflow, "utf8");
	}

	function readCustomFiles(dir: string): string[] {
		return [
			readFileSync(join(dir, "Dockerfile"), "utf8"),
			readFileSync(join(dir, ".dockerignore"), "utf8"),
			readFileSync(join(dir, ".github", "workflows", "deploy.yml"), "utf8"),
		];
	}

	test("--dry-run never modifies existing files, even with --force", async () => {
		root = await initRepo({ pkg: servicePkg(), config: configWith({ default: "docker-gha" }) });
		writeCustomFiles(root);
		const before = readCustomFiles(root);

		const plain = await runDeploy(root, {
			target: "docker-gha",
			environment: "staging",
			dryRun: true,
			yes: false,
			agentName: "operator",
		});
		expect(plain.artifacts.map((a) => a.action)).toEqual(["keep", "keep", "keep"]);
		expect(readCustomFiles(root)).toEqual(before);

		const forced = await runDeploy(root, {
			target: "docker-gha",
			environment: "staging",
			dryRun: true,
			yes: false,
			force: true,
			agentName: "operator",
		});
		expect(forced.artifacts.map((a) => a.action)).toEqual(["overwrite", "overwrite", "overwrite"]);
		expect(forced.writtenArtifacts).toEqual([]);
		expect(readCustomFiles(root)).toEqual(before);
	});

	test("a real deploy keeps existing files unless --force, and builds with the kept Dockerfile", async () => {
		root = await initRepo({ pkg: servicePkg(), config: configWith({ default: "docker-gha" }) });
		writeCustomFiles(root);
		const before = readCustomFiles(root);

		await withFakeDocker(async () => {
			const kept = await runDeploy(root, {
				target: "docker-gha",
				environment: "staging",
				dryRun: false,
				yes: false,
				agentName: "operator",
			});
			expect(kept.deploy?.ok).toBe(true);
			expect(kept.writtenArtifacts).toEqual([]);
			expect(kept.artifacts.every((a) => a.action === "keep" && !a.written)).toBe(true);
			expect(readCustomFiles(root)).toEqual(before);

			const forced = await runDeploy(root, {
				target: "docker-gha",
				environment: "staging",
				dryRun: false,
				yes: false,
				force: true,
				agentName: "operator",
			});
			expect(forced.writtenArtifacts.length).toBe(3);
			expect(readFileSync(join(root, "Dockerfile"), "utf8")).not.toBe(customDockerfile);
		});
	});

	test("a Dockerfile-only (non-Node) project uses its own Dockerfile; none is generated", async () => {
		root = await initRepo({ config: configWith({ default: "docker-gha" }) });
		writeFileSync(join(root, "Dockerfile"), customDockerfile, "utf8");
		writeFileSync(join(root, "main.go"), "package main\nfunc main() {}\n", "utf8");

		await withFakeDocker(async (calls) => {
			const result = await runDeploy(root, {
				target: "docker-gha",
				environment: "staging",
				dryRun: false,
				yes: false,
				force: true,
				agentName: "operator",
			});
			expect(result.deploy?.ok).toBe(true);
			expect(result.summary).toContain("existing Dockerfile");
			// No Dockerfile artifact at all — not even --force can replace it with a
			// Node image.
			expect(result.artifacts.some((a) => a.path === "Dockerfile")).toBe(false);
			expect(readFileSync(join(root, "Dockerfile"), "utf8")).toBe(customDockerfile);
			expect(calls()[0]).toMatch(/^build -t /);
		});
	});

	test("a real deploy that fails on missing secrets writes nothing", async () => {
		root = await initRepo({ pkg: servicePkg(), config: configWith({ default: "docker-gha" }) });
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
			expect(existsSync(join(root, "Dockerfile"))).toBe(false);
			expect(existsSync(join(root, ".github", "workflows", "deploy.yml"))).toBe(false);
		} finally {
			if (saved !== undefined) process.env.GHCR_TOKEN = saved;
		}
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
