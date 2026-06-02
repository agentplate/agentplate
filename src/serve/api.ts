/**
 * REST API surface for the web UI / TUI.
 *
 * Read-only JSON handlers over the existing SQLite stores (sessions, events,
 * mail, skills, deploy audit). No new persistence — the surfaces render the same
 * state the CLI reads. Every handler returns a plain JSON-serializable value;
 * the server (serve.ts) wraps it in the standard envelope.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../config.ts";
import { createDeployAudit } from "../deploy/audit.ts";
import { getAllDeployTargets } from "../deploy/registry.ts";
import { ValidationError } from "../errors.ts";
import { createEventStore } from "../events/store.ts";
import { createMailClient } from "../mail/client.ts";
import { currentRunPath, deploysDbPath, eventsDbPath, sessionsDbPath } from "../paths.ts";
import { createSessionStore } from "../sessions/store.ts";
import { createSkillStore } from "../skills/store.ts";

export interface ApiContext {
	root: string;
}

/** A single REST route: method + path matcher + handler returning JSON data. */
export interface ApiRoute {
	method: "GET";
	/** Path pattern, e.g. "/api/agents" or "/api/agents/:name". */
	pattern: string;
	handler: (ctx: ApiContext, params: Record<string, string>, query: URLSearchParams) => unknown;
}

/**
 * The active run every read surface agrees on: the id written to
 * `.agentplate/current-run.txt` by `coordinator start` / `sling` (authoritative),
 * falling back to the newest run in the store when the file is missing or stale.
 *
 * Centralizing this keeps the web UI, WS snapshot, and TUI all showing the SAME
 * run's agents — previously `/api/agents` returned every run's sessions while the
 * dashboard/TUI/overview used only the newest run, so the surfaces disagreed.
 */
export function resolveCurrentRunId(
	store: ReturnType<typeof createSessionStore>,
	root: string,
): string | null {
	const path = currentRunPath(root);
	if (existsSync(path)) {
		const id = readFileSync(path, "utf8").trim();
		if (id && store.getRun(id)) return id;
	}
	const latest = store.listRuns(1)[0];
	return latest ? latest.id : null;
}

/** Project + config summary for the overview screen. */
function overview(ctx: ApiContext): unknown {
	const config = loadConfig(ctx.root);
	const store = createSessionStore(sessionsDbPath(ctx.root));
	try {
		const currentRunId = resolveCurrentRunId(store, ctx.root);
		const currentRun = currentRunId ? store.getRun(currentRunId) : null;
		const sessions = currentRunId ? store.listSessions({ runId: currentRunId }) : [];
		const provider = config.providers[config.activeProvider];
		return {
			project: config.project.name,
			runtime: config.runtime.default,
			provider: config.activeProvider,
			model: provider?.model ?? null,
			deployTarget: config.deploy.default || null,
			currentRun,
			agentCount: sessions.length,
			activeCount: sessions.filter((s) => s.state === "working").length,
		};
	} finally {
		store.close();
	}
}

function runs(ctx: ApiContext): unknown {
	const store = createSessionStore(sessionsDbPath(ctx.root));
	try {
		return store.listRuns(50);
	} finally {
		store.close();
	}
}

function agents(ctx: ApiContext, _params: Record<string, string>, query: URLSearchParams): unknown {
	const store = createSessionStore(sessionsDbPath(ctx.root));
	try {
		// `?all=1` returns every run's sessions; otherwise scope to a specific
		// `?run=<id>` or, by default, the active run — so the live view matches the
		// dashboard/TUI instead of accumulating agents from every past run.
		if (query.get("all") === "1") return store.listSessions();
		const runId = query.get("run") ?? resolveCurrentRunId(store, ctx.root);
		return runId ? store.listSessions({ runId }) : [];
	} finally {
		store.close();
	}
}

