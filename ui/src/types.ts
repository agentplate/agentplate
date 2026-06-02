// TypeScript interfaces mirroring the Agentplate server API shapes.
//
// These are hand-maintained copies of the relevant fields from the server's
// src/types.ts — the UI is a separate Vite app and does not import server code,
// so we duplicate just the shapes the dashboard renders. Kept intentionally
// lenient on enum-ish string fields (state, status, type) so a new server value
// never breaks rendering; the UI styles known values and falls back gracefully.

/** Standard REST envelope: every /api/* response is wrapped in this. */
export interface JsonSuccess<T> {
	ok: true;
	data: T;
}
export interface JsonFailure {
	ok: false;
	error: { code?: string; message: string };
}
export type JsonEnvelope<T> = JsonSuccess<T> | JsonFailure;

/** Lifecycle state of an agent session. */
export type SessionState =
	| "booting"
	| "working"
	| "idle"
	| "completed"
	| "failed"
	| "stopped";

/** GET /api/overview */
export interface Overview {
	project: string;
	runtime: string;
	provider: string;
	model: string | null;
	deployTarget: string | null;
	currentRun: RunRecord | null;
	agentCount: number;
	activeCount: number;
}

/** GET /api/runs → RunRecord[] */
export interface RunRecord {
	id: string;
	createdAt: string;
	status: "active" | "completed";
	label?: string;
}

/** GET /api/agents → AgentSession[] */
export interface AgentSession {
	id: string;
	agentName: string;
	capability: string;
	taskId: string;
	runId: string;
	worktreePath: string;
	branchName: string;
	state: SessionState;
	parentAgent: string | null;
	depth: number;
	pid: number | null;
	runtimeSessionId: string | null;
	startedAt: string;
	lastActivity: string;
}

/** GET /api/events → EventRecord[] */
export interface EventRecord {
	id: string;
	agentName: string;
	runId: string | null;
	type: string;
	tool: string | null;
	detail: string | null;
	createdAt: string;
}

/** GET /api/mail → MailMessage[] */
export interface MailMessage {
	id: string;
	from: string;
	to: string;
	subject: string;
	body: string;
	type: string;
	priority: string;
	threadId: string | null;
	payload: string | null;
	read: boolean;
	createdAt: string;
}

/** GET /api/skills → SkillSummary[] */
export interface SkillSummary {
	slug: string;
	title: string;
	goal: string;
	status: "active" | "deprecated" | "quarantined" | string;
	confidence: number;
	appliedCount: number;
	successCount: number;
	version: number;
}

/** Capability guards reported per deploy target. */
export interface DeployCaps {
	canRollback: boolean;
	irreversible: boolean;
	environments: string[];
	requiresCredentials: boolean;
}

/** GET /api/deploy/targets → DeployTargetSummary[] */
export interface DeployTargetSummary {
	id: string;
	label: string;
	description: string;
	stability: "stable" | "beta" | "experimental" | string;
	caps: DeployCaps;
}

/** GET /api/deploy/history → DeployAuditRow[] */
export interface DeployAuditRow {
	id: string;
	runId: string | null;
	agentName: string;
	target: string;
	environment: string;
	action: "deploy" | "rollback" | string;
	dryRun: boolean;
	gateDecision: "auto" | "approved" | "denied" | "n/a" | string;
	approvedBy: string | null;
	status: "success" | "failed" | string;
	deploymentId: string | null;
	urls: string[];
	outputs: Record<string, string>;
	commitSha: string;
	createdAt: string;
}

/** Agents grouped into operator-facing status buckets. */
export interface StatusCounts {
	idle: number;
	working: number;
	completed: number;
	stalled: number;
}

/** GET /api/agents/:name — full per-agent detail. */
export interface AgentDetail {
	session: AgentSession | null;
	events: EventRecord[];
	inbox: MailMessage[];
	sent: MailMessage[];
	children: AgentSession[];
}

/** Derived status of a task. */
export type TaskStatus = "pending" | "active" | "done" | "failed" | string;

/** GET /api/tasks → TaskItem[] (also embedded in the WS snapshot). */
export interface TaskItem {
	taskId: string;
	status: TaskStatus;
	capabilities: string[];
	agents: string[];
	agentCount: number;
	lastActivity: string | null;
	summary: string | null;
}

/** GET /api/system — host metrics. */
export interface SystemMetrics {
	cpu: { cores: number; percent: number; loadAvg: [number, number, number] };
	memory: { usedBytes: number; totalBytes: number; percent: number };
	disk: { usedBytes: number | null; totalBytes: number | null; percent: number | null };
	uptimeSeconds: number;
	hostname: string;
	platform: string;
}

/** GET /api/costs — token/cost analytics (best-effort). */
export interface CostsReport {
	hasData: boolean;
	totalTokens: number;
	totalCostUsd: number;
	daily: Array<{ date: string; costUsd: number; tokens: number }>;
	byAgent: Array<{ agent: string; tokens: number; costUsd: number }>;
}

/** GET /api/handoffs → Handoff[] — protocol mail handed between agents. */
export interface Handoff {
	id: string;
	from: string;
	to: string;
	type: string;
	subject: string;
	body: string;
	threadId: string | null;
	createdAt: string;
}

/** GET /api/feed → FeedItem[] (also embedded in the WS snapshot). */
export interface FeedItem {
	kind: "event" | "mail";
	ts: string;
	agent: string;
	/** Compact 5-char event label (e.g. "TOOL+", "MAIL>", "DONE>"). */
	label: string;
	level: "info" | "warn" | "error";
	summary: string;
	detail?: string;
}

/** WebSocket /ws push payload (broadcast every 5s). */
export interface Snapshot {
	type: "snapshot";
	overview: Overview | null;
	agents: AgentSession[];
	statusCounts: StatusCounts;
	tasks: TaskItem[];
	feed: FeedItem[];
	ts: string;
}
