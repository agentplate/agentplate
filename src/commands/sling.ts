/**
 * `agentplate sling <task-id>` — spawn a worker agent.
 *
 * The end-to-end spawn path: resolve run + manifest → create an isolated git
 * worktree → write the per-task overlay (base definition + assignment) → create
 * the agent identity + session row → dispatch the task over mail → run the first
 * headless turn → observe the agent's terminal mail to transition the session.
 *
 * Headless spawn-per-turn: this runs the FIRST turn. Subsequent turns are driven
 * by new mail (a later refinement); the basic core proves the single-turn loop.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { Command } from "commander";
import { createIdentity, updateIdentity } from "../agents/identity.ts";
import { buildDefaultManifest, getDefinition, loadManifest } from "../agents/manifest.ts";
import { writeOverlay } from "../agents/overlay.ts";
import { runTurn } from "../agents/turn-runner.ts";
import { findProjectRoot, isInitialized, loadConfig } from "../config.ts";
import { ValidationError } from "../errors.ts";
import { createEventStore } from "../events/store.ts";
import { runQualityGates } from "../insights/quality-gates.ts";
import { jsonOutput } from "../json.ts";
import { brand, muted, printHint, printInfo, printSuccess } from "../logging/color.ts";
import { createMailClient } from "../mail/client.ts";
import { createMailStore } from "../mail/store.ts";
import {
	currentRunPath,
	eventsDbPath,
	mailDbPath,
	manifestFilePath,
	packageAgentDefPath,
	sessionsDbPath,
} from "../paths.ts";
import { getRuntime } from "../runtimes/registry.ts";
import { resolveModel } from "../runtimes/resolve.ts";
import { createSessionStore } from "../sessions/store.ts";
import { retrieveSkillsForSpawn, runSkillFeedbackAndDistill } from "../skills/lifecycle.ts";
import type { AgentManifest, AgentSession, Capability, OverlayConfig } from "../types.ts";
import { SUPPORTED_CAPABILITIES } from "../types.ts";
import { createWorktree } from "../worktree/manager.ts";

export interface SlingOptions {
	capability?: string;
	name?: string;
	spec?: string;
	files?: string;
	parent?: string;
	depth?: string;
	run?: string;
	runtime?: string;
	baseBranch?: string;
	siblings?: string;
	json?: boolean;
}

function readCurrentRun(root: string): string | null {
	const path = currentRunPath(root);
	return existsSync(path) ? readFileSync(path, "utf8").trim() || null : null;
}

function writeCurrentRun(root: string, runId: string): void {
	writeFileSync(currentRunPath(root), `${runId}\n`, "utf8");
}

function loadOrBuildManifest(root: string): AgentManifest {
	const path = manifestFilePath(root);
	return existsSync(path) ? loadManifest(path) : buildDefaultManifest();
}

/** Read a base agent definition, preferring a project-deployed copy over the bundled one. */
function readBaseDefinition(root: string, file: string): string {
	const deployed = `${root}/.agentplate/agent-defs/${file}`;
	if (existsSync(deployed)) return readFileSync(deployed, "utf8");
	const bundled = packageAgentDefPath(file);
	if (existsSync(bundled)) return readFileSync(bundled, "utf8");
	return "";
}

/** Generate a collision-free agent name for a capability + task. */
function uniqueName(store: ReturnType<typeof createSessionStore>, preferred: string): string {
	if (!store.getSessionByAgent(preferred)) return preferred;
	for (let i = 2; i < 100; i++) {
		const candidate = `${preferred}-${i}`;
		if (!store.getSessionByAgent(candidate)) return candidate;
	}
	return `${preferred}-${preferred.length}`;
}

