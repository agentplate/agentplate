/**
 * Docker + GitHub Actions deploy target.
 *
 * The baseline, most-universal target: containerize the app and ship a GitHub
 * Actions workflow that builds the image, logs in to GHCR, and pushes a tag.
 * It is the least credential-coupled target — a single `GHCR_TOKEN` is the only
 * secret — which makes it a sane default fit for almost any web service or
 * static site.
 *
 * Mechanics only (no AI). The staged pipeline calls these methods; this file
 * never embeds pipeline policy. The split mirrors the runtime adapters:
 *
 *   detect()         — pure, read-only inference of an {@link AppProfile} from
 *                      package.json / lockfiles / framework markers.
 *   generateConfig() — deterministic, side-effect-free artifact emission
 *                      (Dockerfile, .dockerignore, deploy workflow). The engine
 *                      decides what to write: it never overwrites an existing
 *                      file without --force, and a dry run writes nothing. A
 *                      project we cannot profile that ships its own Dockerfile
 *                      keeps it (no Dockerfile is generated for it).
 *   deploy()         — the ONE outward-facing mutation. Honors `ctx.dryRun`:
 *                      a dry run plans (no `docker` invoked) and a real run
 *                      builds (and pushes when a token is present).
 *   verify()         — read-only smoke check (HTTP GET, else local image probe).
 *   rollback()       — best-effort re-point of the environment tag at the image
 *                      of the release being restored.
 *
 * Image tags: every deploy builds an immutable `<repo>:<commit>` image (the
 * deployment id; the commit is `settings.sha`/`commit`, else the worktree's
 * HEAD) and moves a per-environment tag `<repo>:<environment>` to it. The
 * environment tag is what an environment should pull; rollback moves it back to
 * the previous release's immutable image.
 *
 * Secrets enter exclusively through {@link DockerGhaTarget.buildSecretEnv}
 * (env-by-name), and every captured CLI line is run through {@link sanitize}
 * before it leaves this module.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ValidationError } from "../../errors.ts";
import { sanitize } from "../../logging/sanitizer.ts";
import type {
	AppProfile,
	DeployCaps,
	DeployContext,
	DeployResult,
	DeploySecretStore,
	DeployTarget,
	DetectResult,
	GeneratedArtifact,
	GeneratedConfig,
	VerifyResult,
} from "../types.ts";

/** The single secret this target needs at deploy time (GHCR push auth). */
const GHCR_TOKEN_KEY = "GHCR_TOKEN";

/** Default container port when none can be inferred from the app. */
const DEFAULT_PORT = 3000;

/** Result of running a subprocess (never throws on non-zero exit). */
interface ProcResult {
	stdout: string;
	stderr: string;
	exitCode: number;
	/** True when the binary itself could not be spawned (e.g. not installed). */
	spawnFailed: boolean;
}

/**
 * Run a command and capture its output. Mirrors the merge resolver's `runGit`:
 * non-zero exits are returned, not thrown, because callers branch on them. A
 * spawn failure (binary missing) is surfaced via `spawnFailed` rather than an
 * exception so deploy/verify can degrade gracefully.
 */
async function runCommand(
	argv: string[],
	cwd: string,
	env?: Record<string, string>,
): Promise<ProcResult> {
	try {
		const proc = Bun.spawn(argv, {
			cwd,
			stdout: "pipe",
			stderr: "pipe",
			env: env ? { ...process.env, ...env } : process.env,
		});
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);
		return { stdout, stderr, exitCode, spawnFailed: false };
	} catch (error) {
		return { stdout: "", stderr: (error as Error).message, exitCode: -1, spawnFailed: true };
	}
}

/** Minimal shape we read out of a project's package.json (everything optional). */
interface PackageJsonShape {
	name?: unknown;
	scripts?: unknown;
	dependencies?: unknown;
	devDependencies?: unknown;
}

/** Read + JSON-parse a file, returning null on any failure (missing, malformed). */
function readJsonFile(path: string): unknown {
	if (!existsSync(path)) return null;
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return null;
	}
}

/** Treat an unknown value as a string→unknown record (else an empty record). */
function asRecord(value: unknown): Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}

/** True if any of `names` is present as a key in the (deps ∪ devDeps) union. */
function dependsOn(pkg: PackageJsonShape, names: string[]): boolean {
	const deps = { ...asRecord(pkg.dependencies), ...asRecord(pkg.devDependencies) };
	return names.some((name) => name in deps);
}