function agentDetail(ctx: ApiContext, params: Record<string, string>): unknown {
	const store = createSessionStore(sessionsDbPath(ctx.root));
	const events = createEventStore(eventsDbPath(ctx.root));
	const mailClient = createMailClient(ctx.root);
	try {
		const name = params.name ?? "";
		const session = store.getSessionByAgent(name);
		const recentEvents = events.list({ agentName: name, limit: 50 });
		// Mail this agent sent and received — its handoff conversation.
		const inbox = mailClient.list({ to: name, limit: 50 });
		const sent = mailClient.list({ from: name, limit: 50 });
		// Children spawned by this agent (for the hierarchy view).
		const children = store.listSessions().filter((s) => s.parentAgent === name);
		return { session, events: recentEvents, inbox, sent, children };
	} finally {
		mailClient.close();
		events.close();
		store.close();
	}
}

function events(ctx: ApiContext, _params: Record<string, string>, query: URLSearchParams): unknown {
	const store = createEventStore(eventsDbPath(ctx.root));
	try {
		const limit = Number(query.get("limit") ?? "100");
		const agentName = query.get("agent") ?? undefined;
		return store.list({ agentName, limit });
	} finally {
		store.close();
	}
}

function mail(ctx: ApiContext, _params: Record<string, string>, query: URLSearchParams): unknown {
	const client = createMailClient(ctx.root);
	try {
		const to = query.get("to") ?? undefined;
		const from = query.get("from") ?? undefined;
		return client.list({ to, from, limit: 100 });
	} finally {
		client.close();
	}
}

/**
 * Protocol message types that represent an agent-to-agent HANDOFF (work moving
 * between roles), as opposed to general chatter. Surfaced on the Handoffs tab.
 */
const HANDOFF_TYPES = new Set<string>([
	"dispatch",
	"assign",
	"worker_done",
	"worker_died",
	"merge_ready",
	"merged",
	"merge_failed",
	"escalation",
	"pipeline_ready",
	"deploy_gate",
	"deploy_done",
	"deploy_failed",
	"verify_done",
	"verify_failed",
]);

/** GET /api/handoffs — protocol mail representing work handed between agents. */
function handoffs(
	ctx: ApiContext,
	_params: Record<string, string>,
	query: URLSearchParams,
): unknown {
	const limit = Number(query.get("limit") ?? "100");
	const client = createMailClient(ctx.root);
	try {
		return client
			.list({ limit: 300 })
			.filter((m) => HANDOFF_TYPES.has(m.type))
			.slice(0, limit)
			.map((m) => ({
				id: m.id,
				from: m.from,
				to: m.to,
				type: m.type,
				subject: m.subject,
				body: m.body,
				threadId: m.threadId,
				createdAt: m.createdAt,
			}));
	} finally {
		client.close();
	}
}

function skills(ctx: ApiContext): unknown {
	const store = createSkillStore(ctx.root);
	try {
		return store.list().map((s) => ({
			slug: s.slug,
			title: s.title,
			goal: s.goal,
			status: s.status,
			confidence: s.confidence,
			appliedCount: s.appliedCount,
			successCount: s.successCount,
			version: s.version,
		}));
	} finally {
		store.close();
	}
}

function deployTargets(): unknown {
	return getAllDeployTargets().map((t) => ({
		id: t.id,
		label: t.label,
		description: t.description,
		stability: t.stability,
		caps: t.caps,
	}));
}

function deployHistory(ctx: ApiContext): unknown {
	const audit = createDeployAudit(deploysDbPath(ctx.root));
	try {
		return audit.list({ limit: 100 });
	} finally {
		audit.close();
	}
}

/** Severity of a feed line, used for coloring (mirrors the terminal dashboard). */
export type FeedLevel = "info" | "warn" | "error";

/** A single entry in the live feed (an agent event or a mail message). */
export interface FeedItem {
	kind: "event" | "mail";
	ts: string;
	agent: string;
	/** Compact 5-char event label (e.g. "TOOL+", "MAIL>", "SESS-", "ERROR"). */
	label: string;
	level: FeedLevel;
	summary: string;
	detail?: string;
}