export function createSlingCommand(): Command {
	return new Command("sling")
		.description("Spawn a worker agent")
		.argument("<task-id>", "task identifier")
		.option("--capability <type>", "scout | builder | reviewer | lead | merger", "builder")
		.option("--name <name>", "unique agent name (auto-generated if omitted)")
		.option("--spec <path>", "path to a task spec file")
		.option("--files <list>", "comma-separated exclusive file scope")
		.option("--parent <agent>", "parent agent (for hierarchy)")
		.option("--depth <n>", "hierarchy depth", "0")
		.option("--run <id>", "attach to an existing run")
		.option("--runtime <name>", "runtime adapter (default: config)")
		.option("--base-branch <branch>", "base branch for the worktree")
		.option("--siblings <names>", "comma-separated parallel sibling names")
		.option("--json", "output JSON")
		.action(async (taskId: string, opts: SlingOptions, command: Command) => {
			const useJson = command.optsWithGlobals().json === true;
			const root = findProjectRoot();
			if (!isInitialized(root)) {
				throw new ValidationError("Not initialized. Run `agentplate setup` first.");
			}
			const config = loadConfig(root);

			const capability = (opts.capability ?? "builder") as Capability;
			if (!SUPPORTED_CAPABILITIES.includes(capability)) {
				throw new ValidationError(
					`Unknown capability "${capability}". One of: ${SUPPORTED_CAPABILITIES.join(", ")}`,
				);
			}
			const manifest = loadOrBuildManifest(root);
			const def = getDefinition(manifest, capability); // throws NotFoundError if absent

			const store = createSessionStore(sessionsDbPath(root));
			const mail = createMailClient(root);
			const events = createEventStore(eventsDbPath(root));
			try {
				// Resolve the run this agent belongs to.
				const runId = resolveRun(store, root, opts);

				const name = uniqueName(store, opts.name ?? `${capability}-${taskId}`);
				const branchName = `agentplate/${name}`;

				// 1. Isolated worktree.
				const worktree = await createWorktree(root, name, branchName, opts.baseBranch);

				// 2. Retrieve relevant skills (records applied-skills.json for feedback).
				const fileScope = opts.files ? opts.files.split(",").map((f) => f.trim()) : [];
				const skillsOverlay = retrieveSkillsForSpawn({
					root,
					agentName: name,
					capability,
					taskId,
					fileScope,
					taskText: `${taskId} ${capability}`,
					skills: config.skills,
				});

				// 3. Overlay (base definition + assignment + skills) → instruction file.
				const runtime = getRuntime(opts.runtime ?? config.runtime.default, config.runtime.default);
				const overlayConfig: OverlayConfig = {
					agentName: name,
					capability,
					taskId,
					specPath: opts.spec,
					branchName,
					worktreePath: worktree.path,
					parentAgent: opts.parent ?? null,
					depth: Number(opts.depth ?? "0"),
					fileScope,
					baseDefinition: readBaseDefinition(root, def.file),
					canSpawn: def.canSpawn,
					qualityGates: config.project.qualityGates ?? [],
					constraints: def.constraints,
					siblings: opts.siblings ? opts.siblings.split(",").map((s) => s.trim()) : undefined,
					skillsOverlay: skillsOverlay || undefined,
				};
				writeOverlay(overlayConfig, runtime.instructionPath);

				// 3. Identity + session row.
				createIdentity(root, name, capability);
				const now = new Date().toISOString();
				const session: AgentSession = {
					id: `session-${name}-${Date.now()}`,
					agentName: name,
					capability,
					taskId,
					runId,
					worktreePath: worktree.path,
					branchName,
					state: "booting",
					parentAgent: opts.parent ?? null,
					depth: Number(opts.depth ?? "0"),
					pid: null,
					runtimeSessionId: null,
					startedAt: now,
					lastActivity: now,
				};
				store.upsertSession(session);

				// 4. Dispatch over mail (before the turn, so checkInject sees it).
				mail.send({
					from: opts.parent ?? "operator",
					to: name,
					subject: `Dispatch: ${taskId}`,
					body: dispatchBody(taskId, capability, overlayConfig),
					type: "dispatch",
				});

				// 5. Run the first headless turn.
				const resolved = resolveModel(config, root, def.model);
				store.updateSessionState(session.id, "working");
				const prompt = buildInitialPrompt(mail.checkInject(name), runtime.instructionPath);
				let sawError = false;
				const turn = await runTurn({
					runtime,
					worktreePath: worktree.path,
					model: resolved.model,
					prompt,
					env: resolved.env,
					onEvent: (event) => {
						if (event.error || event.type === "error") sawError = true;
						// Prefer the error message (so a failed agent's reason is visible in
						// the feed/logs), else the token/cost JSON the Costs page aggregates.
						const detail = event.error
							? event.error
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
						// Bump last_activity on every streamed event so a long but active
						// turn keeps itself fresh and is never reaped as "idle".
						store.touch(session.id);
					},
				});
				if (turn.runtimeSessionId) store.setRuntimeSessionId(session.id, turn.runtimeSessionId);

				// A non-zero exit with no error event means the runtime failed via stderr
				// (e.g. Pi's "No API key found for anthropic"). Record that stderr so the
				// failure reason is visible in the feed/logs instead of a blank "failed".
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

				// 6. Observe terminal mail to transition the session.
				const finalState = resolveFinalState(root, name, capability, turn.exitCode);
				store.updateSessionState(session.id, finalState);
				store.touch(session.id);
				updateIdentity(root, name, {
					taskId,
					summary: `${capability} ran a turn for ${taskId} → ${finalState}`,
				});

				// 7. Self-improving loop: score quality gates, append outcomes to
				//    applied skills, and distill a skill when the work passed. Only
				//    runs for a completed task; best-effort (never fails the spawn).
				if (finalState === "completed" && config.skills.enabled) {
					try {
						const gateOutcome = await runQualityGates(
							config.project.qualityGates ?? [],
							worktree.path,
						);
						await runSkillFeedbackAndDistill({
							root,
							agentName: name,
							capability,
							taskId,
							worktreePath: worktree.path,
							baseRef: config.project.canonicalBranch,
							runtime,
							outcomeStatus: gateOutcome?.status ?? null,
							skills: config.skills,
							model: resolved.model,
						});
					} catch {
						// Skill loop is advisory; a failure here must not fail the spawn.
					}
				}

				if (useJson) {
					jsonOutput({
						agent: name,
						capability,
						taskId,
						runId,
						branchName,
						worktreePath: worktree.path,
						state: finalState,
						exitCode: turn.exitCode,
					});
					return;
				}
				printSuccess(`${brand(name)} [${capability}] → ${finalState}`);
				printInfo(`  task:    ${taskId}`);
				printInfo(`  branch:  ${branchName}`);
				printInfo(`  worktree:${muted(` ${worktree.path}`)}`);
				if (turn.exitCode !== 0) {
					printHint(`  turn exited ${turn.exitCode}; see \`agentplate mail list --from ${name}\``);
				}
			} finally {
				events.close();
				mail.close();
				store.close();
			}
		});
}

