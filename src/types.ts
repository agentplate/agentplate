/**
 * Shared types and interfaces for Agentplate.
 *
 * ALL cross-module types live here so there is a single import site and no
 * circular dependencies between feature modules. Feature-local types that are
 * never shared may live in their own module, but anything referenced by more
 * than one subsystem belongs here.
 */

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Top-level Agentplate project configuration (`.agentplate/config.yaml`). */
export interface AgentplateConfig {
	project: ProjectConfig;
	runtime: RuntimeConfig;
	/** Id of the active provider (a key into {@link AgentplateConfig.providers}). */
	activeProvider: string;
	providers: Record<string, ProviderConfig>;
	agents: AgentsConfig;
	merge: MergeConfig;
	skills: SkillsConfig;
	deploy: DeployConfig;
	logging: LoggingConfig;
}

/** Build → CI/CD → Deploy configuration. */
export interface DeployConfig {
	/** Default deploy target id (e.g. "docker-gha"); empty until configured. */
	default: string;
	/** Per-target non-secret settings + secret env-var bindings. */
	targets: Record<string, DeployTargetConfig>;
	/** Per-environment gate policy: "confirm" requires approval, "auto" does not. */
	gates: Record<string, "confirm" | "auto">;
}

/** Non-secret settings + secret bindings for one deploy target. */
export interface DeployTargetConfig {
	/** Arbitrary non-secret settings (region, registry, cluster, app name…). */
	settings: Record<string, string | number | boolean>;
	/** Secret bindings: logical key → { fromEnv: ENV_VAR_NAME } (no values). */
	secretEnv: Record<string, { fromEnv: string }>;
	/** Environments this target deploys to. */
	environments: string[];
}

/** Self-improving skills behavior. */
export interface SkillsConfig {
	/** Master switch for retrieval + distillation. */
	enabled: boolean;
	/** Retrieval budget + count caps. */
	retrieval: {
		/** Max characters of skills injected into an overlay. */
		budgetChars: number;
		/** Max number of full-body skills injected (rest become summaries). */
		maxFull: number;
	};
	/** Distillation behavior. */
	distill: {
		/** Only distill when quality gates pass (recommended). */
		onlyOnGatesPass: boolean;
		/** Model override for the distiller (null = runtime default). */
		model: string | null;
	};
	/** Auto-pruning thresholds. */
	prune: {
		/** Quarantine when confidence drops below this (with >= minSamples). */
		quarantineBelow: number;
		minSamples: number;
		/** Delete quarantined skills older than this many days. */
		maxAgeDays: number;
	};
}

/** Identity and git context for the project being orchestrated. */
export interface ProjectConfig {
	/** Human-readable project name (auto-detected at init). */
	name: string;
	/** Absolute path to the project root. */
	root: string;
	/** Branch agent work is ultimately merged into (e.g. "main"). */
	canonicalBranch: string;
	/** Commands run at session-end to score an agent's work (test/lint/typecheck). */
	qualityGates?: QualityGate[];
}

/** A single quality gate: a named command whose exit code determines pass/fail. */
export interface QualityGate {
	name: string;
	command: string;
	description?: string;
}

/** Which coding-agent runtime drives workers, and per-capability overrides. */
export interface RuntimeConfig {
	/** Default runtime adapter id (e.g. "claude"). */
	default: string;
	/** Optional per-capability runtime overrides. */
	capabilities?: Partial<Record<Capability, string>>;
}

/**
 * How a provider's credentials are obtained:
 *  - `subscription`  — the runtime CLI's own login (e.g. Claude Pro/Max OAuth,
 *    `codex login`, `gcloud`/`gemini` auth). Agentplate stores NO key; auth is
 *    delegated to the already-logged-in CLI.
 *  - `api-key`       — a key Agentplate stores in the gitignored secrets file.
 *  - `env`           — a key Agentplate reads from an existing environment
 *    variable at run time (never stored).
 *  - `none`          — local/keyless provider (e.g. Ollama).
 */
export type AuthMode = "subscription" | "api-key" | "env" | "none";

/**
 * An AI provider (LLM backend). `native` providers are reached through the
 * runtime's own auth; `gateway` providers route through a base URL with a
 * bearer token read from the named environment variable.
 */
export interface ProviderConfig {
	type: "native" | "gateway";
	/** How credentials are obtained for this provider. */
	authMode?: AuthMode;
	/** Base URL for gateway providers. */
	baseUrl?: string;
	/** Name of the env var holding the auth token (value never stored in config). */
	authTokenEnv?: string;
	/** Default model id for this provider. */
	model?: string;
	/**
	 * Per-capability model overrides (tiering): e.g. a fast/cheap model for
	 * `scout`/`reviewer` and a strong model for `builder`. Falls back to `model`.
	 */
	models?: Partial<Record<Capability, string>>;
}