/**
 * Map a raw event/mail type to a compact 5-char label + level, mirroring the
 * original agentplate terminal feed (TOOL+/TOOL-, SESS+/SESS-, MAIL>/MAIL<, …).
 */
function eventLabel(type: string): { compact: string; level: FeedLevel } {
	const t = type.toLowerCase();
	const table: Record<string, { compact: string; level: FeedLevel }> = {
		"tool-start": { compact: "TOOL+", level: "info" },
		tool_use: { compact: "TOOL+", level: "info" },
		"tool-end": { compact: "TOOL-", level: "info" },
		tool_result: { compact: "TOOL-", level: "info" },
		"session-start": { compact: "SESS+", level: "info" },
		"session-end": { compact: "SESS-", level: "warn" },
		assistant: { compact: "MSG  ", level: "info" },
		result: { compact: "RSULT", level: "info" },
		error: { compact: "ERROR", level: "error" },
		spawn: { compact: "SPAWN", level: "info" },
	};
	return table[t] ?? { compact: type.slice(0, 5).toUpperCase().padEnd(5), level: "info" };
}

/** Map a mail protocol type to a label + level. */
function mailLabel(type: string): { compact: string; level: FeedLevel } {
	const t = type.toLowerCase();
	if (t.endsWith("_failed") || t === "error" || t === "worker_died")
		return { compact: "FAIL<", level: "error" };
	if (t === "escalation" || t === "deploy_gate") return { compact: "ESCL!", level: "warn" };
	if (t === "worker_done" || t === "merged" || t === "merge_ready" || t.endsWith("_done"))
		return { compact: "DONE>", level: "info" };
	if (t === "dispatch" || t === "assign") return { compact: "DISP>", level: "info" };
	return { compact: "MAIL>", level: "info" };
}

/**
 * Unified live feed: recent agent events (tool calls, lifecycle) + mail between
 * agents, merged newest-first. Drives the UI's live activity stream. Each item
 * carries a compact label + level so the UI can render a terminal-style stream.
 */
export function buildFeed(ctx: ApiContext, limit = 60): FeedItem[] {
	const items: FeedItem[] = [];
	const eventStore = createEventStore(eventsDbPath(ctx.root));
	try {
		for (const e of eventStore.list({ limit })) {
			const { compact, level } = eventLabel(e.type);
			const detail = [e.tool ? `tool=${e.tool}` : "", e.detail ?? ""].filter(Boolean).join(" ");
			items.push({
				kind: "event",
				ts: e.createdAt,
				agent: e.agentName,
				label: compact,
				level,
				summary: e.tool ? `${e.type} ${e.tool}` : e.type,
				...(detail ? { detail } : {}),
			});
		}
	} finally {
		eventStore.close();
	}
	const mailClient = createMailClient(ctx.root);
	try {
		for (const m of mailClient.list({ limit })) {
			const { compact, level } = mailLabel(m.type);
			items.push({
				kind: "mail",
				ts: m.createdAt,
				agent: m.from,
				label: compact,
				level,
				summary: `${m.from} → ${m.to}: ${m.subject}`,
				...(m.body ? { detail: m.body } : {}),
			});
		}
	} finally {
		mailClient.close();
	}
	items.sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0));
	return items.slice(0, limit);
}

function feed(ctx: ApiContext, _params: Record<string, string>, query: URLSearchParams): unknown {
	return buildFeed(ctx, Number(query.get("limit") ?? "60"));
}

/** Agents grouped into operator-facing status buckets, with counts. */
export function buildStatusCounts(ctx: ApiContext): {
	idle: number;
	working: number;
	completed: number;
	stalled: number;
} {
	const store = createSessionStore(sessionsDbPath(ctx.root));
	try {
		const runId = resolveCurrentRunId(store, ctx.root);
		const sessions = runId ? store.listSessions({ runId }) : [];
		const counts = { idle: 0, working: 0, completed: 0, stalled: 0 };
		for (const s of sessions) {
			if (s.state === "working" || s.state === "booting") counts.working++;
			else if (s.state === "idle") counts.idle++;
			else if (s.state === "completed") counts.completed++;
			else counts.stalled++; // failed | stopped
		}
		return counts;
	} finally {
		store.close();
	}
}

