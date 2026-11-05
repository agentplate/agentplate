/**
 * Docker + GitHub Actions deploy target.
 *
 * The baseline, most-universal target: containerize the app and ship a GitHub
 * Actions workflow that builds the image, logs in to GHCR with the job's own
 * ephemeral `GITHUB_TOKEN`, and pushes a tag. It is the least
 * credential-coupled target — a local push needs a single `GHCR_TOKEN`, which
 * `docker login ghcr.io` reads from stdin — which makes it a sane default fit
 * for almost any web service or static site. Generated images run as a non-root
 * user, and every docker call is bounded by `dockerTimeoutSeconds`.
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
 *                      builds (and, when a token is present, logs in to GHCR
 *                      and pushes).
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

/** The single secret this target needs at deploy time (local GHCR push auth). */
const GHCR_TOKEN_KEY = "GHCR_TOKEN";

/** The only registry {@link GHCR_TOKEN_KEY} is ever sent to. */
const GHCR_REGISTRY = "ghcr.io";

/** Default container port when none can be inferred from the app. */
const DEFAULT_PORT = 3000;

/**
 * Default wall-clock cap for each `docker` invocation (build, login, push, …),
 * overridable per target with the `dockerTimeoutSeconds` setting (0 = no cap).
 */
const DEFAULT_DOCKER_TIMEOUT_SECONDS = 1800;

/** After SIGTERM on timeout, how long to wait before escalating to SIGKILL. */
const KILL_GRACE_MS = 5000;

/** After a timed-out child exits, how long to wait for its pipes to drain. */
const PIPE_DRAIN_GRACE_MS = 1000;

/** Result of running a subprocess (never throws on non-zero exit). */
interface ProcResult {
	stdout: string;
	stderr: string;
	exitCode: number;
	/** True when the binary itself could not be spawned (e.g. not installed). */
	spawnFailed: boolean;
	/** True when the child was killed for running past `timeoutMs`. */
	timedOut: boolean;
}

/** Per-invocation options for {@link runCommand}. */
interface RunCommandOptions {
	/** Written to the child's stdin (how a secret reaches `docker login`, never argv). */
	stdin?: string;
	/** Kill the child after this many ms; 0/undefined = no cap. */
	timeoutMs?: number;
}

/**
 * Run a command and capture its output. Mirrors the merge resolver's `runGit`:
 * non-zero exits are returned, not thrown, because callers branch on them. A
 * spawn failure (binary missing) is surfaced via `spawnFailed` rather than an
 * exception so deploy/verify can degrade gracefully. A child that outlives
 * `timeoutMs` is sent SIGTERM (then SIGKILL) and reported via `timedOut`.
 */
async function runCommand(
	argv: string[],
	cwd: string,
	opts: RunCommandOptions = {},
): Promise<ProcResult> {
	let proc: ReturnType<typeof spawnPiped>;
	try {
		proc = spawnPiped(argv, cwd, opts);
	} catch (error) {
		return {
			stdout: "",
			stderr: (error as Error).message,
			exitCode: -1,
			spawnFailed: true,
			timedOut: false,
		};
	}
	let timedOut = false;
	let killTimer: ReturnType<typeof setTimeout> | null = null;
	const timeoutMs = opts.timeoutMs ?? 0;
	const timer =
		timeoutMs > 0
			? setTimeout(() => {
					timedOut = true;
					proc.kill("SIGTERM");
					killTimer = setTimeout(() => proc.kill("SIGKILL"), KILL_GRACE_MS);
				}, timeoutMs)
			: null;
	const output = Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
	const exitCode = await proc.exited;
	if (timer) clearTimeout(timer);
	if (killTimer) clearTimeout(killTimer);
	if (!timedOut) {
		const [stdout, stderr] = await output;
		return { stdout, stderr, exitCode, spawnFailed: false, timedOut: false };
	}
	// A grandchild (e.g. the buildx plugin) can hold the pipes open after the CLI
	// is killed: take what drained within a short grace and stop waiting.
	const drained = await Promise.race([output, Bun.sleep(PIPE_DRAIN_GRACE_MS).then(() => null)]);
	const [stdout, stderr] = drained ?? ["", ""];
	const note = `timed out after ${timeoutMs / 1000}s; killed`;
	return {
		stdout,
		stderr: stderr === "" ? note : `${stderr}\n${note}`,
		exitCode,
		spawnFailed: false,
		timedOut: true,
	};
}

