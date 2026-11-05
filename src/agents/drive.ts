/**
 * driveTurn — run ONE headless turn for an agent and handle its aftermath.
 *
 * This is the shared core behind both the first turn (`sling`, which opens a
 * fresh runtime session) and every follow-up turn (`agentplate turn`, which
 * **resumes** the session via `runtimeSessionId` so turns 2+ do not pay the
 * runtime's cold-start cost — the "warm start"). Keeping it in one place means
 * the post-turn handling (state transition, the self-improving skills loop, and
 * auto-merge) is identical no matter which turn it is.
 *
 * Spawn-per-turn is preserved: each call spawns a fresh runtime subprocess
 * (resumed when `resumeSessionId` is given) — there is no long-lived agent.
 */

import { existsSync } from "node:fs";
import { ValidationError } from "../errors.ts";
import type { EventStore } from "../events/store.ts";
import { runQualityGates } from "../insights/quality-gates.ts";
import { createLogger } from "../logging/logger.ts";
import { sanitize } from "../logging/sanitizer.ts";
import {
	AGENT_IDENTITY_ENV,
	formatInjection,
	type MailClient,
	OPERATOR_SENDER,
} from "../mail/client.ts";
import { createMailStore } from "../mail/store.ts";
import { maybeAutoMerge } from "../merge/auto.ts";
import { mailDbPath, manifestFilePath } from "../paths.ts";
import { getRuntime, runtimeNameForCapability } from "../runtimes/registry.ts";
import { resolveModel } from "../runtimes/resolve.ts";
import type { AgentRuntime } from "../runtimes/types.ts";
import type { SessionStore } from "../sessions/store.ts";
import { runSkillFeedbackAndDistill } from "../skills/lifecycle.ts";
import type {
	AgentplateConfig,
	AgentSession,
	Capability,
	MailMessage,
	OutcomeStatus,
	ResolvedModel,
	SessionState,
} from "../types.ts";
import { updateIdentity } from "./identity.ts";
import { buildDefaultManifest, getDefinition, loadManifest } from "./manifest.ts";
import { runTurn, type TurnResult } from "./turn-runner.ts";

/** Terminal mail types whose presence marks a capability's work complete. */
export function terminalTypesFor(capability: Capability): string[] {
	return capability === "merger" ? ["merged", "merge_failed"] : ["worker_done"];
}

/** Max chars of runtime error/stderr text recorded per event. */
const MAX_ERROR_DETAIL = 1000;

/**
 * Redact secrets from runtime error text, then bound it, before it is stored in
 * events.db (and fanned out to the web UI / TUI). Redact first so truncation can
 * never leave a partial — and no-longer-matching — secret behind.
 */
function errorDetail(text: string): string {
	const clean = sanitize(text);
	return clean.length > MAX_ERROR_DETAIL ? `${clean.slice(0, MAX_ERROR_DETAIL)}…` : clean;
}

/** Warnings for best-effort post-turn steps that failed (stderr, so `--json` stdout stays clean). */
const log = createLogger({ scope: "drive" });

/** Supervisors a terminal report may be addressed to besides the agent's own parent. */
const SUPERVISORS: ReadonlySet<string> = new Set(["coordinator", OPERATOR_SENDER]);

/** Which terminal mail may complete a turn (see {@link resolveFinalState}). */
export interface TerminalMailScope {
	/**
	 * ISO time the turn started: only terminal mail stamped strictly after it counts.
	 * Strict, so mail from an earlier turn in the same millisecond is never taken for
	 * this one; the agent can't send anything within a millisecond of its spawn.
	 */
	since: string;
	/** The agent's parent, if any: a terminal report must be addressed to it (or a supervisor). */
	parent: string | null;
}

/**
 * Resolve a turn's end state from the agent's own mail + exit code:
 * - non-zero exit → `failed` (whatever mail it sent: no gates/skills/merge on it)
 * - clean exit + terminal mail it sent THIS turn to its parent (or the
 *   coordinator/operator) → `completed`
 * - clean exit otherwise → `idle` (paused, awaiting its next turn)
 *
 * The `from` of mail an agent sends via the CLI is stamped with its own identity
 * (`resolveSender`), so a sibling can't send terminal mail "from" this agent, and
 * a stale `worker_done` from an earlier turn can't complete a later one.
 */