/** Orchestration limits and agent registry locations. */
export interface AgentsConfig {
	/** Path to the agent manifest, relative to project root. */
	manifestPath: string;
	/** Directory holding deployed base agent definitions, relative to root. */
	baseDir: string;
	/** Maximum agents running concurrently across the whole fleet. */
	maxConcurrent: number;
	/** Maximum delegation depth (coordinator → lead → worker = 2). */
	maxDepth: number;
	/** Maximum children a single lead may spawn. */
	maxAgentsPerLead: number;
	/**
	 * Terminate a worker after this many minutes with no activity (no streamed
	 * events and not between-turn progress) — the session is marked `stopped`, its
	 * process killed, and its worktree removed. The coordinator is never reaped.
	 * `0` disables idle reaping. Default 10.
	 */
	idleTimeoutMinutes: number;
	/**
	 * Hard wall-clock cap on a SINGLE turn, in minutes. Unlike idle reaping (which
	 * needs inactivity), this kills a turn that keeps streaming but never finishes.
	 * `0` disables the cap. Default 0.
	 */
	turnTimeoutMinutes: number;
	/** Default: leads skip the scout step (go straight to builders). */
	skipScout: boolean;
	/** Default: leads skip the reviewer step before integrating. */
	skipReview: boolean;
	/** Skip the post-turn quality-gate run (speed; disables `on-gates-pass` merge). */
	skipGates: boolean;
	/** Skip the post-turn skill-distillation loop. */
	skipSkills: boolean;
}

/**
 * When a completed worker's branch is auto-merged into the canonical branch.
 * - `off`: never (the operator/coordinator merges manually) — the default.
 * - `on-gates-pass`: merge only if the task's quality gates pass.
 * - `on-complete`: merge as soon as the agent finishes without error.
 */
export type AutoMergeMode = "off" | "on-gates-pass" | "on-complete";

/** Conflict-resolution and auto-merge behavior for merging agent branches. */
export interface MergeConfig {
	/** Allow AI-assisted resolution of semantic conflicts. */
	aiResolveEnabled: boolean;
	/** When to auto-merge a completed worker's branch into the canonical branch. */
	autoMerge: AutoMergeMode;
}

/** Logging behavior. */
export interface LoggingConfig {
	/** Emit verbose diagnostic output. */
	verbose: boolean;
	/** Redact secrets from logs and captured output. */
	redactSecrets: boolean;
}

// ---------------------------------------------------------------------------
// Agents & capabilities
// ---------------------------------------------------------------------------

/**
 * The role an agent plays. The orchestration core (Phase 2) uses the first
 * group; the delivery pipeline (Phase 4) adds `architect`/`devops`/`deployer`/
 * `verifier`. Declared here up front so config typing is stable across phases.
 */
export type Capability =
	| "scout"
	| "builder"
	| "reviewer"
	| "lead"
	| "merger"
	| "coordinator"
	| "architect"
	| "devops"
	| "deployer"
	| "verifier";

/** Every supported capability, in canonical order. */
export const SUPPORTED_CAPABILITIES: readonly Capability[] = [
	"scout",
	"builder",
	"reviewer",
	"lead",
	"merger",
	"coordinator",
	"architect",
	"devops",
	"deployer",
	"verifier",
];

// ---------------------------------------------------------------------------
// Outcomes (shared by quality gates, skills, and identity)
// ---------------------------------------------------------------------------

/** Result classification for a unit of work, threaded from quality gates. */
export type OutcomeStatus = "success" | "partial" | "failure";

// ---------------------------------------------------------------------------
// Model resolution (runtime ↔ provider bridge)
// ---------------------------------------------------------------------------

