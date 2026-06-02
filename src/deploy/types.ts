/**
 * Deploy target adapter contract.
 *
 * A *DeployTarget* is the pluggable mechanism for shipping an app to one place
 * (Docker+GHA, a PaaS, a cloud, Kubernetes, on-prem). It mirrors the runtime
 * adapter split: pure mechanics, no AI, one file per target, resolved by a
 * registry. The staged agent pipeline (architect → builder → devops → deployer →
 * verifier) *calls* these methods; it never embeds target-specific shell.
 *
 * Secrets flow through {@link DeployTarget.buildSecretEnv} (env-by-name, never
 * hardcoded), exactly like the runtime adapters' `buildEnv`.
 */

/** A secret store handle: resolve a deploy secret value by its env-var name. */
export interface DeploySecretStore {
	/** Get a secret value by env-var name (file store, then process.env). */
	get(key: string): string | undefined;
	/** Is a secret available for this env-var name? */
	has(key: string): boolean;
}

/** What kind of app a target detected — drives config generation. Project-agnostic. */
export interface AppProfile {
	language:
		| "node"
		| "bun"
		| "python"
		| "go"
		| "rust"
		| "java"
		| "ruby"
		| "php"
		| "static"
		| "unknown";
	/** Framework if detectable (next, vite, fastapi, django, …). */
	framework: string | null;
	/** Long-running server | static site | batch job | serverless function. */
	kind: "service" | "static" | "job" | "function";
	/** Build command, or null when none is needed. */
	buildCommand: string | null;
	/** Start command for a service, or null. */
	startCommand: string | null;
	/** Listen port if known. */
	port: number | null;
	/** Detected lockfile family ("bun.lock", "package-lock.json", …). */
	packageManager: string | null;
	/** Runtime env var NAMES the app expects (never values). */
	runtimeEnvKeys: string[];
}

/** Result of {@link DeployTarget.detect}. */
export interface DetectResult {
	fit: boolean;
	/** 0..1 confidence used to rank targets when auto-selecting. */
	confidence: number;
	profile: AppProfile;
	reason: string;
}

/** A file the adapter wants written into the worktree. */
export interface GeneratedArtifact {
	/** Path RELATIVE to the worktree root (e.g. "Dockerfile"). */
	path: string;
	content: string;
	/** File mode (default 0o644). */
	mode?: number;
	kind: "dockerfile" | "ci" | "iac" | "manifest" | "helm" | "script" | "config" | "ignore";
}

/** Output of {@link DeployTarget.generateConfig}. */
export interface GeneratedConfig {
	artifacts: GeneratedArtifact[];
	/** Secret env-var NAMES this config needs at deploy time (names only). */
	requiredSecretKeys: string[];
	summary: string;
}

/** Everything a deploy/verify/rollback step needs. */
export interface DeployContext {
	target: string;
	/** "preview" | "staging" | "production" (extensible per target). */
	environment: string;
	worktreePath: string;
	projectRoot: string;
	profile: AppProfile;
	/** Resolved secret env (KEY→value). Never persisted, never logged. */
	secretEnv: Record<string, string>;
	/** Non-secret target settings from config. */
	settings: Record<string, string | number | boolean>;
	/** When true: generate + plan only; no outward-facing mutation. */
	dryRun: boolean;
	runId: string | null;
	agentName: string;
}

/** Result of a deploy/rollback execution. */
export interface DeployResult {
	ok: boolean;
	/** Live URL(s) the deploy produced (empty for non-URL targets). */
	urls: string[];
	/** Provider deployment id used by rollback (image digest, release, …). */
	deploymentId: string | null;
	/** Captured CLI output tail (already secret-redacted). */
	log: string;
	outputs: Record<string, string>;
	errorMessage: string | null;
}

/** Health/smoke-check outcome from {@link DeployTarget.verify}. */
export interface VerifyResult {
	healthy: boolean;
	checks: Array<{ name: string; ok: boolean; detail: string }>;
	probedUrl: string | null;
}

/** Capability guards declared by a target (checked by the engine before phases). */
export interface DeployCaps {
	canRollback: boolean;
	/** Irreversible in practice → always force a confirm gate. */
	irreversible: boolean;
	environments: string[];
	requiresCredentials: boolean;
}

/** The contract every deploy target implements (shaped like AgentRuntime). */
export interface DeployTarget {
	id: string;
	readonly stability: "stable" | "beta" | "experimental";
	readonly label: string;
	readonly description: string;
	readonly caps: DeployCaps;

	/** Inspect a project dir and decide fit + app profile. Read-only. */
	detect(projectDir: string): Promise<DetectResult>;

	/** Emit config artifacts (engine writes them, so --dry-run can diff). */
	generateConfig(ctx: DeployContext): Promise<GeneratedConfig>;

	/** Execute the deployment (the only outward-facing mutation; honors dryRun). */
	deploy(ctx: DeployContext): Promise<DeployResult>;

	/** Smoke-test / health-check the live target. Read-only. */
	verify(ctx: DeployContext, deployment: DeployResult): Promise<VerifyResult>;

	/** Best-effort rollback (caps.canRollback honest). */
	rollback(ctx: DeployContext, deployment: DeployResult): Promise<DeployResult>;

	/** Build the secret env map from named env vars (the deploy buildEnv). */
	buildSecretEnv(store: DeploySecretStore): Record<string, string>;

	/** Optional: verify CLI + creds without deploying (for doctor). */
	preflight?(ctx: DeployContext): Promise<Array<{ name: string; ok: boolean; detail: string }>>;
}