export function resolveFinalState(
	root: string,
	name: string,
	capability: Capability,
	exitCode: number,
	scope: TerminalMailScope,
): SessionState {
	if (exitCode !== 0) return "failed";
	const terminal = terminalTypesFor(capability);
	const store = createMailStore(mailDbPath(root));
	try {
		const reported = store
			.list({ from: name })
			.some(
				(m) =>
					terminal.includes(m.type) &&
					m.createdAt > scope.since &&
					(m.to === scope.parent || SUPERVISORS.has(m.to)),
			);
		return reported ? "completed" : "idle";
	} finally {
		store.close();
	}
}

/**
 * A best-effort post-turn step (gates, skills loop, auto-merge) failed: make it
 * visible as a sanitized error event plus a stderr warning instead of swallowing
 * it. Never throws — the turn's outcome must not hinge on reporting.
 */
function reportPostTurnFailure(
	events: EventStore,
	agentName: string,
	runId: string,
	step: string,
	error: unknown,
): void {
	const message = error instanceof Error ? error.message : String(error);
	const detail = errorDetail(`${step} failed: ${message}`);
	try {
		log.warn(`${agentName}: ${detail}`);
		events.record({ agentName, runId, type: "error", tool: null, detail });
	} catch {
		// The event store itself is broken; nothing more can be done here.
	}
}

export interface DriveTurnCtx {
	root: string;
	config: AgentplateConfig;
	runtime: AgentRuntime;
	store: SessionStore;
	events: EventStore;
	mail: MailClient;
	/** The session this turn runs for (existing or just-created). */
	session: AgentSession;
	/** Resolved concrete model + provider env for this capability. */
	model: ResolvedModel;
	/**
	 * The user-turn text (dispatch / injected mail / nudge). Pass a function when
	 * building it consumes mail (checkInject marks it read): it is called only
	 * after this driver has claimed the turn, so a losing driver delivers nothing.
	 */
	prompt: string | (() => string);
	/** Prior runtime session id to resume — omit on the first turn (warm start). */
	resumeSessionId?: string;
	/** Called right after the runtime child spawns (not when the spawn fails). */
	onSpawn?: () => void;
}

export interface DriveTurnResult {
	finalState: SessionState;
	exitCode: number;
	gateStatus: OutcomeStatus | null;
}