/** Derived status of a task, rolled up from its agent sessions. */
export type TaskStatus = "pending" | "active" | "done" | "failed";

/** A unit of work: a task id with its derived status + the agents on it. */
export interface TaskItem {
	taskId: string;
	status: TaskStatus;
	/** Capabilities working it (e.g. ["builder","reviewer"]). */
	capabilities: string[];
	/** Agent names assigned to this task. */
	agents: string[];
	agentCount: number;
	/** Most recent activity across the task's sessions, or null. */
	lastActivity: string | null;
	/** First line of the spec, when a spec file exists. */
	summary: string | null;
}

/**
 * Build the task list. A task is identified by its `taskId` and discovered from
 * two sources unioned together: spec files under `.agentplate/specs/` and the
 * distinct `taskId`s across agent sessions. Status rolls up from the sessions:
 *   - any session booting/working           → "active"
 *   - else all completed (≥1 session)        → "done"
 *   - else any failed/stopped (none active)  → "failed"
 *   - a spec with no session yet             → "pending"
 */
export function buildTasks(ctx: ApiContext): TaskItem[] {
	const store = createSessionStore(sessionsDbPath(ctx.root));
	const byTask = new Map<string, TaskItem>();
	try {
		// 1. Seed from spec files (so queued-but-unspawned tasks appear).
		const specsDir = join(ctx.root, ".agentplate", "specs");
		if (existsSync(specsDir)) {
			for (const file of readdirSync(specsDir)) {
				if (!file.endsWith(".md")) continue;
				const taskId = file.slice(0, -3);
				const summary = firstSpecLine(join(specsDir, file));
				byTask.set(taskId, {
					taskId,
					status: "pending",
					capabilities: [],
					agents: [],
					agentCount: 0,
					lastActivity: null,
					summary,
				});
			}
		}

		// 2. Fold in the agent sessions (current run only, like the rest of the UI).
		const runId = resolveCurrentRunId(store, ctx.root);
		const sessions = runId ? store.listSessions({ runId }) : [];
		for (const s of sessions) {
			if (!s.taskId || s.taskId === "coordination") continue;
			const existing = byTask.get(s.taskId) ?? {
				taskId: s.taskId,
				status: "pending" as TaskStatus,
				capabilities: [],
				agents: [],
				agentCount: 0,
				lastActivity: null,
				summary: null,
			};
			if (!existing.agents.includes(s.agentName)) {
				existing.agents.push(s.agentName);
				existing.agentCount = existing.agents.length;
			}
			if (!existing.capabilities.includes(s.capability)) {
				existing.capabilities.push(s.capability);
			}
			if (!existing.lastActivity || s.lastActivity > existing.lastActivity) {
				existing.lastActivity = s.lastActivity;
			}
			byTask.set(s.taskId, existing);
		}

		// 3. Roll up status from each task's sessions.
		for (const task of byTask.values()) {
			const taskSessions = sessions.filter((s) => s.taskId === task.taskId);
			if (taskSessions.length === 0) continue; // keep "pending" (spec only)
			const anyActive = taskSessions.some(
				(s) => s.state === "working" || s.state === "booting" || s.state === "idle",
			);
			const allDone = taskSessions.every((s) => s.state === "completed");
			const anyFailed = taskSessions.some((s) => s.state === "failed" || s.state === "stopped");
			task.status = anyActive ? "active" : allDone ? "done" : anyFailed ? "failed" : "active";
		}

		return [...byTask.values()].sort((a, b) => {
			// Active first, then by most recent activity.
			const rank = (t: TaskItem) => (t.status === "active" ? 0 : t.status === "pending" ? 1 : 2);
			if (rank(a) !== rank(b)) return rank(a) - rank(b);
			return (b.lastActivity ?? "") < (a.lastActivity ?? "") ? -1 : 1;
		});
	} finally {
		store.close();
	}
}