/** Map a detected lockfile to its package-manager family name (null if none). */
function detectPackageManager(projectDir: string): string | null {
	const lockfiles = ["bun.lock", "bun.lockb", "pnpm-lock.yaml", "yarn.lock", "package-lock.json"];
	for (const lock of lockfiles) {
		if (existsSync(join(projectDir, lock))) return lock;
	}
	return null;
}

/**
 * Parse the env-var NAMES (never values) declared in a `.env.example`. Accepts
 * `KEY=...`, `KEY:`, and `export KEY=...`; ignores comments and blanks. Returns
 * a de-duplicated list in first-seen order.
 */
function parseEnvExampleKeys(projectDir: string): string[] {
	const path = join(projectDir, ".env.example");
	if (!existsSync(path)) return [];
	let body: string;
	try {
		body = readFileSync(path, "utf8");
	} catch {
		return [];
	}
	const keys: string[] = [];
	const seen = new Set<string>();
	for (const rawLine of body.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (line === "" || line.startsWith("#")) continue;
		const withoutExport = line.startsWith("export ") ? line.slice("export ".length) : line;
		const match = withoutExport.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*[=:]/);
		const key = match?.[1];
		if (key !== undefined && !seen.has(key)) {
			seen.add(key);
			keys.push(key);
		}
	}
	return keys;
}

/**
 * Infer a build command from package.json scripts. Prefers an explicit `build`
 * script; returns null when none exists (nothing to build).
 */
function inferBuildCommand(pkg: PackageJsonShape, runner: string): string | null {
	const scripts = asRecord(pkg.scripts);
	if (typeof scripts.build === "string") return `${runner} run build`;
	return null;
}

/**
 * Infer a start command. Prefers a `start` script, then a `main`/`server`
 * convention via the package manager's runner; null when nothing is evident.
 */
function inferStartCommand(pkg: PackageJsonShape, runner: string): string | null {
	const scripts = asRecord(pkg.scripts);
	if (typeof scripts.start === "string") return `${runner} run start`;
	if (typeof scripts.serve === "string") return `${runner} run serve`;
	return null;
}

/** Map a lockfile family to the CLI used to run scripts inside the image. */
function runnerForLockfile(lockfile: string | null): string {
	if (lockfile === "bun.lock" || lockfile === "bun.lockb") return "bun";
	if (lockfile === "pnpm-lock.yaml") return "pnpm";
	if (lockfile === "yarn.lock") return "yarn";
	return "npm";
}

/** Detect a framework + its conventional listen port, if recognizable. */
function detectFramework(pkg: PackageJsonShape): { framework: string | null; port: number | null } {
	if (dependsOn(pkg, ["next"])) return { framework: "next", port: 3000 };
	if (dependsOn(pkg, ["@remix-run/node", "@remix-run/serve"])) {
		return { framework: "remix", port: 3000 };
	}
	if (dependsOn(pkg, ["nuxt"])) return { framework: "nuxt", port: 3000 };
	if (dependsOn(pkg, ["@nestjs/core"])) return { framework: "nest", port: 3000 };
	if (dependsOn(pkg, ["express", "fastify", "koa", "hono"])) {
		return { framework: dependsOn(pkg, ["fastify"]) ? "fastify" : "express", port: DEFAULT_PORT };
	}
	if (dependsOn(pkg, ["vite"])) return { framework: "vite", port: null };
	if (dependsOn(pkg, ["react-scripts"])) return { framework: "cra", port: null };
	return { framework: null, port: null };
}

/**
 * Decide whether the app is a long-running service or a static site. A build
 * tool with no obvious server (vite/CRA and no start/serve script and no
 * server framework) is treated as static; otherwise a service.
 */
function classifyKind(framework: string | null, startCommand: string | null): "service" | "static" {
	const serverFrameworks = ["next", "remix", "nuxt", "nest", "express", "fastify"];
	if (framework !== null && serverFrameworks.includes(framework)) return "service";
	const staticBuilders = framework === "vite" || framework === "cra";
	if (staticBuilders && startCommand === null) return "static";
	if (startCommand !== null) return "service";
	return "service";
}