function resolveRun(
	store: ReturnType<typeof createSessionStore>,
	root: string,
	opts: SlingOptions,
): string {
	if (opts.run && store.getRun(opts.run)) return opts.run;
	if (opts.parent) {
		const parent = store.getSessionByAgent(opts.parent);
		if (parent && store.getRun(parent.runId)) return parent.runId;
	}
	const fromFile = readCurrentRun(root);
	if (fromFile && store.getRun(fromFile)) return fromFile;
	const run = store.createRun();
	writeCurrentRun(root, run.id);
	return run.id;
}

function dispatchBody(taskId: string, capability: Capability, cfg: OverlayConfig): string {
	const lines = [
		`You are ${cfg.agentName}, a ${capability} agent.`,
		`Task: ${taskId}`,
		cfg.specPath ? `Spec: ${cfg.specPath}` : undefined,
		cfg.fileScope.length ? `File scope: ${cfg.fileScope.join(", ")}` : undefined,
		`Your full instructions are in ${cfg.worktreePath}.`,
	];
	return lines.filter(Boolean).join("\n");
}

function buildInitialPrompt(injected: string, instructionPath: string): string {
	const header = `Read your instructions at ${instructionPath}, then begin your task.`;
	return injected ? `${injected}\n\n${header}` : header;
}

/** Terminal mail types that mark a capability's work complete. */
function terminalTypesFor(capability: Capability): string[] {
	return capability === "merger" ? ["merged", "merge_failed"] : ["worker_done"];
}

function resolveFinalState(
	root: string,
	name: string,
	capability: Capability,
	exitCode: number,
): AgentSession["state"] {
	const terminal = terminalTypesFor(capability);
	const store = createMailStore(mailDbPath(root));
	try {
		const sent = store.list({ from: name });
		if (sent.some((m) => terminal.includes(m.type))) return "completed";
	} finally {
		store.close();
	}
	if (exitCode === 0) return "idle";
	return "failed";
}
