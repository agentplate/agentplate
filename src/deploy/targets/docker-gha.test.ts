/**
 * Tests for the Docker + GitHub Actions deploy target.
 *
 * Real implementations only: detect() reads real files in a real temp dir, and
 * the deploy/rollback assertions exercise ONLY the dry-run path so no `docker`
 * binary is ever invoked. generateConfig() is a pure function of the context,
 * so it is asserted directly with no environment setup.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AppProfile, DeployContext, DeployResult, DeploySecretStore } from "../types.ts";
import { DockerGhaTarget } from "./docker-gha.ts";

/** In-memory secret store backed by a plain map (no file, no env mutation). */
function memStore(values: Record<string, string>): DeploySecretStore {
	return {
		get: (key) => (key in values ? values[key] : undefined),
		has: (key) => key in values,
	};
}

/** Build a DeployContext over a given profile + overrides for tests. */
function makeContext(overrides: Partial<DeployContext> & { profile: AppProfile }): DeployContext {
	return {
		target: "docker-gha",
		environment: "staging",
		worktreePath: "/tmp/does-not-need-to-exist",
		projectRoot: "/tmp/does-not-need-to-exist",
		secretEnv: {},
		settings: {},
		dryRun: false,
		runId: null,
		agentName: "deployer-1",
		...overrides,
	};
}

/** A minimal service profile for config/deploy assertions. */
const serviceProfile: AppProfile = {
	language: "node",
	framework: "express",
	kind: "service",
	buildCommand: null,
	startCommand: "npm run start",
	port: 3000,
	packageManager: "package-lock.json",
	runtimeEnvKeys: ["DATABASE_URL"],
};

describe("DockerGhaTarget metadata", () => {
	test("declares stable identity + caps", () => {
		const target = new DockerGhaTarget();
		expect(target.id).toBe("docker-gha");
		expect(target.stability).toBe("beta");
		expect(target.label).toBe("Docker + GitHub Actions");
		expect(target.description.length).toBeGreaterThan(0);
		expect(target.caps.canRollback).toBe(true);
		expect(target.caps.irreversible).toBe(false);
		expect(target.caps.requiresCredentials).toBe(true);
		expect(target.caps.environments).toEqual(["preview", "staging", "production"]);
	});
});

describe("DockerGhaTarget.detect", () => {
	let dir: string;

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "fg-docker-gha-"));
	});

	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	test("detects a built Node service (build + start scripts, framework, port)", async () => {
		await writeFile(
			join(dir, "package.json"),
			JSON.stringify({
				name: "my-api",
				scripts: { build: "tsc", start: "node dist/index.js" },
				dependencies: { express: "^4.0.0" },
			}),
		);
		await writeFile(join(dir, "package-lock.json"), "{}");
		await writeFile(
			join(dir, ".env.example"),
			"# secrets\nDATABASE_URL=\nexport API_KEY=foo\nPORT: 8080\n",
		);

		const result = await new DockerGhaTarget().detect(dir);

		expect(result.fit).toBe(true);
		expect(result.confidence).toBeGreaterThan(0.6);
		expect(result.profile.language).toBe("node");
		expect(result.profile.kind).toBe("service");
		expect(result.profile.framework).toBe("express");
		expect(result.profile.buildCommand).toBe("npm run build");
		expect(result.profile.startCommand).toBe("npm run start");
		expect(result.profile.packageManager).toBe("package-lock.json");
		expect(result.profile.port).toBe(3000);
		// Env-var NAMES parsed from .env.example, values never captured.
		expect(result.profile.runtimeEnvKeys).toEqual(["DATABASE_URL", "API_KEY", "PORT"]);
	});

	test("detects a Bun service from bun.lock", async () => {
		await writeFile(
			join(dir, "package.json"),
			JSON.stringify({ name: "svc", scripts: { start: "bun run server.ts" } }),
		);
		await writeFile(join(dir, "bun.lock"), "");

		const result = await new DockerGhaTarget().detect(dir);

		expect(result.profile.language).toBe("bun");
		expect(result.profile.packageManager).toBe("bun.lock");
		expect(result.profile.startCommand).toBe("bun run start");
		expect(result.profile.kind).toBe("service");
	});

	test("classifies a Vite app with no start script as static", async () => {
		await writeFile(
			join(dir, "package.json"),
			JSON.stringify({
				name: "site",
				scripts: { build: "vite build" },
				devDependencies: { vite: "^5" },
			}),
		);
		await writeFile(join(dir, "package-lock.json"), "{}");

		const result = await new DockerGhaTarget().detect(dir);

		expect(result.profile.kind).toBe("static");
		expect(result.profile.framework).toBe("vite");
		expect(result.profile.startCommand).toBeNull();
		expect(result.profile.port).toBeNull();
		expect(result.fit).toBe(true);
	});

	test("detects a bare static site via index.html (no package.json)", async () => {
		await writeFile(join(dir, "index.html"), "<!doctype html><title>hi</title>");

		const result = await new DockerGhaTarget().detect(dir);

		expect(result.fit).toBe(true);
		expect(result.profile.language).toBe("static");
		expect(result.profile.kind).toBe("static");
	});

	test("returns no-fit for an empty directory", async () => {
		const result = await new DockerGhaTarget().detect(dir);
		expect(result.fit).toBe(false);
		expect(result.confidence).toBeLessThan(0.5);
		expect(result.profile.language).toBe("unknown");
	});

	test("tolerates a malformed package.json", async () => {
		await writeFile(join(dir, "package.json"), "{ this is not json");
		// No package.json parsed -> falls through; no index.html/Dockerfile -> no fit.
		const result = await new DockerGhaTarget().detect(dir);
		expect(result.fit).toBe(false);
	});
});