/** Build the {@link AppProfile} for a Node/Bun project from its package.json. */
function profileFromPackageJson(projectDir: string, pkg: PackageJsonShape): AppProfile {
	const packageManager = detectPackageManager(projectDir);
	const runner = runnerForLockfile(packageManager);
	const language: AppProfile["language"] =
		packageManager === "bun.lock" || packageManager === "bun.lockb" ? "bun" : "node";
	const { framework, port } = detectFramework(pkg);
	const buildCommand = inferBuildCommand(pkg, runner);
	const startCommand = inferStartCommand(pkg, runner);
	const kind = classifyKind(framework, startCommand);
	const resolvedPort = kind === "service" ? (port ?? DEFAULT_PORT) : null;
	return {
		language,
		framework,
		kind,
		buildCommand,
		startCommand: kind === "service" ? startCommand : null,
		port: resolvedPort,
		packageManager,
		runtimeEnvKeys: parseEnvExampleKeys(projectDir),
	};
}

/** Profile for a directory with no package.json but a static `index.html`. */
function staticHtmlProfile(projectDir: string): AppProfile {
	return {
		language: "static",
		framework: null,
		kind: "static",
		buildCommand: null,
		startCommand: null,
		port: null,
		packageManager: null,
		runtimeEnvKeys: parseEnvExampleKeys(projectDir),
	};
}

/** Fallback profile when nothing about the project can be inferred. */
function unknownProfile(projectDir: string): AppProfile {
	return {
		language: "unknown",
		framework: null,
		kind: "service",
		buildCommand: null,
		startCommand: null,
		port: null,
		packageManager: null,
		runtimeEnvKeys: parseEnvExampleKeys(projectDir),
	};
}

/** Quote the env-var name into the image tag's app slug (lowercased, safe). */
function slugForApp(name: string): string {
	const slug = name
		.toLowerCase()
		.replace(/[^a-z0-9._-]+/g, "-")
		.replace(/^-+|-+$/g, "");
	return slug === "" ? "app" : slug;
}

/** Short, image-tag-safe slice of a commit sha (or "latest" when absent). */
function shaTag(sha: string | undefined): string {
	if (sha === undefined || sha.trim() === "") return "latest";
	const cleaned = sha.trim().replace(/[^a-zA-Z0-9._-]+/g, "");
	return cleaned === "" ? "latest" : cleaned.slice(0, 12);
}

/** Coerce a settings value to a string (settings may be string|number|boolean). */
function settingString(
	settings: Record<string, string | number | boolean>,
	key: string,
): string | undefined {
	const value = settings[key];
	if (value === undefined) return undefined;
	return typeof value === "string" ? value : String(value);
}

/**
 * The image repository (no tag) for a deploy context: `<registry>/<app>`.
 * `registry` and `app` come from non-secret settings, with GHCR-shaped
 * fallbacks so a partially-configured target still produces a sane ref.
 */
function imageRepo(ctx: DeployContext): string {
	const registry =
		settingString(ctx.settings, "registry") ?? settingString(ctx.settings, "image") ?? "ghcr.io";
	const appSetting =
		settingString(ctx.settings, "app") ?? settingString(ctx.settings, "appName") ?? "app";
	const app = slugForApp(appSetting);
	// If `registry` already includes a path (a/b), it names the repo; else add app.
	return registry.includes("/") ? registry : `${registry}/${app}`;
}

/** The commit pinned in settings (`sha`, else `commit`), if any. */
function configuredSha(ctx: DeployContext): string | undefined {
	const sha = settingString(ctx.settings, "sha") ?? settingString(ctx.settings, "commit");
	return sha === undefined || sha.trim() === "" ? undefined : sha;
}

/**
 * Compute the immutable image reference for a deploy context:
 *   <registry>/<app>:<sha-ish>
 * The tag is the commit pinned in settings, else `headSha` when given, else
 * "latest".
 */
function imageRef(ctx: DeployContext, headSha?: string): string {
	return `${imageRepo(ctx)}:${shaTag(configuredSha(ctx) ?? headSha)}`;
}

/**
 * The moving per-environment image reference (`<repo>:<environment>`). Every
 * deploy points it at the new image; rollback points it back.
 */
function environmentRef(repo: string, environment: string): string {
	const tag = environment
		.toLowerCase()
		.replace(/[^a-z0-9._-]+/g, "-")
		.replace(/^[.-]+/, "")
		.slice(0, 128);
	return `${repo}:${tag === "" ? "env" : tag}`;
}