/** Run one turn for `ctx.session` and apply the post-turn lifecycle. */
export async function driveTurn(ctx: DriveTurnCtx): Promise<DriveTurnResult> {
	const { root, config, runtime, store, events, mail, session, model } = ctx;
	const {
		id: sessionId,
		agentName: name,
		capability,
		taskId,
		runId,
		worktreePath,
		branchName,
	} = session;

	// Atomic claim (idle/booting → working): of two drivers racing for the same
	// agent (`watch` + a manual `turn`, two watchers…) exactly one proceeds.
	if (!store.claimTurn(sessionId)) {
		const current = store.getSession(sessionId)?.state ?? "gone";
		throw new ValidationError(
			`Agent "${name}" is ${current}; its turn was already claimed or it is no longer idle.`,
		);
	}

	// Spawn → final state runs under try/finally: if the spawn throws (runtime
	// binary missing, worktree gone) or anything before the final state lands
	// fails, the session must not be stranded `working` — it would hold a
	// concurrency slot and keep `watch --until-idle` looping forever.
	let pid: number | null = null;
	let settled = false;
	let turn: TurnResult;
	let finalState: SessionState;
	try {
		let sawError = false;
		// Only terminal mail sent from here on can complete this turn.
		const turnStartedAt = new Date().toISOString();
		const prompt = typeof ctx.prompt === "function" ? ctx.prompt() : ctx.prompt;
		turn = await runTurn({
			runtime,
			worktreePath,
			model: model.model,
			prompt,
			// The agent's own identity: `agentplate mail` inside the turn sends as it.
			env: { ...model.env, [AGENT_IDENTITY_ENV]: name },
			baseUrl: model.baseUrl,
			authMode: model.authMode,
			resumeSessionId: ctx.resumeSessionId,
			timeoutMs:
				config.agents.turnTimeoutMinutes > 0
					? config.agents.turnTimeoutMinutes * 60_000
					: undefined,
			onSpawn: (childPid) => {
				// Recorded so the reaper can tell a live (if quiet) turn from a dead one.
				pid = childPid;
				store.setPid(sessionId, childPid);
				ctx.onSpawn?.();
			},
			onEvent: (event) => {
				if (event.error || event.type === "error") sawError = true;
				// Prefer the error message (so a failed agent's reason is visible in the
				// feed/logs), else the token/cost JSON the Costs page aggregates.
				const detail = event.error
					? errorDetail(event.error)
					: event.usage
						? JSON.stringify({ tokens: event.usage.tokens, cost: event.usage.costUsd })
						: null;
				events.record({
					agentName: name,
					runId,
					type: event.type,
					tool: event.tool ?? null,
					detail,
				});
				// Bump last_activity on every streamed event so a long but active turn
				// keeps itself fresh and is never reaped as "idle".
				store.touch(sessionId);
			},
		});
		// The child has exited: clear its pid at once so it is never taken for live.
		pid = null;
		store.setPid(sessionId, null);
		if (turn.runtimeSessionId) store.setRuntimeSessionId(sessionId, turn.runtimeSessionId);

		// Record a clear reason when the wall-clock cap killed the turn.
		if (turn.timedOut) {
			events.record({
				agentName: name,
				runId,
				type: "error",
				tool: null,
				detail: `Turn killed: exceeded agents.turnTimeoutMinutes (${config.agents.turnTimeoutMinutes}m).`,
			});
		}

		// A non-zero exit with no error event means the runtime failed via stderr;
		// record it so the failure reason is visible instead of a blank "failed".
		if (turn.exitCode !== 0 && !sawError) {
			const reason = turn.stderr.trim();
			if (reason) {
				events.record({
					agentName: name,
					runId,
					type: "error",
					tool: null,
					detail: errorDetail(reason),
				});
			}
		}

		const resolved = resolveFinalState(root, name, capability, turn.exitCode, {
			since: turnStartedAt,
			parent: session.parentAgent,
		});
		// Compare-and-set: a session stopped mid-turn (`agentplate stop`) stays
		// stopped — never resurrected, and no gates/skills/auto-merge run for it.
		if (!store.transitionSessionState(sessionId, "working", resolved)) {
			settled = true;
			const current = store.getSession(sessionId)?.state ?? "stopped";
			return { finalState: current, exitCode: turn.exitCode, gateStatus: null };
		}
		finalState = resolved;
		settled = true;
	} catch (error) {
		try {
			const message = error instanceof Error ? error.message : String(error);
			events.record({
				agentName: name,
				runId,
				type: "error",
				tool: null,
				detail: errorDetail(`Turn failed: ${message}`),
			});
		} catch {
			// Recording is best-effort; the original error is rethrown below.
		}
		throw error;
	} finally {
		if (!settled) {
			// The turn threw after spawning: don't leave its child running orphaned.
			if (pid !== null) {
				try {
					process.kill(pid, "SIGTERM");
				} catch {
					// Already exited.
				}
			}
			store.setPid(sessionId, null);
			store.transitionSessionState(sessionId, "working", "failed");
		}
	}
	store.touch(sessionId);
	updateIdentity(root, name, {
		taskId,
		summary: `${capability} ran a turn for ${taskId} → ${finalState}`,
	});

	// Quality gates run once when EITHER the self-improving loop or auto-merge
	// needs them (and gates aren't skipped); the outcome feeds both. Best-effort.
	const runSkills = config.skills.enabled && !config.agents.skipSkills;
	const autoMergeWants =
		config.merge.autoMerge !== "off" && capability !== "scout" && capability !== "merger";
	const wantGates = !config.agents.skipGates && (runSkills || autoMergeWants);
	let gateStatus: OutcomeStatus | null = null;
	if (finalState === "completed" && (wantGates || runSkills)) {
		let step = "Quality gates";
		try {
			if (wantGates) {
				const gateOutcome = await runQualityGates(config.project.qualityGates ?? [], worktreePath);
				gateStatus = gateOutcome?.status ?? null;
			}
			if (runSkills) {
				step = "Skill feedback/distillation";
				await runSkillFeedbackAndDistill({
					root,
					agentName: name,
					capability,
					taskId,
					worktreePath,
					baseRef: config.project.canonicalBranch,
					runtime,
					outcomeStatus: gateStatus,
					skills: config.skills,
					model: model.model,
				});
			}
		} catch (error) {
			// Skill loop is advisory; a failure here must not fail the turn — but it
			// must be visible, or a broken distiller silently disables the loop.
			reportPostTurnFailure(events, name, runId, step, error);
		}
	}

	// Auto-merge the branch onto the canonical branch when configured (off by
	// default). Best-effort — a landing must never fail the turn.
	if (finalState === "completed") {
		try {
			await maybeAutoMerge({
				root,
				branchName,
				targetBranch: config.project.canonicalBranch,
				capability,
				agentName: name,
				taskId,
				parent: session.parentAgent,
				mode: config.merge.autoMerge,
				aiResolveEnabled: config.merge.aiResolveEnabled,
				gateStatus,
				mail,
			});
		} catch (error) {
			// Auto-merge is best-effort; never fail the turn over a landing — but say
			// so, or the branch silently never lands and the parent waits forever.
			reportPostTurnFailure(events, name, runId, "Auto-merge", error);
		}
	}

	return { finalState, exitCode: turn.exitCode, gateStatus };
}