describe("DockerGhaTarget.generateConfig", () => {
	test("emits Dockerfile + .dockerignore + deploy.yml with GHCR_TOKEN required", async () => {
		const ctx = makeContext({ profile: serviceProfile, environment: "production" });
		const config = await new DockerGhaTarget().generateConfig(ctx);

		expect(config.requiredSecretKeys).toEqual(["GHCR_TOKEN"]);
		expect(config.summary.length).toBeGreaterThan(0);

		const paths = config.artifacts.map((a) => a.path).sort();
		expect(paths).toEqual([".dockerignore", ".github/workflows/deploy.yml", "Dockerfile"]);

		const dockerfile = config.artifacts.find((a) => a.path === "Dockerfile");
		expect(dockerfile?.kind).toBe("dockerfile");
		expect(dockerfile?.content).toContain("FROM node:22-slim");
		expect(dockerfile?.content).toContain("EXPOSE 3000");

		const ignore = config.artifacts.find((a) => a.path === ".dockerignore");
		expect(ignore?.kind).toBe("ignore");
		expect(ignore?.content).toContain("node_modules");
		expect(ignore?.content).toContain(".env");

		const workflow = config.artifacts.find((a) => a.path === ".github/workflows/deploy.yml");
		expect(workflow?.kind).toBe("ci");
		expect(workflow?.content).toContain("secrets.GHCR_TOKEN");
		expect(workflow?.content).toContain("registry: ghcr.io");
		expect(workflow?.content).toContain("docker/build-push-action");
		// Environment input wired through.
		expect(workflow?.content).toContain("production");
	});

	test("the workflow tags images with github.sha + the environment, never a frozen tag", async () => {
		const ctx = makeContext({
			profile: serviceProfile,
			environment: "production",
			settings: { app: "svc", sha: "abcdef1234567890" },
		});
		const config = await new DockerGhaTarget().generateConfig(ctx);
		const workflow = config.artifacts.find((a) => a.path === ".github/workflows/deploy.yml");
		expect(workflow?.content).toContain(`IMAGE_REF: ghcr.io/svc:\${{ github.sha }}`);
		expect(workflow?.content).toContain(
			`ENVIRONMENT_REF: ghcr.io/svc:\${{ github.event.inputs.environment || 'production' }}`,
		);
		expect(workflow?.content).not.toContain("abcdef123456");
	});

	test("rejects an environment the target does not declare (no YAML injection)", async () => {
		const target = new DockerGhaTarget();
		for (const environment of [
			"prod",
			"production\n  injected: true",
			"staging' }}\n      - run: curl evil",
			"",
		]) {
			await expect(
				target.generateConfig(makeContext({ profile: serviceProfile, environment })),
			).rejects.toThrow(/Unknown environment/);
		}
	});

	test("keeps a Dockerfile-only (unprofiled) project's own Dockerfile", async () => {
		const dir = await mkdtemp(join(tmpdir(), "fg-docker-gha-own-"));
		try {
			await writeFile(join(dir, "Dockerfile"), "FROM golang:1.23\n");
			const target = new DockerGhaTarget();
			const detected = await target.detect(dir);
			const config = await target.generateConfig(
				makeContext({ profile: detected.profile, worktreePath: dir, projectRoot: dir }),
			);
			const paths = config.artifacts.map((a) => a.path).sort();
			expect(paths).toEqual([".dockerignore", ".github/workflows/deploy.yml"]);
			expect(config.summary).toContain("existing Dockerfile");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test("is deterministic for the same context", async () => {
		const ctx = makeContext({ profile: serviceProfile });
		const a = await new DockerGhaTarget().generateConfig(ctx);
		const b = await new DockerGhaTarget().generateConfig(ctx);
		expect(a.artifacts.map((x) => x.content)).toEqual(b.artifacts.map((x) => x.content));
	});

	test("renders a multi-stage Dockerfile when a build command is present", async () => {
		const built: AppProfile = { ...serviceProfile, buildCommand: "npm run build" };
		const config = await new DockerGhaTarget().generateConfig(makeContext({ profile: built }));
		const dockerfile = config.artifacts.find((a) => a.path === "Dockerfile");
		expect(dockerfile?.content).toContain("AS builder");
		expect(dockerfile?.content).toContain("AS runner");
		expect(dockerfile?.content).toContain("RUN npm run build");
	});

	test("renders an nginx static Dockerfile for a static profile", async () => {
		const staticProfile: AppProfile = {
			language: "node",
			framework: "vite",
			kind: "static",
			buildCommand: "npm run build",
			startCommand: null,
			port: null,
			packageManager: "package-lock.json",
			runtimeEnvKeys: [],
		};
		const config = await new DockerGhaTarget().generateConfig(
			makeContext({ profile: staticProfile }),
		);
		const dockerfile = config.artifacts.find((a) => a.path === "Dockerfile");
		expect(dockerfile?.content).toContain("nginx:1.27-alpine");
		expect(dockerfile?.content).toContain("/usr/share/nginx/html");
		expect(dockerfile?.content).toContain('CMD ["nginx", "-g", "daemon off;"]');
	});
});

describe("DockerGhaTarget.deploy (dry-run only)", () => {
	test("dry-run returns a planned ok result with no side effects", async () => {
		const ctx = makeContext({
			profile: serviceProfile,
			dryRun: true,
			settings: { registry: "ghcr.io/acme", app: "my-api", sha: "abcdef1234567890" },
		});
		const result = await new DockerGhaTarget().deploy(ctx);

		expect(result.ok).toBe(true);
		expect(result.deploymentId).toBeNull();
		expect(result.urls).toEqual([]);
		expect(result.errorMessage).toBeNull();
		expect(result.log).toContain("[dry-run]");
		expect(result.log).toContain("would build");
		// Image ref: registry already has a path, so app is not re-appended; sha truncated.
		expect(result.outputs.imageRef).toBe("ghcr.io/acme:abcdef123456");
		expect(result.outputs.pushed).toBe("false");
	});

	test("dry-run notes a missing token without attempting a push", async () => {
		const ctx = makeContext({ profile: serviceProfile, dryRun: true, secretEnv: {} });
		const result = await new DockerGhaTarget().deploy(ctx);
		expect(result.ok).toBe(true);
		expect(result.log).toContain("no GHCR_TOKEN");
	});

	test("dry-run with a token plans a push", async () => {
		const ctx = makeContext({
			profile: serviceProfile,
			dryRun: true,
			secretEnv: { GHCR_TOKEN: "ghp_exampletokenvalue000000000000" },
			settings: { app: "svc" },
		});
		const result = await new DockerGhaTarget().deploy(ctx);
		expect(result.ok).toBe(true);
		expect(result.log).toContain("and push");
		// The token value must never leak into the captured log.
		expect(result.log).not.toContain("ghp_exampletokenvalue000000000000");
		// Default registry + slugged app + "latest" when no sha.
		expect(result.outputs.imageRef).toBe("ghcr.io/svc:latest");
	});

	test("dry-run derives a sane default image ref when settings are empty", async () => {
		const ctx = makeContext({ profile: serviceProfile, dryRun: true });
		const result = await new DockerGhaTarget().deploy(ctx);
		expect(result.outputs.imageRef).toBe("ghcr.io/app:latest");
		expect(result.outputs.environmentRef).toBe("ghcr.io/app:staging");
	});

	test("tags the image with the worktree's HEAD commit when no sha is pinned", async () => {
		const repo = await mkdtemp(join(tmpdir(), "fg-docker-gha-git-"));
		try {
			const git = async (args: string[]): Promise<string> => {
				const proc = Bun.spawn(["git", ...args], { cwd: repo, stdout: "pipe", stderr: "pipe" });
				const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
				if (code !== 0) throw new Error(`git ${args.join(" ")} failed`);
				return out.trim();
			};
			await git(["init", "-q"]);
			await git([
				"-c",
				"user.email=t@t.dev",
				"-c",
				"user.name=T",
				"commit",
				"-q",
				"--allow-empty",
				"-m",
				"a",
			]);
			const head = await git(["rev-parse", "HEAD"]);

			const ctx = makeContext({
				profile: serviceProfile,
				dryRun: true,
				worktreePath: repo,
				settings: { app: "svc" },
			});
			const result = await new DockerGhaTarget().deploy(ctx);
			expect(result.outputs.imageRef).toBe(`ghcr.io/svc:${head.slice(0, 12)}`);
		} finally {
			await rm(repo, { recursive: true, force: true });
		}
	});
});

describe("DockerGhaTarget.rollback (dry-run only)", () => {
	test("dry-run plans re-pointing the environment tag at the given release's image", async () => {
		const prior: DeployResult = {
			ok: true,
			urls: [],
			deploymentId: "ghcr.io/acme/my-api:oldsha123456",
			log: "",
			outputs: { imageRef: "ghcr.io/acme/my-api:oldsha123456" },
			errorMessage: null,
		};
		// The context's own (current) ref differs: rollback must not fall back to it.
		const ctx = makeContext({
			profile: serviceProfile,
			dryRun: true,
			environment: "production",
			settings: { registry: "ghcr.io/acme/my-api", sha: "newsha999999" },
		});
		const result = await new DockerGhaTarget().rollback(ctx, prior);

		expect(result.ok).toBe(true);
		expect(result.deploymentId).toBeNull();
		expect(result.log).toContain("[dry-run]");
		expect(result.log).toContain("ghcr.io/acme/my-api:oldsha123456");
		expect(result.log).not.toContain("newsha999999");
		expect(result.outputs.imageRef).toBe("ghcr.io/acme/my-api:oldsha123456");
		expect(result.outputs.environmentRef).toBe("ghcr.io/acme/my-api:production");
		expect(result.outputs.rolledBack).toBe("planned");
	});

	test("re-points the environment tag in the restored image's own repository", async () => {
		const prior: DeployResult = {
			ok: true,
			urls: [],
			deploymentId: "localhost:5000/team/api:oldsha123456",
			log: "",
			outputs: { imageRef: "localhost:5000/team/api:oldsha123456" },
			errorMessage: null,
		};
		// Settings now point elsewhere; the env tag must follow the restored image.
		const ctx = makeContext({ profile: serviceProfile, dryRun: true, settings: { app: "other" } });
		const result = await new DockerGhaTarget().rollback(ctx, prior);
		expect(result.outputs.environmentRef).toBe("localhost:5000/team/api:staging");
	});

	test("fails (never re-pushes the current image) when the release has no recorded ref", async () => {
		const prior: DeployResult = {
			ok: true,
			urls: [],
			deploymentId: null,
			log: "",
			outputs: {},
			errorMessage: null,
		};
		const ctx = makeContext({ profile: serviceProfile, dryRun: true, settings: { app: "svc" } });
		const result = await new DockerGhaTarget().rollback(ctx, prior);
		expect(result.ok).toBe(false);
		expect(result.errorMessage).toContain("no recorded image ref");
		expect(result.outputs.rolledBack).toBe("false");
	});
});

describe("DockerGhaTarget.buildSecretEnv", () => {
	test("maps a present GHCR_TOKEN", () => {
		const env = new DockerGhaTarget().buildSecretEnv(memStore({ GHCR_TOKEN: "tok-123" }));
		expect(env).toEqual({ GHCR_TOKEN: "tok-123" });
	});

	test("omits GHCR_TOKEN when absent or empty", () => {
		const target = new DockerGhaTarget();
		expect(target.buildSecretEnv(memStore({}))).toEqual({});
		expect(target.buildSecretEnv(memStore({ GHCR_TOKEN: "" }))).toEqual({});
	});

	test("ignores unrelated secrets", () => {
		const env = new DockerGhaTarget().buildSecretEnv(memStore({ GHCR_TOKEN: "tok", OTHER: "x" }));
		expect(env).toEqual({ GHCR_TOKEN: "tok" });
	});
});