/** The repository part of an image ref (drops `:tag` / `@digest`; keeps a registry port). */
function repositoryOf(ref: string): string {
	const at = ref.indexOf("@");
	const name = at === -1 ? ref : ref.slice(0, at);
	const colon = name.lastIndexOf(":");
	return colon > name.lastIndexOf("/") ? name.slice(0, colon) : name;
}

/** The worktree's HEAD commit sha, or undefined (not a git repo / no commits). */
async function readHeadSha(cwd: string): Promise<string | undefined> {
	const result = await runCommand(["git", "rev-parse", "HEAD"], cwd);
	if (result.spawnFailed || result.exitCode !== 0) return undefined;
	const sha = result.stdout.trim();
	return sha === "" ? undefined : sha;
}

/**
 * Resolve the immutable image ref for a deploy: tag with the pinned commit, else
 * the worktree's HEAD, so consecutive releases get distinct, restorable refs.
 */
async function resolveImageRef(ctx: DeployContext): Promise<string> {
	if (configuredSha(ctx) !== undefined) return imageRef(ctx);
	return imageRef(ctx, await readHeadSha(ctx.worktreePath));
}

/**
 * Reject an environment the target does not declare before it is interpolated
 * into generated YAML. Declared environments are plain slugs, so an allowlisted
 * value can never break out of the workflow's scalars or `${{ }}` expressions.
 */
function assertKnownEnvironment(environment: string, known: readonly string[]): void {
	if (!known.includes(environment) || !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(environment)) {
		throw new ValidationError(
			`Unknown environment ${JSON.stringify(environment)} for docker-gha. ` +
				`Known environments: ${known.join(", ")}`,
		);
	}
}

// ---------------------------------------------------------------------------
// Artifact templates (deterministic strings)
// ---------------------------------------------------------------------------

/** Multi-stage Dockerfile for a built Node/Bun service. */
function dockerfileBuiltService(profile: AppProfile): string {
	const isBun = profile.language === "bun";
	const baseImage = isBun ? "oven/bun:1" : "node:22-slim";
	const installCmd = isBun
		? "bun install --frozen-lockfile"
		: profile.packageManager === "pnpm-lock.yaml"
			? "corepack enable && pnpm install --frozen-lockfile"
			: profile.packageManager === "yarn.lock"
				? "corepack enable && yarn install --frozen-lockfile"
				: "npm ci";
	const buildCmd = profile.buildCommand ?? (isBun ? "bun run build" : "npm run build");
	const startCmd = profile.startCommand ?? (isBun ? "bun run start" : "npm run start");
	const port = profile.port ?? DEFAULT_PORT;
	return [
		`# syntax=docker/dockerfile:1`,
		`# Multi-stage build for a ${profile.framework ?? profile.language} service.`,
		`FROM ${baseImage} AS builder`,
		`WORKDIR /app`,
		`COPY . .`,
		`RUN ${installCmd}`,
		`RUN ${buildCmd}`,
		``,
		`FROM ${baseImage} AS runner`,
		`ENV NODE_ENV=production`,
		`WORKDIR /app`,
		`COPY --from=builder /app /app`,
		`EXPOSE ${port}`,
		`CMD ${dockerExecForm(startCmd)}`,
		``,
	].join("\n");
}

/** Single-stage Dockerfile for a Node/Bun service that needs no build step. */
function dockerfilePlainService(profile: AppProfile): string {
	const isBun = profile.language === "bun";
	const baseImage = isBun ? "oven/bun:1" : "node:22-slim";
	const installCmd = isBun ? "bun install --frozen-lockfile" : "npm ci --omit=dev";
	const startCmd = profile.startCommand ?? (isBun ? "bun run start" : "npm run start");
	const port = profile.port ?? DEFAULT_PORT;
	return [
		`# syntax=docker/dockerfile:1`,
		`# Single-stage image for a ${profile.framework ?? profile.language} service.`,
		`FROM ${baseImage}`,
		`ENV NODE_ENV=production`,
		`WORKDIR /app`,
		`COPY . .`,
		`RUN ${installCmd}`,
		`EXPOSE ${port}`,
		`CMD ${dockerExecForm(startCmd)}`,
		``,
	].join("\n");
}

