/**
 * Tests for the Docker + GitHub Actions deploy target.
 *
 * Real implementations only: detect() reads real files in a real temp dir.
 * Real `docker` is never invoked: dry-run deploy/rollback paths spawn nothing,
 * and the real-run paths run against a stub `docker` script put first on PATH
 * that records its argv/stdin/env. generateConfig() is a pure function of the
 * context, so it is asserted directly with no environment setup.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import yaml from "js-yaml";
import { ValidationError } from "../../errors.ts";
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
	test("emits Dockerfile + .dockerignore + deploy.yml; GHCR_TOKEN only for local pushes", async () => {
		const ctx = makeContext({ profile: serviceProfile, environment: "production" });
		const config = await new DockerGhaTarget().generateConfig(ctx);

		// The local deploy pushes with GHCR_TOKEN; CI needs no user-minted secret.
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
		expect(workflow?.content).toContain("docker login ghcr.io");
		// Environment input wired through.
		expect(workflow?.content).toContain("production");
	});

	test("the workflow pushes with the job's GITHUB_TOKEN, never a long-lived PAT", async () => {
		const config = await new DockerGhaTarget().generateConfig(
			makeContext({ profile: serviceProfile, environment: "production" }),
		);
		const workflow =
			config.artifacts.find((a) => a.path === ".github/workflows/deploy.yml")?.content ?? "";
		expect(workflow).not.toContain("GHCR_TOKEN");
		const parsed = yaml.load(workflow) as {
			permissions: unknown;
			jobs: Record<
				string,
				{
					permissions: unknown;
					steps: Array<{
						name: string;
						env?: Record<string, string>;
						run?: string;
						with?: unknown;
					}>;
				}
			>;
		};
		// The ephemeral token is scoped to exactly what the push needs.
		expect(parsed.permissions).toEqual({});
		const job = parsed.jobs["build-and-push"];
		expect(job?.permissions).toEqual({ contents: "read", packages: "write" });
		// It reaches docker login over stdin, never argv.
		const login = job?.steps.find((s) => s.name === "Log in to GHCR");
		expect(login?.env).toEqual({ REGISTRY_TOKEN: `\${{ secrets.GITHUB_TOKEN }}` });
		expect(login?.run).toBe(
			`printf '%s' "$REGISTRY_TOKEN" | docker login ghcr.io --username "$GITHUB_ACTOR" --password-stdin`,
		);
		const checkout = job?.steps.find((s) => s.name === "Checkout");
		expect(checkout?.with).toEqual({ "persist-credentials": false });
	});

	test("the workflow uses no third-party actions and pins every action to a full sha", async () => {
		const config = await new DockerGhaTarget().generateConfig(
			makeContext({ profile: serviceProfile }),
		);
		const workflow =
			config.artifacts.find((a) => a.path === ".github/workflows/deploy.yml")?.content ?? "";
		const uses = [...workflow.matchAll(/^\s*(?:-\s+)?uses:\s*(\S+)/gm)].map((m) => m[1] ?? "");
		expect(uses.length).toBeGreaterThan(0);
		for (const ref of uses) {
			// First-party only (actions/*), pinned to an immutable 40-hex commit sha.
			expect(ref).toMatch(/^actions\/[A-Za-z0-9_.-]+@[0-9a-f]{40}$/);
		}
		expect(workflow).not.toContain("docker/login-action");
		expect(workflow).not.toContain("docker/build-push-action");
		expect(workflow).not.toContain("docker/setup-buildx-action");
	});

	test("rejects a dockerTimeoutSeconds setting that is not a non-negative number", async () => {
		const target = new DockerGhaTarget();
		for (const value of ["soon", "", -5, true]) {
			await expect(
				target.generateConfig(
					makeContext({ profile: serviceProfile, settings: { dockerTimeoutSeconds: value } }),
				),
			).rejects.toThrow(ValidationError);
		}
		// Numbers, numeric strings, and 0 (no cap) are accepted.
		for (const value of [900, "60", 0]) {
			await target.generateConfig(
				makeContext({ profile: serviceProfile, settings: { dockerTimeoutSeconds: value } }),
			);
		}
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
		expect(dockerfile?.content).toContain("nginx-unprivileged:1.27-alpine");
		expect(dockerfile?.content).toContain("/usr/share/nginx/html");
		expect(dockerfile?.content).toContain('CMD ["nginx", "-g", "daemon off;"]');
		// Only the build output is published, never the project sources.
		expect(dockerfile?.content).toContain("COPY --from=builder /app/dist /usr/share/nginx/html");
		expect(dockerfile?.content).not.toContain("COPY . /usr/share/nginx/html");
	});
});

/** Generate config for `profile` and return the named artifact's content. */
async function artifactFor(profile: AppProfile, path: string): Promise<string> {
	const config = await new DockerGhaTarget().generateConfig(makeContext({ profile }));
	const artifact = config.artifacts.find((a) => a.path === path);
	if (artifact === undefined) throw new Error(`no ${path} generated`);
	return artifact.content;
}