export interface DriveAgentTurnCtx {
	root: string;
	config: AgentplateConfig;
	session: AgentSession;
	store: SessionStore;
	events: EventStore;
	mail: MailClient;
}

/**
 * Run the next (resumed) turn for an existing session: resolve its runtime + model
 * + manifest def, inject its unread mail as the prompt, and {@link driveTurn} with
 * the stored `runtimeSessionId` (warm start). Shared by `agentplate turn` (single)
 * and `agentplate watch` (the mail pump). The caller's state check is only a fast
 * path: driveTurn claims the turn atomically and throws if another driver won it,
 * and the mail is injected only after that claim.
 */
export async function driveAgentTurn(ctx: DriveAgentTurnCtx): Promise<DriveTurnResult> {
	const { root, config, session } = ctx;
	const manifestPath = manifestFilePath(root);
	const manifest = existsSync(manifestPath) ? loadManifest(manifestPath) : buildDefaultManifest();
	const def = getDefinition(manifest, session.capability);
	const runtime = getRuntime(
		runtimeNameForCapability(config.runtime, session.capability),
		config.runtime.default,
	);
	const model = resolveModel(config, root, def.model, session.capability);

	// The turn's user text is the agent's unread mail (a child's reply / operator
	// direction); fall back to a continue nudge. It is read lazily, only once
	// driveTurn has claimed the turn, and marked read only once the runtime has
	// spawned: a turn that loses the claim or fails to start leaves it unread.
	let unread: MailMessage[] = [];
	const prompt = (): string => {
		unread = ctx.mail.check(session.agentName, { unreadOnly: true });
		return unread.length > 0
			? formatInjection(unread)
			: "Continue your task. If it is complete, send your terminal mail.";
	};

	return driveTurn({
		root,
		config,
		runtime,
		store: ctx.store,
		events: ctx.events,
		mail: ctx.mail,
		session,
		model,
		prompt,
		resumeSessionId: session.runtimeSessionId ?? undefined,
		onSpawn: () => {
			for (const message of unread) ctx.mail.markRead(message.id);
		},
	});
}
