/**
 * `agentplate sling <task-id>` — spawn a worker agent.
 *
 * The end-to-end spawn path: resolve run + manifest → create an isolated git
 * worktree → write the per-task overlay (base definition + assignment) → create
 * the agent identity + session row → dispatch the task over mail → run the first
 * headless turn → observe the agent's terminal mail to transition the session.
 *
 * Headless spawn-per-turn: this runs the FIRST turn (a fresh runtime session).
 * Follow-up turns are run by `agentplate turn <agent>`, which resumes the same
 * session (warm start). Both share the {@link driveTurn} core.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { Command } from "commander";
import { assertCapacity } from "../agents/capacity.ts";
import { driveTurn } from "../agents/drive.ts";
import { createIdentity } from "../agents/identity.ts";
import { buildDefaultManifest, getDefinition, loadManifest } from "../agents/manifest.ts";
import { writeOverlay } from "../agents/overlay.ts";
import { findProjectRoot, isInitialized, loadConfig } from "../config.ts";
import { ValidationError } from "../errors.ts";
import { createEventStore } from "../events/store.ts";
import { jsonOutput } from "../json.ts";
import { brand, muted, printHint, printInfo, printSuccess } from "../logging/color.ts";
import { createMailClient } from "../mail/client.ts";
import {
	currentRunPath,
	eventsDbPath,
	manifestFilePath,
	packageAgentDefPath,
	sessionsDbPath,
} from "../paths.ts";
import { getRuntime } from "../runtimes/registry.ts";
import { resolveModel } from "../runtimes/resolve.ts";
import { createSessionStore } from "../sessions/store.ts";
import { retrieveSkillsForSpawn } from "../skills/lifecycle.ts";
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
				// Validate + load the spec contract up front (fails loudly on a missing or
				// empty --spec rather than launching the agent contract-less).
				const specBody = readSpecContract(opts.spec, taskId);

				// Resolve the run this agent belongs to.
				const runId = resolveRun(store, root, opts);

				// Enforce orchestration capacity BEFORE any worktree/session is created,
				// so a runaway fan-out is refused cleanly instead of spawning unbounded.
				const parentAgent = opts.parent ?? null;
				assertCapacity({
					depth: Number(opts.depth ?? "0"),
					active: store.countActive(runId),
					parentAgent,
					parentActiveChildren: parentAgent ? store.countActiveByParent(parentAgent, runId) : 0,
					limits: config.agents,
				});

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
					body: dispatchBody(taskId, capability, overlayConfig, specBody),
					type: "dispatch",
				});

				// 5. Run the first turn. Follow-up turns warm-start (resume) via
				//    `agentplate turn`; driveTurn owns state + skills + auto-merge.
				const resolved = resolveModel(config, root, def.model, capability);
				const prompt = buildInitialPrompt(mail.checkInject(name), runtime.instructionPath);
				const { finalState, exitCode } = await driveTurn({
					root,
					config,
					runtime,
					store,
					events,
					mail,
					session,
					model: resolved,
					prompt,
				});

				if (useJson) {
					jsonOutput({
						agent: name,
						capability,
						taskId,
						runId,
						branchName,
						worktreePath: worktree.path,
						state: finalState,
						exitCode: exitCode,
					});
					return;
				}
				printSuccess(`${brand(name)} [${capability}] → ${finalState}`);
				printInfo(`  task:    ${taskId}`);
				printInfo(`  branch:  ${branchName}`);
				printInfo(`  worktree:${muted(` ${worktree.path}`)}`);
				if (exitCode !== 0) {
					printHint(`  turn exited ${exitCode}; see \`agentplate mail list --from ${name}\``);
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

/**
 * Resolve the contract a `--spec` points to, or "" when no spec was given.
 *
 * `--spec` is the race-free channel for an agent's contract: its content is
 * inlined into the dispatch and loaded at launch, unlike a brief mailed *after*
 * `sling` (which lands only after the agent has read its inbox once and started).
 * A missing or empty spec is therefore a hard error — launching an agent with a
 * blank contract makes it fall back to inherited (wrong) branch content.
 */
export function readSpecContract(specPath: string | undefined, taskId: string): string {
	if (!specPath) return "";
	if (!existsSync(specPath)) {
		throw new ValidationError(
			`--spec file not found: ${specPath}. Author it first with \`agentplate spec write ${taskId}\`.`,
		);
	}
	const body = readFileSync(specPath, "utf8");
	if (body.trim().length === 0) {
		throw new ValidationError(`--spec file is empty: ${specPath}. The contract would be blank.`);
	}
	return body;
}

export function dispatchBody(
	taskId: string,
	capability: Capability,
	cfg: OverlayConfig,
	specBody: string,
): string {
	const lines = [
		`You are ${cfg.agentName}, a ${capability} agent.`,
		`Task: ${taskId}`,
		cfg.specPath ? `Spec: ${cfg.specPath}` : undefined,
		cfg.fileScope.length ? `File scope: ${cfg.fileScope.join(", ")}` : undefined,
		`Your full instructions are in ${cfg.worktreePath}.`,
	];
	let body = lines.filter(Boolean).join("\n");
	// Inline the spec contract so it is in the agent's first prompt — not merely a
	// path it has to open. This is the in-band contract; do not rely on a later mail.
	if (specBody.trim()) {
		body += `\n\n=== SPEC (your contract — work from this, not inherited branch content) ===\n${specBody.trim()}\n=== END SPEC ===`;
	}
	return body;
}

function buildInitialPrompt(injected: string, instructionPath: string): string {
	const header = `Read your instructions at ${instructionPath}, then begin your task.`;
	return injected ? `${injected}\n\n${header}` : header;
}
