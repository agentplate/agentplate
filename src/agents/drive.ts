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
import type { EventStore } from "../events/store.ts";
import { runQualityGates } from "../insights/quality-gates.ts";
import type { MailClient } from "../mail/client.ts";
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
	OutcomeStatus,
	ResolvedModel,
	SessionState,
} from "../types.ts";
import { updateIdentity } from "./identity.ts";
import { buildDefaultManifest, getDefinition, loadManifest } from "./manifest.ts";
import { runTurn } from "./turn-runner.ts";

/** Terminal mail types whose presence marks a capability's work complete. */
export function terminalTypesFor(capability: Capability): string[] {
	return capability === "merger" ? ["merged", "merge_failed"] : ["worker_done"];
}

/**
 * Resolve a turn's end state from the agent's own mail + exit code:
 * - emitted terminal mail → `completed`
 * - clean exit, no terminal mail → `idle` (paused, awaiting its next turn)
 * - non-zero exit → `failed`
 */
export function resolveFinalState(
	root: string,
	name: string,
	capability: Capability,
	exitCode: number,
): SessionState {
	const terminal = terminalTypesFor(capability);
	const store = createMailStore(mailDbPath(root));
	try {
		const sent = store.list({ from: name });
		if (sent.some((m) => terminal.includes(m.type))) return "completed";
	} finally {
		store.close();
	}
	return exitCode === 0 ? "idle" : "failed";
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
	/** The user-turn text (dispatch / injected mail / nudge). */
	prompt: string;
	/** Prior runtime session id to resume — omit on the first turn (warm start). */
	resumeSessionId?: string;
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

	store.updateSessionState(sessionId, "working");

	let sawError = false;
	const turn = await runTurn({
		runtime,
		worktreePath,
		model: model.model,
		prompt: ctx.prompt,
		env: model.env,
		resumeSessionId: ctx.resumeSessionId,
		timeoutMs:
			config.agents.turnTimeoutMinutes > 0 ? config.agents.turnTimeoutMinutes * 60_000 : undefined,
		onEvent: (event) => {
			if (event.error || event.type === "error") sawError = true;
			// Prefer the error message (so a failed agent's reason is visible in the
			// feed/logs), else the token/cost JSON the Costs page aggregates.
			const detail = event.error
				? event.error
				: event.usage
					? JSON.stringify({ tokens: event.usage.tokens, cost: event.usage.costUsd })
					: null;
			events.record({ agentName: name, runId, type: event.type, tool: event.tool ?? null, detail });
			// Bump last_activity on every streamed event so a long but active turn
			// keeps itself fresh and is never reaped as "idle".
			store.touch(sessionId);
		},
	});
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
				detail: reason.length > 1000 ? `${reason.slice(0, 1000)}…` : reason,
			});
		}
	}

	const finalState = resolveFinalState(root, name, capability, turn.exitCode);
	store.updateSessionState(sessionId, finalState);
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
		try {
			if (wantGates) {
				const gateOutcome = await runQualityGates(config.project.qualityGates ?? [], worktreePath);
				gateStatus = gateOutcome?.status ?? null;
			}
			if (runSkills) {
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
		} catch {
			// Skill loop is advisory; a failure here must not fail the turn.
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
		} catch {
			// Auto-merge is best-effort; never fail the turn over a landing.
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
 * and `agentplate watch` (the mail pump). Assumes the caller has already decided
 * the session is drivable.
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
	// direction); fall back to a continue nudge. checkInject marks it read.
	const injected = ctx.mail.checkInject(session.agentName);
	const prompt =
		injected.trim().length > 0
			? injected
			: "Continue your task. If it is complete, send your terminal mail.";

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
	});
}