/** Read the first non-heading, non-blank line of a spec file (best-effort). */
function firstSpecLine(path: string): string | null {
	try {
		const text = readFileSync(path, "utf8");
		for (const line of text.split("\n")) {
			const trimmed = line.trim();
			if (trimmed && !trimmed.startsWith("#")) return trimmed.slice(0, 140);
		}
	} catch {
		// best-effort
	}
	return null;
}

function tasks(ctx: ApiContext): unknown {
	return buildTasks(ctx);
}

/** Token + cost analytics rolled up from events (best-effort). */
export interface CostsReport {
	/** Whether any token/cost data was found (else the UI shows an empty state). */
	hasData: boolean;
	totalTokens: number;
	totalCostUsd: number;
	/** Per-day cost trend (oldest→newest). */
	daily: Array<{ date: string; costUsd: number; tokens: number }>;
	/** Per-agent breakdown. */
	byAgent: Array<{ agent: string; tokens: number; costUsd: number }>;
}

/**
 * Build the costs report by aggregating per-turn token/cost events. Headless
 * turns record the runtime's reported usage (e.g. a Claude `result` event) into
 * the event store as detail JSON (`{ tokens, cost }`); this sums them by agent and
 * by day. When no usage has been recorded yet it returns `hasData:false` and the
 * UI renders the same charts with an empty state.
 */
export function buildCosts(ctx: ApiContext): CostsReport {
	const store = createEventStore(eventsDbPath(ctx.root));
	const byAgent = new Map<string, { tokens: number; costUsd: number }>();
	const byDay = new Map<string, { tokens: number; costUsd: number }>();
	let totalTokens = 0;
	let totalCostUsd = 0;
	try {
		for (const e of store.list({ limit: 5000 })) {
			let tokens = 0;
			let cost = 0;
			if (e.detail) {
				try {
					const d = JSON.parse(e.detail) as { tokens?: number; cost?: number; costUsd?: number };
					tokens = typeof d.tokens === "number" ? d.tokens : 0;
					cost =
						typeof d.cost === "number" ? d.cost : typeof d.costUsd === "number" ? d.costUsd : 0;
				} catch {
					// detail isn't JSON — no token data here.
				}
			}
			if (tokens === 0 && cost === 0) continue;
			totalTokens += tokens;
			totalCostUsd += cost;
			const a = byAgent.get(e.agentName) ?? { tokens: 0, costUsd: 0 };
			a.tokens += tokens;
			a.costUsd += cost;
			byAgent.set(e.agentName, a);
			const day = e.createdAt.slice(0, 10);
			const dd = byDay.get(day) ?? { tokens: 0, costUsd: 0 };
			dd.tokens += tokens;
			dd.costUsd += cost;
			byDay.set(day, dd);
		}
	} finally {
		store.close();
	}
	return {
		hasData: totalTokens > 0 || totalCostUsd > 0,
		totalTokens,
		totalCostUsd: Math.round(totalCostUsd * 10000) / 10000,
		daily: [...byDay.entries()]
			.sort((a, b) => (a[0] < b[0] ? -1 : 1))
			.map(([date, v]) => ({ date, costUsd: v.costUsd, tokens: v.tokens })),
		byAgent: [...byAgent.entries()]
			.map(([agent, v]) => ({ agent, tokens: v.tokens, costUsd: v.costUsd }))
			.sort((a, b) => b.costUsd - a.costUsd),
	};
}

function costs(ctx: ApiContext): unknown {
	return buildCosts(ctx);
}