/** Two-stage Dockerfile that builds static assets and serves them via nginx. */
function dockerfileStatic(profile: AppProfile): string {
	const isBun = profile.language === "bun";
	const baseImage = isBun ? "oven/bun:1" : "node:22-slim";
	const installCmd = isBun ? "bun install --frozen-lockfile" : "npm ci";
	const buildCmd = profile.buildCommand ?? (isBun ? "bun run build" : "npm run build");
	// Vite emits dist/, CRA emits build/. Default to dist for everything else.
	const outDir = profile.framework === "cra" ? "build" : "dist";
	const builderStage =
		profile.language === "static"
			? // No build tooling: copy the prebuilt site straight into nginx.
				[`FROM nginx:1.27-alpine`, `COPY . /usr/share/nginx/html`]
			: [
					`FROM ${baseImage} AS builder`,
					`WORKDIR /app`,
					`COPY . .`,
					`RUN ${installCmd}`,
					`RUN ${buildCmd}`,
					``,
					`FROM nginx:1.27-alpine`,
					`COPY --from=builder /app/${outDir} /usr/share/nginx/html`,
				];
	return [
		`# syntax=docker/dockerfile:1`,
		`# Static site served by nginx${profile.language === "static" ? "" : " (built from source)"}.`,
		...builderStage,
		`EXPOSE 80`,
		`CMD ["nginx", "-g", "daemon off;"]`,
		``,
	].join("\n");
}

/** Render a shell command string as a Docker JSON exec-form CMD array literal. */
function dockerExecForm(command: string): string {
	const parts = command.split(/\s+/).filter((p) => p !== "");
	return `[${parts.map((p) => JSON.stringify(p)).join(", ")}]`;
}

/** Choose the Dockerfile body that matches the detected profile. */
function renderDockerfile(profile: AppProfile): string {
	if (profile.kind === "static") return dockerfileStatic(profile);
	if (profile.buildCommand !== null) return dockerfileBuiltService(profile);
	return dockerfilePlainService(profile);
}

/** Standard `.dockerignore` keeping build context small + secret-free. */
function renderDockerignore(): string {
	return [
		"node_modules",
		"npm-debug.log",
		"bun-debug.log",
		".git",
		".gitignore",
		".github",
		".agentplate",
		"Dockerfile",
		".dockerignore",
		"*.md",
		".env",
		".env.*",
		"!.env.example",
		"dist",
		"build",
		".next",
		"coverage",
		".DS_Store",
		"",
	].join("\n");
}

/**
 * GitHub Actions workflow: build the image, log in to GHCR with
 * `secrets.GHCR_TOKEN`, and push it tagged with the commit being built
 * (`github.sha`) plus the moving environment tag. Exposes an `environment` input
 * so the same workflow drives preview/staging/production. `ctx.environment`
 * must already be validated (see {@link assertKnownEnvironment}).
 */
function renderDeployWorkflow(ctx: DeployContext): string {
	const repo = imageRepo(ctx);
	const environment = ctx.environment;
	return `name: deploy

on:
  workflow_dispatch:
    inputs:
      environment:
        description: Target environment
        required: true
        default: ${environment}
        type: choice
        options:
          - preview
          - staging
          - production
  push:
    branches:
      - main

concurrency:
  group: deploy-\${{ github.event.inputs.environment || '${environment}' }}
  cancel-in-progress: false

jobs:
  build-and-push:
    runs-on: ubuntu-latest
    environment: \${{ github.event.inputs.environment || '${environment}' }}
    permissions:
      contents: read
      packages: write
    env:
      IMAGE_REF: ${repo}:\${{ github.sha }}
      ENVIRONMENT_REF: ${repo}:\${{ github.event.inputs.environment || '${environment}' }}
    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Set up Docker Buildx
        uses: docker/setup-buildx-action@v3

      - name: Log in to GHCR
        uses: docker/login-action@v3
        with:
          registry: ghcr.io
          username: \${{ github.actor }}
          password: \${{ secrets.GHCR_TOKEN }}

      - name: Build and push image
        uses: docker/build-push-action@v6
        with:
          context: .
          push: true
          tags: |
            \${{ env.IMAGE_REF }}
            \${{ env.ENVIRONMENT_REF }}
`;
}

// ---------------------------------------------------------------------------
// Target implementation
// ---------------------------------------------------------------------------

/**
 * The baseline deploy target: containerize + push via GitHub Actions to GHCR.
 * Stateless; all inputs arrive through {@link DeployContext} / project files,
 * and the only outward mutation lives in {@link DockerGhaTarget.deploy}.
 */