/** Spawn with piped output; stdin is the given string (closed after) or ignored. */
function spawnPiped(argv: string[], cwd: string, opts: RunCommandOptions) {
	return Bun.spawn(argv, {
		cwd,
		stdin: opts.stdin === undefined ? "ignore" : new Blob([opts.stdin]),
		stdout: "pipe",
		stderr: "pipe",
		env: process.env,
	});
}

/** True when the command ran to completion and exited 0. */
function succeeded(result: ProcResult): boolean {
	return !result.spawnFailed && !result.timedOut && result.exitCode === 0;
}

/** Human-readable failure for a docker step: timeout, else its exit code. */
function stepFailure(step: string, result: ProcResult): string {
	return result.timedOut
		? `${step} timed out (see the dockerTimeoutSeconds setting)`
		: `${step} failed (exit ${result.exitCode})`;
}

/**
 * The per-command docker timeout for a context, in ms (0 = no cap). Read from
 * the `dockerTimeoutSeconds` setting; a value that is not a non-negative number
 * is a config error, never silently ignored.
 */
function dockerTimeoutMs(ctx: DeployContext): number {
	const raw = ctx.settings.dockerTimeoutSeconds;
	if (raw === undefined) return DEFAULT_DOCKER_TIMEOUT_SECONDS * 1000;
	const seconds =
		typeof raw === "number"
			? raw
			: typeof raw === "string" && raw.trim() !== ""
				? Number(raw)
				: Number.NaN;
	if (!Number.isFinite(seconds) || seconds < 0) {
		throw new ValidationError(
			`docker-gha setting dockerTimeoutSeconds must be a non-negative number of seconds ` +
				`(0 = no cap), got ${JSON.stringify(raw)}`,
		);
	}
	return Math.round(seconds * 1000);
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

/**
 * The registry host an image ref pushes to, lowercased. Docker's rule: the first
 * path segment is a registry only if it has a `.` or `:` or is `localhost`;
 * otherwise the ref is a Docker Hub name.
 */
function registryHost(ref: string): string {
	const slash = ref.indexOf("/");
	const first = slash === -1 ? "" : ref.slice(0, slash);
	const isHost = first.includes(".") || first.includes(":") || first === "localhost";
	return isHost ? first.toLowerCase() : "docker.io";
}

/**
 * The username for `docker login ghcr.io`: the `username` setting, else the
 * owner segment of a `ghcr.io/<owner>/<image>` repo. GHCR authenticates the
 * token itself; the username only has to be non-empty.
 */
function ghcrUsername(ctx: DeployContext, repo: string): string {
	const configured = settingString(ctx.settings, "username")?.trim();
	if (configured !== undefined && configured !== "") return configured;
	const parts = repo.split("/");
	const owner = parts.length > 2 ? parts[1] : undefined;
	return owner !== undefined && owner !== "" ? owner : "agentplate";
}

/**
 * Authenticate the local docker CLI to GHCR with `GHCR_TOKEN` before a push. The
 * token goes over stdin (`--password-stdin`), never argv or env. Returns null on
 * success (or when there is nothing to log in to), else the failure message.
 * The token is only ever sent to ghcr.io: a push to any other registry relies on
 * that registry's existing `docker login`.
 */
async function loginForPush(
	ctx: DeployContext,
	pushRef: string,
	timeoutMs: number,
	logLines: string[],
): Promise<string | null> {
	const token = ctx.secretEnv[GHCR_TOKEN_KEY];
	if (token === undefined || token === "") return null;
	const registry = registryHost(pushRef);
	if (registry !== GHCR_REGISTRY) {
		logLines.push(
			`(registry ${registry} is not ${GHCR_REGISTRY}: GHCR_TOKEN is not sent to it; ` +
				"pushing with its existing docker login)",
		);
		return null;
	}
	const username = ghcrUsername(ctx, repositoryOf(pushRef));
	const login = await runCommand(
		["docker", "login", GHCR_REGISTRY, "--username", username, "--password-stdin"],
		ctx.worktreePath,
		{ stdin: token, timeoutMs },
	);
	logLines.push(
		`$ docker login ${GHCR_REGISTRY} --username ${username} --password-stdin`,
		login.stdout,
		login.stderr,
	);
	return succeeded(login) ? null : stepFailure(`docker login ${GHCR_REGISTRY}`, login);
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

/**
 * The unprivileged user each service base image ships (`node:*` has `node`,
 * `oven/bun:*` has `bun`). Service images drop root and run as it.
 */
function runtimeUser(profile: AppProfile): string {
	return profile.language === "bun" ? "bun" : "node";
}

/**
 * nginx image for static sites: the official unprivileged variant runs as a
 * non-root user and therefore listens on 8080, not 80.
 */
const STATIC_NGINX_IMAGE = "nginxinc/nginx-unprivileged:1.27-alpine";
const STATIC_NGINX_PORT = 8080;

/** Multi-stage Dockerfile for a built Node/Bun service. */
function dockerfileBuiltService(profile: AppProfile): string {
	const isBun = profile.language === "bun";
	const baseImage = isBun ? "oven/bun:1" : "node:22-slim";
	const user = runtimeUser(profile);
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
		`# Run as the base image's unprivileged user, never root.`,
		`RUN chown ${user}:${user} /app`,
		`COPY --from=builder --chown=${user}:${user} /app /app`,
		`USER ${user}`,
		`EXPOSE ${port}`,
		`CMD ${dockerExecForm(startCmd)}`,
		``,
	].join("\n");
}

/** Single-stage Dockerfile for a Node/Bun service that needs no build step. */
function dockerfilePlainService(profile: AppProfile): string {
	const isBun = profile.language === "bun";
	const baseImage = isBun ? "oven/bun:1" : "node:22-slim";
	const user = runtimeUser(profile);
	const installCmd = isBun ? "bun install --frozen-lockfile" : "npm ci --omit=dev";
	const startCmd = profile.startCommand ?? (isBun ? "bun run start" : "npm run start");
	const port = profile.port ?? DEFAULT_PORT;
	return [
		`# syntax=docker/dockerfile:1`,
		`# Single-stage image for a ${profile.framework ?? profile.language} service.`,
		`FROM ${baseImage}`,
		`ENV NODE_ENV=production`,
		`WORKDIR /app`,
		`# Run as the base image's unprivileged user, never root.`,
		`RUN chown ${user}:${user} /app`,
		`COPY --chown=${user}:${user} . .`,
		`RUN ${installCmd}`,
		`USER ${user}`,
		`EXPOSE ${port}`,
		`CMD ${dockerExecForm(startCmd)}`,
		``,
	].join("\n");
}

/**
 * Dockerfile that serves a static site via unprivileged nginx. A built site
 * (Vite/CRA) is compiled in a builder stage and only its output directory is
 * published; a bare site (no build tooling) publishes the context, which its
 * generated `.dockerignore` strips of dotfiles and credentials.
 */
function dockerfileStatic(profile: AppProfile): string {
	const isBun = profile.language === "bun";
	const baseImage = isBun ? "oven/bun:1" : "node:22-slim";
	const installCmd = isBun ? "bun install --frozen-lockfile" : "npm ci";
	const buildCmd = profile.buildCommand ?? (isBun ? "bun run build" : "npm run build");
	// Vite emits dist/, CRA emits build/. Default to dist for everything else.
	const outDir = profile.framework === "cra" ? "build" : "dist";
	const builderStage =
		profile.language === "static"
			? // No build tooling: the (dockerignore-filtered) context is the site.
				[`FROM ${STATIC_NGINX_IMAGE}`, `COPY . /usr/share/nginx/html`]
			: [
					`FROM ${baseImage} AS builder`,
					`WORKDIR /app`,
					`COPY . .`,
					`RUN ${installCmd}`,
					`RUN ${buildCmd}`,
					``,
					`FROM ${STATIC_NGINX_IMAGE}`,
					`# Publish only the build output, never the sources.`,
					`COPY --from=builder /app/${outDir} /usr/share/nginx/html`,
				];
	return [
		`# syntax=docker/dockerfile:1`,
		`# Static site served by non-root nginx${profile.language === "static" ? "" : " (built from source)"}.`,
		...builderStage,
		`EXPOSE ${STATIC_NGINX_PORT}`,
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

/**
 * Credential files that must never enter a build context (and so never a layer
 * of a pushed image), matched at any depth. Includes agentplate's own
 * `secrets.local.yaml` / `config.local.yaml` and registry auth like `.npmrc`.
 */
const SECRET_IGNORE_PATTERNS = [
	"**/.env",
	"**/.env.*",
	"**/.npmrc",
	"**/.netrc",
	"**/.pypirc",
	"**/.aws",
	"**/.ssh",
	"**/secrets.local.yaml",
	"**/*.local.yaml",
	"**/*.pem",
	"**/*.key",
	"**/*.p12",
	"**/*.pfx",
];

/**
 * Standard `.dockerignore` keeping the build context small + secret-free. A
 * bare static site publishes its context as-is, so it additionally drops every
 * dotfile/dot-directory (keeping `.well-known/`) and does not re-include
 * `.env.example`, which nginx would otherwise serve publicly.
 */
function renderDockerignore(profile: AppProfile): string {
	const bareStatic = profile.language === "static";
	return [
		"# Generated by agentplate: keep the build context small and secret-free.",
		".git",
		".gitignore",
		".github",
		".agentplate",
		"node_modules",
		"npm-debug.log",
		"bun-debug.log",
		"Dockerfile",
		".dockerignore",
		"*.md",
		"dist",
		"build",
		".next",
		"coverage",
		".DS_Store",
		"",
		"# Credentials never enter the image.",
		...SECRET_IGNORE_PATTERNS,
		...(bareStatic
			? ["", "# Served publicly as-is: no dotfiles except .well-known.", "**/.*", "!.well-known"]
			: ["!.env.example"]),
		"",
	].join("\n");
}

/**
 * `actions/checkout`, pinned to a full commit sha (verified with
 * `git ls-remote --tags https://github.com/actions/checkout`). It is the only
 * action the generated workflow uses: everything else is the runner's own
 * docker CLI, so no third-party action ever sees a token.
 */
const CHECKOUT_ACTION = "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1";

/**
 * GitHub Actions workflow: build the image with the runner's docker CLI, log in
 * to GHCR with the job's ephemeral `GITHUB_TOKEN` (`packages: write`, no
 * long-lived PAT), and push it tagged with the commit being built (`github.sha`)
 * plus the moving environment tag. Exposes an `environment` input so the same
 * workflow drives preview/staging/production. `ctx.environment` must already be
 * validated (see {@link assertKnownEnvironment}).
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

# Least privilege: no token scopes by default; the job asks only for its own.
permissions: {}

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
        uses: ${CHECKOUT_ACTION}
        with:
          persist-credentials: false

      # The job's ephemeral GITHUB_TOKEN (packages: write) authenticates the push,
      # over stdin; no long-lived PAT and no third-party action ever sees it.
      - name: Log in to GHCR
        env:
          REGISTRY_TOKEN: \${{ secrets.GITHUB_TOKEN }}
        run: printf '%s' "$REGISTRY_TOKEN" | docker login ghcr.io --username "$GITHUB_ACTOR" --password-stdin

      - name: Build image
        run: docker build --tag "$IMAGE_REF" --tag "$ENVIRONMENT_REF" .

      - name: Push image
        run: |
          docker push "$IMAGE_REF"
          docker push "$ENVIRONMENT_REF"

      - name: Log out of GHCR
        if: always()
        run: docker logout ghcr.io
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
		"logs in to GHCR with the job's GITHUB_TOKEN, and pushes a tagged image. The most " +
		"universal, least credential-coupled target (local pushes need a single GHCR_TOKEN).";
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
		// Reject a bad timeout setting now, before the engine writes any artifact.
		dockerTimeoutMs(ctx);
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
			{ path: ".dockerignore", content: renderDockerignore(profile), kind: "ignore" },
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
			`.dockerignore, and a GitHub Actions deploy workflow (GHCR push with the job's ` +
			`GITHUB_TOKEN, environment=${ctx.environment}). Local deploys push with secret GHCR_TOKEN.`;
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
		// No secret reaches build/push env: docker reads none from it, and the
		// token goes to `docker login` over stdin only.
		const timeoutMs = dockerTimeoutMs(ctx);
		const logLines: string[] = [];
		const build = await runCommand(
			["docker", "build", "-t", ref, "-t", envRef, "."],
			ctx.worktreePath,
			{ timeoutMs },
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
		if (!succeeded(build)) {
			return {
				ok: false,
				urls: [],
				deploymentId: null,
				log: sanitize(logLines.join("\n").trim()),
				outputs: { ...baseOutputs, pushed: "false" },
				errorMessage: stepFailure("docker build", build),
			};
		}

		// Push only when a token is present, after logging in to GHCR with it: the
		// immutable ref first, then the environment tag that now points at it.
		let pushed = false;
		if (hasToken) {
			const pushFailed = (errorMessage: string): DeployResult => ({
				ok: false,
				urls: [],
				deploymentId: ref,
				log: sanitize(logLines.join("\n").trim()),
				outputs: { ...baseOutputs, pushed: "false" },
				errorMessage,
			});
			const loginError = await loginForPush(ctx, ref, timeoutMs, logLines);
			if (loginError !== null) return pushFailed(loginError);
			for (const pushRef of [ref, envRef]) {
				const push = await runCommand(["docker", "push", pushRef], ctx.worktreePath, {
					timeoutMs,
				});
				logLines.push(`$ docker push ${pushRef}`, push.stdout, push.stderr);
				if (!succeeded(push)) return pushFailed(stepFailure("docker push", push));
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
		const inspect = await runCommand(["docker", "image", "inspect", ref], ctx.worktreePath, {
			timeoutMs: dockerTimeoutMs(ctx),
		});
		if (inspect.spawnFailed) {
			checks.push({
				name: "image-inspect",
				ok: false,
				detail: "docker CLI unavailable; cannot inspect image",
			});
			return { healthy: false, checks, probedUrl: null };
		}
		const ok = succeeded(inspect);
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

		const timeoutMs = dockerTimeoutMs(ctx);
		const logLines: string[] = [];
		// Best-effort: confirm the previous image is present, re-tag it as the
		// environment's image, then push that tag.
		const inspect = await runCommand(["docker", "image", "inspect", restoreRef], ctx.worktreePath, {
			timeoutMs,
		});
		if (inspect.spawnFailed) {
			return failed(
				`docker is unavailable: ${inspect.stderr}`,
				"docker CLI not found or could not be spawned",
			);
		}
		logLines.push(`$ docker image inspect ${restoreRef}`, inspect.stdout, inspect.stderr);
		if (!succeeded(inspect)) {
			return failed(logLines.join("\n"), `previous image ${restoreRef} not available locally`);
		}

		const tag = await runCommand(["docker", "tag", restoreRef, envRef], ctx.worktreePath, {
			timeoutMs,
		});
		logLines.push(`$ docker tag ${restoreRef} ${envRef}`, tag.stdout, tag.stderr);
		if (!succeeded(tag)) {
			return failed(logLines.join("\n"), stepFailure("docker tag (rollback)", tag));
		}

		let pushed = false;
		if (hasToken) {
			const loginError = await loginForPush(ctx, envRef, timeoutMs, logLines);
			if (loginError !== null) return failed(logLines.join("\n"), loginError);
			const push = await runCommand(["docker", "push", envRef], ctx.worktreePath, { timeoutMs });
			logLines.push(`$ docker push ${envRef}`, push.stdout, push.stderr);
			if (!succeeded(push)) {
				return failed(logLines.join("\n"), stepFailure("docker push (rollback)", push));
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
			detail: hasToken
				? "GHCR_TOKEN is set"
				: "GHCR_TOKEN is not set (required for a local push; the CI workflow uses GITHUB_TOKEN)",
		});

		return checks;
	}
}