/** The complete REST route table (read-only GET handlers). */
export const API_ROUTES: ApiRoute[] = [
	{ method: "GET", pattern: "/api/overview", handler: overview },
	{ method: "GET", pattern: "/api/runs", handler: runs },
	{ method: "GET", pattern: "/api/agents", handler: agents },
	{ method: "GET", pattern: "/api/agents/:name", handler: agentDetail },
	{ method: "GET", pattern: "/api/events", handler: events },
	{ method: "GET", pattern: "/api/mail", handler: mail },
	{ method: "GET", pattern: "/api/handoffs", handler: handoffs },
	{ method: "GET", pattern: "/api/tasks", handler: tasks },
	{ method: "GET", pattern: "/api/costs", handler: costs },
	{ method: "GET", pattern: "/api/feed", handler: feed },
	{ method: "GET", pattern: "/api/skills", handler: skills },
	{ method: "GET", pattern: "/api/deploy/targets", handler: deployTargets },
	{ method: "GET", pattern: "/api/deploy/history", handler: deployHistory },
];

/**
 * Match a request path against a route pattern, returning captured params or
 * null when no match. Supports `:param` segments.
 */
export function matchRoute(pattern: string, path: string): Record<string, string> | null {
	const pSegs = pattern.split("/").filter(Boolean);
	const aSegs = path.split("/").filter(Boolean);
	if (pSegs.length !== aSegs.length) return null;
	const params: Record<string, string> = {};
	for (let i = 0; i < pSegs.length; i++) {
		const p = pSegs[i] ?? "";
		const a = aSegs[i] ?? "";
		if (p.startsWith(":")) {
			params[p.slice(1)] = decodeURIComponent(a);
		} else if (p !== a) {
			return null;
		}
	}
	return params;
}

// ---------------------------------------------------------------------------
// Write actions (POST) — the interactive surface. Deliberately limited to
// messaging the coordinator and spawning a worker; no deploy/secrets/rollback.
// ---------------------------------------------------------------------------

/** POST /api/chat — message the coordinator over the mail bus. */
export function postChat(ctx: ApiContext, body: { message?: unknown }): unknown {
	const message = typeof body.message === "string" ? body.message.trim() : "";
	if (!message) throw new ValidationError("chat requires a non-empty `message`.");
	const client = createMailClient(ctx.root);
	try {
		const sent = client.send({
			from: "operator",
			to: "coordinator",
			subject: message.length > 60 ? `${message.slice(0, 57)}…` : message,
			body: message,
			type: "status",
		});
		return { sent };
	} finally {
		client.close();
	}
}

/**
 * POST /api/tasks — spawn a worker for a task. Runs `agentplate sling` as a
 * detached subprocess so the HTTP request returns immediately (a full agent turn
 * can take a while); the spawn's progress shows up in the live feed + status.
 */
export function postTask(
	ctx: ApiContext,
	body: { prompt?: unknown; taskId?: unknown; capability?: unknown },
): unknown {
	const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
	if (!prompt) throw new ValidationError("task requires a non-empty `prompt`.");
	const capability = typeof body.capability === "string" ? body.capability : "builder";
	const taskId =
		typeof body.taskId === "string" && body.taskId.trim()
			? body.taskId.trim()
			: `ui-${Date.now().toString(36)}`;

	// Record the task intent as a spec the worker reads, then sling detached.
	const specDir = join(ctx.root, ".agentplate", "specs");
	mkdirSync(specDir, { recursive: true });
	const specFile = join(specDir, `${taskId}.md`);
	writeFileSync(specFile, `# Task ${taskId}\n\n${prompt}\n`, "utf8");

	const proc = Bun.spawn(
		[
			"agentplate",
			"sling",
			taskId,
			"--capability",
			capability,
			"--spec",
			specFile,
			"--project",
			ctx.root,
		],
		{ cwd: ctx.root, stdout: "ignore", stderr: "ignore", stdin: "ignore" },
	);
	proc.unref();
	return { accepted: true, taskId, capability };
}

/** Resolve a path to a route + params, or null. */
export function resolveRoute(
	path: string,
): { route: ApiRoute; params: Record<string, string> } | null {
	for (const route of API_ROUTES) {
		const params = matchRoute(route.pattern, path);
		if (params) return { route, params };
	}
	return null;
}