export class DockerGhaTarget implements DeployTarget {
	readonly id = "docker-gha";
	readonly stability = "beta" as const;
	readonly label = "Docker + GitHub Actions";
	readonly description =
		"Containerize the app and ship a GitHub Actions workflow that builds the image, " +
		"logs in to GHCR, and pushes a tagged image. The most universal, least " +
		"credential-coupled target (a single GHCR_TOKEN).";
	readonly caps: DeployCaps = {
		canRollback: true,
		irreversible: false,
		environments: ["preview", "staging", "production"],
		requiresCredentials: true,
	};

	async detect(projectDir: string): Promise<DetectResult> {
		const pkgRaw = readJsonFile(join(projectDir, "package.json"));
		if (pkgRaw !== null) {
			const pkg = asRecord(pkgRaw) as PackageJsonShape;
			const profile = profileFromPackageJson(projectDir, pkg);
			// Confidence reflects how much we positively identified.
			let confidence = 0.6;
			if (profile.packageManager !== null) confidence += 0.1;
			if (profile.framework !== null) confidence += 0.15;
			if (profile.startCommand !== null || profile.buildCommand !== null) confidence += 0.1;
			const reasonParts = [
				`package.json detected (${profile.language}`,
				profile.framework !== null ? `, ${profile.framework}` : "",
				`, kind=${profile.kind})`,
			];
			return {
				fit: true,
				confidence: Math.min(confidence, 0.95),
				profile,
				reason: `${reasonParts.join("")}; containerizable via Docker + GHA.`,
			};
		}
		if (existsSync(join(projectDir, "index.html"))) {
			return {
				fit: true,
				confidence: 0.5,
				profile: staticHtmlProfile(projectDir),
				reason: "Static index.html detected; servable as an nginx container.",
			};
		}
		if (existsSync(join(projectDir, "Dockerfile"))) {
			return {
				fit: true,
				confidence: 0.55,
				profile: unknownProfile(projectDir),
				reason: "Existing Dockerfile detected; image is buildable for GHA push.",
			};
		}
		return {
			fit: false,
			confidence: 0.1,
			profile: unknownProfile(projectDir),
			reason: "No package.json, static entry, or Dockerfile found; cannot infer a build.",
		};
	}

	async generateConfig(ctx: DeployContext): Promise<GeneratedConfig> {
		assertKnownEnvironment(ctx.environment, this.caps.environments);
		const profile = ctx.profile;
		// A project we could not profile (Go, Python, …) that ships its own
		// Dockerfile builds with it: a generated Node image would be wrong for it.
		const useOwnDockerfile =
			profile.language === "unknown" && existsSync(join(ctx.worktreePath, "Dockerfile"));
		const artifacts: GeneratedArtifact[] = [];
		if (!useOwnDockerfile) {
			artifacts.push({
				path: "Dockerfile",
				content: renderDockerfile(profile),
				kind: "dockerfile",
			});
		}
		artifacts.push(
			{ path: ".dockerignore", content: renderDockerignore(), kind: "ignore" },
			{
				path: ".github/workflows/deploy.yml",
				content: renderDeployWorkflow(ctx),
				kind: "ci",
			},
		);
		const dockerfileNote = useOwnDockerfile
			? "Using the project's existing Dockerfile; generated a "
			: `Generated a ${profile.kind === "static" ? "static (nginx)" : profile.language} Dockerfile, `;
		const summary =
			dockerfileNote +
			`.dockerignore, and a GitHub Actions deploy workflow (GHCR push, ` +
			`environment=${ctx.environment}). Requires secret GHCR_TOKEN.`;
		return {
			artifacts,
			requiredSecretKeys: [GHCR_TOKEN_KEY],
			summary,
		};
	}