/** A concrete model id plus the env vars needed to reach it (API keys, base URLs). */
export interface ResolvedModel {
	/** Concrete model id passed to the runtime CLI. */
	model: string;
	/** Provider env vars to inject into the spawned process. */
	env?: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Runs & sessions
// ---------------------------------------------------------------------------

/** Lifecycle state of an agent session. */
export type SessionState = "booting" | "working" | "idle" | "completed" | "failed" | "stopped";

/** A run groups all agent sessions started by one coordinator session. */
export interface RunRecord {
	/** Run id, e.g. "run-20260531-140000". */
	id: string;
	createdAt: string;
	status: "active" | "completed";
	label?: string;
}

/** A single spawned agent worker (one row per agent in the sessions store). */
export interface AgentSession {
	/** Unique session id. */
	id: string;
	agentName: string;
	capability: Capability;
	taskId: string;
	runId: string;
	worktreePath: string;
	branchName: string;
	state: SessionState;
	/** Parent agent name (null for top-level spawns). */
	parentAgent: string | null;
	/** Delegation depth (coordinator = 0). */
	depth: number;
	/** OS process id of the most recent turn, if known. */
	pid: number | null;
	/** Runtime session id used for `--resume` across turns. */
	runtimeSessionId: string | null;
	startedAt: string;
	lastActivity: string;
}

// ---------------------------------------------------------------------------
// Mail
// ---------------------------------------------------------------------------

/** Protocol + semantic message types carried on the mail bus. */
export type MailType =
	| "dispatch"
	| "worker_done"
	| "worker_died"
	| "merge_ready"
	| "merged"
	| "merge_failed"
	| "escalation"
	| "health_check"
	| "assign"
	| "status"
	| "question"
	| "result"
	| "error"
	// Delivery-pipeline protocol messages (Phase 4).
	| "pipeline_ready"
	| "deploy_gate"
	| "deploy_done"
	| "deploy_failed"
	| "verify_done"
	| "verify_failed";

export type MailPriority = "low" | "normal" | "high" | "urgent";

/** A message on the SQLite mail bus. */
export interface MailMessage {
	id: string;
	from: string;
	to: string;
	subject: string;
	body: string;
	type: MailType;
	priority: MailPriority;
	/** Thread id for grouping replies (null starts a new thread). */
	threadId: string | null;
	/** Structured JSON payload for protocol messages (null otherwise). */
	payload: string | null;
	read: boolean;
	createdAt: string;
}

/** Fields accepted when sending a message (id/createdAt/read are assigned by the store). */
export interface NewMail {
	from: string;
	to: string;
	subject: string;
	body: string;
	type: MailType;
	priority?: MailPriority;
	threadId?: string | null;
	payload?: string | null;
}

// ---------------------------------------------------------------------------
// Events (observability)
// ---------------------------------------------------------------------------

/** A recorded agent event (tool call, lifecycle transition, error). */
export interface EventRecord {
	id: string;
	agentName: string;
	runId: string | null;
	/** e.g. "tool-start" | "tool-end" | "session-end" | "error". */
	type: string;
	/** Tool name for tool events (null otherwise). */
	tool: string | null;
	/** JSON-encoded detail (null otherwise). */
	detail: string | null;
	createdAt: string;
}

// ---------------------------------------------------------------------------
// Agent manifest
// ---------------------------------------------------------------------------

/** Static definition of one capability: which base .md, model, tools, constraints. */
export interface AgentDefinition {
	/** Base definition filename under the agent base dir (e.g. "builder.md"). */
	file: string;
	/** Model alias ("opus"/"sonnet"/"haiku") or a concrete model id. */
	model: string;
	/** Tools the agent is permitted to use. */
	tools: string[];
	/** Capabilities this definition provides. */
	capabilities: Capability[];
	/** May this agent spawn children? */
	canSpawn: boolean;
	/** Hard constraints injected into the overlay. */
	constraints: string[];
}

/** The agent registry, loaded from `.agentplate/agent-manifest.json`. */
export interface AgentManifest {
	version: string;
	agents: Partial<Record<Capability, AgentDefinition>>;
	/** Maps each capability to the definitions that provide it. */
	capabilityIndex: Partial<Record<Capability, Capability[]>>;
}

// ---------------------------------------------------------------------------
// Overlay (per-spawn instruction assembly)
// ---------------------------------------------------------------------------

/** Inputs to the dynamic overlay generator (the per-task instruction file). */
export interface OverlayConfig {
	agentName: string;
	capability: Capability;
	taskId: string;
	specPath?: string;
	branchName: string;
	worktreePath: string;
	parentAgent: string | null;
	depth: number;
	/** Exclusive file scope the agent owns (empty = no restriction). */
	fileScope: string[];
	/** Contents of the base .md definition (the HOW). */
	baseDefinition: string;
	canSpawn: boolean;
	qualityGates: QualityGate[];
	constraints: string[];
	/** Parallel sibling agent names (for rebase-before-merge guidance). */
	siblings?: string[];
	/** Reserved for Phase 3: retrieved skills block. */
	skillsOverlay?: string;
}

// ---------------------------------------------------------------------------
// Merge
// ---------------------------------------------------------------------------

/** Conflict-resolution tier applied (or predicted) for a merge. */
export type MergeTier = "clean-merge" | "auto-resolve" | "ai-resolve" | "reimagine";

export type MergeStatus = "pending" | "merged" | "failed";

/** A queued merge of an agent branch into a target branch. */
export interface MergeEntry {
	id: string;
	branchName: string;
	agentName: string;
	taskId: string;
	targetBranch: string;
	status: MergeStatus;
	createdAt: string;
}

/** Outcome of attempting (or predicting) a merge. */
export interface MergeResult {
	branchName: string;
	status: MergeStatus;
	/** The tier that resolved (or would resolve) the merge. */
	tier: MergeTier | null;
	conflictFiles: string[];
	message: string;
}

// ---------------------------------------------------------------------------
// Deploy audit
// ---------------------------------------------------------------------------

/** One append-only row in the deploy audit log (`deploys.db`). No secrets, ever. */
export interface DeployAuditRow {
	id: string;
	runId: string | null;
	agentName: string;
	target: string;
	environment: string;
	action: "deploy" | "rollback";
	dryRun: boolean;
	gateDecision: "auto" | "approved" | "denied" | "n/a";
	approvedBy: string | null;
	status: "success" | "failed";
	deploymentId: string | null;
	urls: string[];
	outputs: Record<string, string>;
	commitSha: string;
	createdAt: string;
}