/** The instructions of a Dockerfile's final (shipped) stage. */
function finalStage(dockerfile: string): string[] {
	const lines = dockerfile.split("\n").map((l) => l.trim());
	const lastFrom = lines.map((l) => l.startsWith("FROM ")).lastIndexOf(true);
	return lines.slice(lastFrom);
}

const bareStaticProfile: AppProfile = {
	language: "static",
	framework: null,
	kind: "static",
	buildCommand: null,
	startCommand: null,
	port: null,
	packageManager: null,
	runtimeEnvKeys: [],
};

describe("DockerGhaTarget generated images (least privilege)", () => {
	const serviceProfiles: Array<[string, AppProfile, string]> = [
		["plain node service", serviceProfile, "node"],
		["built node service", { ...serviceProfile, buildCommand: "npm run build" }, "node"],
		[
			"plain bun service",
			{ ...serviceProfile, language: "bun", packageManager: "bun.lock" },
			"bun",
		],
		[
			"built bun service",
			{
				...serviceProfile,
				language: "bun",
				packageManager: "bun.lock",
				buildCommand: "bun run build",
			},
			"bun",
		],
	];

	for (const [label, profile, user] of serviceProfiles) {
		test(`a ${label} runs as the image's non-root "${user}" user`, async () => {
			const stage = finalStage(await artifactFor(profile, "Dockerfile"));
			const userLines = stage.filter((l) => l.startsWith("USER "));
			expect(userLines).toEqual([`USER ${user}`]);
			// USER comes before the CMD that starts the app, and the app owns its files.
			expect(stage.findIndex((l) => l.startsWith("USER "))).toBeLessThan(
				stage.findIndex((l) => l.startsWith("CMD ")),
			);
			expect(
				stage.some((l) => l.startsWith(`COPY --`) && l.includes(`--chown=${user}:${user}`)),
			).toBe(true);
		});
	}

	test("static sites are served by unprivileged nginx on 8080", async () => {
		for (const profile of [
			bareStaticProfile,
			{
				...bareStaticProfile,
				language: "node" as const,
				framework: "vite",
				buildCommand: "npm run build",
			},
		]) {
			const stage = finalStage(await artifactFor(profile, "Dockerfile"));
			expect(stage[0]).toBe("FROM nginxinc/nginx-unprivileged:1.27-alpine");
			expect(stage).toContain("EXPOSE 8080");
			expect(stage).not.toContain("EXPOSE 80");
		}
	});

	test(".dockerignore keeps credentials and agentplate state out of every build context", async () => {
		for (const profile of [serviceProfile, bareStaticProfile]) {
			const ignore = (await artifactFor(profile, ".dockerignore")).split("\n");
			for (const pattern of [
				".git",
				".agentplate",
				"**/.env",
				"**/.env.*",
				"**/.npmrc",
				"**/secrets.local.yaml",
				"**/*.local.yaml",
				"**/*.pem",
				"**/*.key",
				"**/.ssh",
				"**/.aws",
			]) {
				expect(ignore).toContain(pattern);
			}
		}
	});

	test("a bare static site's .dockerignore drops every dotfile and never re-includes .env.example", async () => {
		const ignore = (await artifactFor(bareStaticProfile, ".dockerignore")).split("\n");
		expect(ignore).toContain("**/.*");
		expect(ignore).toContain("!.well-known");
		expect(ignore).not.toContain("!.env.example");
		// A service may read its .env.example at runtime; it is not served publicly.
		const serviceIgnore = (await artifactFor(serviceProfile, ".dockerignore")).split("\n");
		expect(serviceIgnore).toContain("!.env.example");
		expect(serviceIgnore).not.toContain("**/.*");
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

/**
 * A stand-in `docker` executable (real docker is unsafe to drive from tests). It
 * appends each invocation's argv, whether GHCR_TOKEN reached its env, and (for
 * `login`) what it read on stdin to $FAKE_DOCKER_LOG. FAKE_DOCKER_BUILD_SLEEP
 * makes `build` hang; FAKE_DOCKER_LOGIN_FAIL=1 makes `login` fail.
 */
const FAKE_DOCKER = `#!/bin/sh
printf 'argv: %s\\n' "$*" >> "$FAKE_DOCKER_LOG"
printf 'env-token: %s\\n' "\${GHCR_TOKEN:-none}" >> "$FAKE_DOCKER_LOG"
case "$1" in
  login)
    printf 'stdin: %s\\n' "$(cat)" >> "$FAKE_DOCKER_LOG"
    if [ "$FAKE_DOCKER_LOGIN_FAIL" = "1" ]; then echo "denied" >&2; exit 1; fi
    echo "Login Succeeded" ;;
  build)
    if [ -n "$FAKE_DOCKER_BUILD_SLEEP" ]; then sleep "$FAKE_DOCKER_BUILD_SLEEP"; fi ;;
esac
exit 0
`;

describe("DockerGhaTarget real run (stub docker CLI on PATH)", () => {
	// Built by concatenation so the fixture never looks like a real token at rest.
	const token = ["ghp", "_", "stubtoken", "0123456789abcdef0123456789ab"].join("");
	const savedEnv = { ...process.env };
	let dir: string;
	let log: string;

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "fg-docker-gha-run-"));
		const bin = join(dir, "bin");
		await mkdir(bin);
		await writeFile(join(bin, "docker"), FAKE_DOCKER, { mode: 0o755 });
		log = join(dir, "docker.log");
		await writeFile(log, "");
		process.env.PATH = `${bin}:${savedEnv.PATH ?? ""}`;
		process.env.FAKE_DOCKER_LOG = log;
		delete process.env.GHCR_TOKEN;
		delete process.env.FAKE_DOCKER_BUILD_SLEEP;
		delete process.env.FAKE_DOCKER_LOGIN_FAIL;
	});

	afterEach(async () => {
		for (const key of Object.keys(process.env)) {
			if (!(key in savedEnv)) delete process.env[key];
		}
		Object.assign(process.env, savedEnv);
		await rm(dir, { recursive: true, force: true });
	});

	const readLog = async (): Promise<string[]> =>
		(await readFile(log, "utf8")).split("\n").filter((l) => l !== "");

	const realCtx = (overrides: Partial<DeployContext> = {}): DeployContext =>
		makeContext({
			profile: serviceProfile,
			worktreePath: dir,
			projectRoot: dir,
			secretEnv: { GHCR_TOKEN: token },
			settings: { registry: "ghcr.io/acme/api", sha: "abcdef1234567890" },
			...overrides,
		});

	test("logs in to GHCR over stdin (never argv/env) before pushing both tags", async () => {
		const result = await new DockerGhaTarget().deploy(realCtx());
		expect(result.ok).toBe(true);
		expect(result.outputs.pushed).toBe("true");

		const lines = await readLog();
		const argv = lines.filter((l) => l.startsWith("argv: "));
		expect(argv).toEqual([
			"argv: build -t ghcr.io/acme/api:abcdef123456 -t ghcr.io/acme/api:staging .",
			"argv: login ghcr.io --username acme --password-stdin",
			"argv: push ghcr.io/acme/api:abcdef123456",
			"argv: push ghcr.io/acme/api:staging",
		]);
		// The token arrived on login's stdin and nowhere else.
		expect(lines).toContain(`stdin: ${token}`);
		expect(argv.join("\n")).not.toContain(token);
		expect(lines.filter((l) => l.startsWith("env-token: "))).toEqual(
			Array(4).fill("env-token: none"),
		);
		expect(result.log).not.toContain(token);
	});

	test("uses the configured username for docker login", async () => {
		await new DockerGhaTarget().deploy(
			realCtx({ settings: { registry: "ghcr.io/acme/api", username: "octocat" } }),
		);
		expect(await readLog()).toContain("argv: login ghcr.io --username octocat --password-stdin");
	});

	test("never sends GHCR_TOKEN to a registry other than ghcr.io", async () => {
		const result = await new DockerGhaTarget().deploy(
			realCtx({ settings: { registry: "registry.example.com/team/api", sha: "abc123" } }),
		);
		expect(result.ok).toBe(true);
		const lines = await readLog();
		expect(lines.some((l) => l.startsWith("argv: login"))).toBe(false);
		expect(lines.some((l) => l.startsWith("stdin: "))).toBe(false);
		expect(lines).toContain("argv: push registry.example.com/team/api:abc123");
	});

	test("a failed docker login stops before any push", async () => {
		process.env.FAKE_DOCKER_LOGIN_FAIL = "1";
		const result = await new DockerGhaTarget().deploy(realCtx());
		expect(result.ok).toBe(false);
		expect(result.errorMessage).toBe("docker login ghcr.io failed (exit 1)");
		expect(result.outputs.pushed).toBe("false");
		expect((await readLog()).some((l) => l.startsWith("argv: push"))).toBe(false);
	});

	test("without a token it builds but neither logs in nor pushes", async () => {
		const result = await new DockerGhaTarget().deploy(realCtx({ secretEnv: {} }));
		expect(result.ok).toBe(true);
		expect(result.outputs.pushed).toBe("false");
		const argv = (await readLog()).filter((l) => l.startsWith("argv: "));
		expect(argv).toEqual([
			"argv: build -t ghcr.io/acme/api:abcdef123456 -t ghcr.io/acme/api:staging .",
		]);
	});

	test("kills a docker build that outlives dockerTimeoutSeconds", async () => {
		// The stub's `sleep` is a grandchild that keeps the pipes open after the
		// killed shell exits; the deploy must still return promptly.
		process.env.FAKE_DOCKER_BUILD_SLEEP = "5";
		const started = Date.now();
		const result = await new DockerGhaTarget().deploy(
			realCtx({ settings: { registry: "ghcr.io/acme/api", dockerTimeoutSeconds: 0.3 } }),
		);
		expect(Date.now() - started).toBeLessThan(4000);
		expect(result.ok).toBe(false);
		expect(result.errorMessage).toContain("docker build timed out");
		expect(result.log).toContain("timed out after 0.3s");
		expect((await readLog()).some((l) => l.startsWith("argv: push"))).toBe(false);
	});

	test("rollback logs in over stdin before pushing the re-pointed tag", async () => {
		const prior: DeployResult = {
			ok: true,
			urls: [],
			deploymentId: "ghcr.io/acme/api:oldsha123456",
			log: "",
			outputs: { imageRef: "ghcr.io/acme/api:oldsha123456" },
			errorMessage: null,
		};
		const result = await new DockerGhaTarget().rollback(realCtx(), prior);
		expect(result.ok).toBe(true);
		expect(result.outputs.pushed).toBe("true");
		const lines = await readLog();
		expect(lines.filter((l) => l.startsWith("argv: "))).toEqual([
			"argv: image inspect ghcr.io/acme/api:oldsha123456",
			"argv: tag ghcr.io/acme/api:oldsha123456 ghcr.io/acme/api:staging",
			"argv: login ghcr.io --username acme --password-stdin",
			"argv: push ghcr.io/acme/api:staging",
		]);
		expect(lines).toContain(`stdin: ${token}`);
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