	async deploy(ctx: DeployContext): Promise<DeployResult> {
		const ref = await resolveImageRef(ctx);
		const envRef = environmentRef(imageRepo(ctx), ctx.environment);
		const baseOutputs = { imageRef: ref, environmentRef: envRef, environment: ctx.environment };
		const hasToken =
			typeof ctx.secretEnv[GHCR_TOKEN_KEY] === "string" && ctx.secretEnv[GHCR_TOKEN_KEY] !== "";

		// Dry-run: plan only. No docker invoked, no outward mutation.
		if (ctx.dryRun) {
			const pushNote = hasToken ? "and push" : "(no GHCR_TOKEN present — would skip push)";
			return {
				ok: true,
				urls: [],
				deploymentId: null,
				log: sanitize(
					`[dry-run] would build+push image ${ref} (tagged ${envRef}) ${pushNote} ` +
						`from ${ctx.worktreePath}`,
				),
				outputs: { ...baseOutputs, pushed: "false" },
				errorMessage: null,
			};
		}

		// Real run: build the image. `docker` may be unavailable — degrade, don't throw.
		const logLines: string[] = [];
		const build = await runCommand(
			["docker", "build", "-t", ref, "-t", envRef, "."],
			ctx.worktreePath,
			ctx.secretEnv,
		);
		if (build.spawnFailed) {
			return {
				ok: false,
				urls: [],
				deploymentId: null,
				log: sanitize(`docker is unavailable: ${build.stderr}`.trim()),
				outputs: { ...baseOutputs, pushed: "false" },
				errorMessage: "docker CLI not found or could not be spawned",
			};
		}
		logLines.push(`$ docker build -t ${ref} -t ${envRef} .`, build.stdout, build.stderr);
		if (build.exitCode !== 0) {
			return {
				ok: false,
				urls: [],
				deploymentId: null,
				log: sanitize(logLines.join("\n").trim()),
				outputs: { ...baseOutputs, pushed: "false" },
				errorMessage: `docker build failed (exit ${build.exitCode})`,
			};
		}

		// Push only when a token is present (GHCR auth is the operator's via env/CI):
		// the immutable ref first, then the environment tag that now points at it.
		let pushed = false;
		if (hasToken) {
			for (const pushRef of [ref, envRef]) {
				const push = await runCommand(["docker", "push", pushRef], ctx.worktreePath, ctx.secretEnv);
				logLines.push(`$ docker push ${pushRef}`, push.stdout, push.stderr);
				if (push.exitCode !== 0 || push.spawnFailed) {
					return {
						ok: false,
						urls: [],
						deploymentId: ref,
						log: sanitize(logLines.join("\n").trim()),
						outputs: { ...baseOutputs, pushed: "false" },
						errorMessage: `docker push failed (exit ${push.exitCode})`,
					};
				}
			}
			pushed = true;
		}

		return {
			ok: true,
			urls: [],
			deploymentId: ref,
			log: sanitize(logLines.join("\n").trim()),
			outputs: { ...baseOutputs, pushed: String(pushed) },
			errorMessage: null,
		};
	}

	async verify(ctx: DeployContext, deployment: DeployResult): Promise<VerifyResult> {
		const checks: VerifyResult["checks"] = [];
		const url = deployment.urls[0];

		if (url !== undefined && url !== "") {
			// Live URL: an HTTP GET that returns < 500 is "healthy" (4xx is reachable).
			try {
				const response = await fetch(url, { method: "GET", redirect: "manual" });
				const ok = response.status < 500;
				checks.push({
					name: "http-get",
					ok,
					detail: `GET ${url} -> ${response.status}`,
				});
				return { healthy: ok, checks, probedUrl: url };
			} catch (error) {
				checks.push({
					name: "http-get",
					ok: false,
					detail: `GET ${url} failed: ${sanitize((error as Error).message)}`,
				});
				return { healthy: false, checks, probedUrl: url };
			}
		}

		// No URL: confirm the built image exists locally.
		const ref = deployment.deploymentId ?? imageRef(ctx);
		const inspect = await runCommand(
			["docker", "image", "inspect", ref],
			ctx.worktreePath,
			ctx.secretEnv,
		);
		if (inspect.spawnFailed) {
			checks.push({
				name: "image-inspect",
				ok: false,
				detail: "docker CLI unavailable; cannot inspect image",
			});
			return { healthy: false, checks, probedUrl: null };
		}
		const ok = inspect.exitCode === 0;
		checks.push({
			name: "image-inspect",
			ok,
			detail: ok ? `image ${ref} present locally` : `image ${ref} not found locally`,
		});
		return { healthy: ok, checks, probedUrl: null };
	}

	/**
	 * Restore `deployment` — the previous release, resolved by the engine from the
	 * audit log — by re-pointing the environment tag at its immutable image and
	 * pushing that tag. Never falls back to the current image: a release with no
	 * recorded image ref cannot be restored and fails.
	 */
	async rollback(ctx: DeployContext, deployment: DeployResult): Promise<DeployResult> {
		const restoreRef = deployment.outputs.imageRef ?? deployment.deploymentId ?? "";
		// Re-point the environment tag in the restored image's own repository.
		const envRef = environmentRef(repositoryOf(restoreRef), ctx.environment);
		const failed = (log: string, errorMessage: string): DeployResult => ({
			ok: false,
			urls: [],
			deploymentId: null,
			log: sanitize(log.trim()),
			outputs: {
				imageRef: restoreRef,
				environmentRef: envRef,
				environment: ctx.environment,
				rolledBack: "false",
			},
			errorMessage,
		});
		if (restoreRef === "") {
			return failed("", "the release to restore has no recorded image ref");
		}
		const hasToken =
			typeof ctx.secretEnv[GHCR_TOKEN_KEY] === "string" && ctx.secretEnv[GHCR_TOKEN_KEY] !== "";

		if (ctx.dryRun) {
			return {
				ok: true,
				urls: [],
				deploymentId: null,
				log: sanitize(`[dry-run] would roll back by re-pointing ${envRef} at ${restoreRef}`),
				outputs: {
					imageRef: restoreRef,
					environmentRef: envRef,
					environment: ctx.environment,
					rolledBack: "planned",
				},
				errorMessage: null,
			};
		}

		const logLines: string[] = [];
		// Best-effort: confirm the previous image is present, re-tag it as the
		// environment's image, then push that tag.
		const inspect = await runCommand(
			["docker", "image", "inspect", restoreRef],
			ctx.worktreePath,
			ctx.secretEnv,
		);
		if (inspect.spawnFailed) {
			return failed(
				`docker is unavailable: ${inspect.stderr}`,
				"docker CLI not found or could not be spawned",
			);
		}
		logLines.push(`$ docker image inspect ${restoreRef}`, inspect.stdout, inspect.stderr);
		if (inspect.exitCode !== 0) {
			return failed(logLines.join("\n"), `previous image ${restoreRef} not available locally`);
		}

		const tag = await runCommand(
			["docker", "tag", restoreRef, envRef],
			ctx.worktreePath,
			ctx.secretEnv,
		);
		logLines.push(`$ docker tag ${restoreRef} ${envRef}`, tag.stdout, tag.stderr);
		if (tag.exitCode !== 0 || tag.spawnFailed) {
			return failed(logLines.join("\n"), `docker tag (rollback) failed (exit ${tag.exitCode})`);
		}

		let pushed = false;
		if (hasToken) {
			const push = await runCommand(["docker", "push", envRef], ctx.worktreePath, ctx.secretEnv);
			logLines.push(`$ docker push ${envRef}`, push.stdout, push.stderr);
			if (push.exitCode !== 0 || push.spawnFailed) {
				return failed(logLines.join("\n"), `docker push (rollback) failed (exit ${push.exitCode})`);
			}
			pushed = true;
		}

		return {
			ok: true,
			urls: [],
			deploymentId: restoreRef,
			log: sanitize(logLines.join("\n").trim()),
			outputs: {
				imageRef: restoreRef,
				environmentRef: envRef,
				environment: ctx.environment,
				pushed: String(pushed),
				rolledBack: "true",
			},
			errorMessage: null,
		};
	}

	buildSecretEnv(store: DeploySecretStore): Record<string, string> {
		const env: Record<string, string> = {};
		const token = store.get(GHCR_TOKEN_KEY);
		if (token !== undefined && token !== "") env[GHCR_TOKEN_KEY] = token;
		return env;
	}

	async preflight(
		ctx: DeployContext,
	): Promise<Array<{ name: string; ok: boolean; detail: string }>> {
		const checks: Array<{ name: string; ok: boolean; detail: string }> = [];

		const version = await runCommand(["docker", "--version"], ctx.worktreePath);
		if (version.spawnFailed) {
			checks.push({
				name: "docker-cli",
				ok: false,
				detail: "docker CLI not found on PATH",
			});
		} else if (version.exitCode === 0) {
			checks.push({
				name: "docker-cli",
				ok: true,
				detail: sanitize(version.stdout.trim()),
			});
		} else {
			checks.push({
				name: "docker-cli",
				ok: false,
				detail: `docker --version exited ${version.exitCode}`,
			});
		}

		const hasToken =
			typeof ctx.secretEnv[GHCR_TOKEN_KEY] === "string" && ctx.secretEnv[GHCR_TOKEN_KEY] !== "";
		checks.push({
			name: "ghcr-token",
			ok: hasToken,
			detail: hasToken ? "GHCR_TOKEN is set" : "GHCR_TOKEN is not set (required to push)",
		});

		return checks;
	}
}
