/**
 * `agentplate coordinator` — the top-level orchestration session.
 *
 * Basic core: `start` opens a run and registers a coordinator session that
 * worker agents attach to (via `agentplate sling`, which inherits the current run).
 * `send` queues a message for the coordinator, `status` shows its state, `stop`
 * ends it. Driving a fully headless coordinator turn-loop (where the coordinator
 * itself spawns leads via real AI) builds on this in a later phase.
 */

import { writeFileSync } from "node:fs";
import { Command } from "commander";
import {
	removeGeneratedInstructionFile,
	writeGeneratedInstructionFile,
} from "../agents/instruction-file.ts";
import { writeCoordinatorSystemPrompt } from "../agents/system-prompt.ts";
import { findProjectRoot, isInitialized, loadConfig } from "../config.ts";
import { NotFoundError, ValidationError } from "../errors.ts";
import { jsonOutput } from "../json.ts";
import {
	brand,
	muted,
	printHint,
	printInfo,
	printSuccess,
	printWarning,
} from "../logging/color.ts";
import { AGENT_IDENTITY_ENV, createMailClient, resolveSender } from "../mail/client.ts";
import { currentRunPath, sessionsDbPath } from "../paths.ts";
import { getRuntime } from "../runtimes/registry.ts";
import { resolveModel } from "../runtimes/resolve.ts";
import type { AgentRuntime, InteractiveSpawnOpts } from "../runtimes/types.ts";
import { createSessionStore } from "../sessions/store.ts";
import type { AgentSession } from "../types.ts";
import { resolveArgv } from "../utils/detect.ts";

const COORDINATOR_NAME = "coordinator";

/** A runtime that can host an attended chat (`buildInteractiveSpawn` present). */
type InteractiveRuntime = AgentRuntime & {
	buildInteractiveSpawn(opts: InteractiveSpawnOpts): string[];
};

function isInteractiveRuntime(runtime: AgentRuntime): runtime is InteractiveRuntime {
	return typeof runtime.buildInteractiveSpawn === "function";
}

/** How `coordinator start` hands its role prompt to the runtime. */
export interface CoordinatorLaunch {
	/** The interactive argv to spawn. */
	argv: string[];
	/** Instruction file generated at the root for this chat (removed on exit), or null. */
	generatedFile: string | null;
	/**
	 * Set when the root instruction file could not be used (the operator's own
	 * file is there, or the write failed) and the role was seeded as the first
	 * message instead. Holds the reason, for the operator-facing warning.
	 */
	seededBecause: string | null;
}

/** Prefix the role prompt to the operator's optional first message. */
function seedRole(systemPrompt: string, initialMessage: string | undefined): string {
	if (!initialMessage) return systemPrompt;
	return `${systemPrompt}\n\n---\n\nOperator's first message:\n\n${initialMessage}`;
}

/**
 * Decide how the coordinator's role reaches `runtime` WITHOUT ever replacing the
 * operator's instruction file at the project root (the file `writeOverlay`
 * refuses to touch):
 *
 * 1. If the runtime carries the prompt in argv (claude's `--append-system-prompt`),
 *    nothing is written to the root at all.
 * 2. Otherwise (codex/opencode/cursor/gemini read only their instruction file),
 *    write `<root>/<instructionPath>` only when it is absent or Agentplate-generated.
 * 3. If the operator's own file is there, leave it untouched and seed the role
 *    as the chat's first message instead.
 */
export function planCoordinatorLaunch(
	root: string,
	runtime: InteractiveRuntime,
	opts: InteractiveSpawnOpts & { systemPrompt: string },
): CoordinatorLaunch {
	const argv = runtime.buildInteractiveSpawn(opts);
	if (argv.includes(opts.systemPrompt)) {
		return { argv, generatedFile: null, seededBecause: null };
	}
	let reason: string;
	try {
		const result = writeGeneratedInstructionFile(root, runtime.instructionPath, opts.systemPrompt);
		if (result.written) return { argv, generatedFile: result.path, seededBecause: null };
		reason = result.reason;
	} catch (err) {
		const detail = err instanceof Error ? err.message : String(err);
		reason = `could not write ${runtime.instructionPath} (${detail})`;
	}
	const seeded = runtime.buildInteractiveSpawn({
		...opts,
		initialMessage: seedRole(opts.systemPrompt, opts.initialMessage),
	});
	return { argv: seeded, generatedFile: null, seededBecause: reason };
}

function requireInit(): string {
	const root = findProjectRoot();
	if (!isInitialized(root)) {
		throw new ValidationError("Not initialized. Run `agentplate setup` first.");
	}
	return root;
}

function startCommand(): Command {
	return new Command("start")
		.description("Open a run and launch the interactive coordinator chat")
		.option("--label <text>", "label for the run")
		.option("--runtime <name>", "runtime: claude | opencode | codex (default: config)")
		.option("--no-attach", "register the run only; don't launch the chat")
		.option("--print <message>", "seed the coordinator's first message")
		.option(
			"--safe",
			"prompt for permission on each action (default: auto/bypass — runs unattended)",
		)
		.option("--json", "output JSON (implies --no-attach)")
		.action(
			async (
				opts: {
					label?: string;
					runtime?: string;
					attach?: boolean;
					print?: string;
					safe?: boolean;
					json?: boolean;
				},
				command: Command,
			) => {
				const useJson = command.optsWithGlobals().json === true;
				const root = requireInit();
				const config = loadConfig(root);
				const store = createSessionStore(sessionsDbPath(root));

				// 1. Register the run + coordinator session.
				const run = store.createRun(opts.label);
				writeFileSync(currentRunPath(root), `${run.id}\n`, "utf8");
				const now = new Date().toISOString();
				const session: AgentSession = {
					id: `session-${COORDINATOR_NAME}-${Date.now()}`,
					agentName: COORDINATOR_NAME,
					capability: "coordinator",
					taskId: "coordination",
					runId: run.id,
					worktreePath: root,
					branchName: config.project.canonicalBranch,
					state: "working",
					parentAgent: null,
					depth: 0,
					pid: null,
					runtimeSessionId: null,
					startedAt: now,
					lastActivity: now,
				};
				store.upsertSession(session);

				// JSON / --no-attach: register only, mirror the prior behavior.
				if (useJson || opts.attach === false) {
					if (useJson) jsonOutput({ run, coordinator: session });
					else {
						printSuccess(`${brand("coordinator")} registered — run ${run.id}`);
						printHint("Run `agentplate coordinator start` (without --no-attach) to chat.");
					}
					store.close();
					return;
				}

				// 2. Resolve the runtime + model and build the interactive session.
				const runtime = getRuntime(opts.runtime ?? config.runtime.default, config.runtime.default);
				if (!isInteractiveRuntime(runtime)) {
					store.close();
					throw new ValidationError(
						`Runtime "${runtime.id}" has no interactive mode. Use --no-attach, or set a runtime that supports interactive chat (e.g. claude).`,
					);
				}
				// The coordinator reasons about the whole run, so use the strongest
				// tier available; resolveModel falls back to the provider's configured
				// model when this alias isn't overridden.
				const resolved = resolveModel(config, root, "opus");
				const { text: systemPrompt } = writeCoordinatorSystemPrompt(root, {
					projectName: config.project.name,
					runId: run.id,
					agentName: COORDINATOR_NAME,
					canonicalBranch: config.project.canonicalBranch,
					instructionPath: runtime.instructionPath,
				});
				// Default to auto/bypass mode so the coordinator runs unattended (no
				// per-action permission prompts); `--safe` restores prompting.
				const permissionMode = opts.safe ? "default" : "bypass";
				// Prime the role via argv, or a root instruction file Agentplate owns —
				// never by overwriting the operator's AGENTS.md / CLAUDE.md / GEMINI.md.
				const launch = planCoordinatorLaunch(root, runtime, {
					model: resolved.model,
					systemPrompt,
					permissionMode,
					initialMessage: opts.print,
				});

				printSuccess(`${brand("coordinator")} started — run ${run.id}`);
				if (launch.seededBecause !== null) {
					printWarning(
						`${launch.seededBecause}; left it untouched and sent the coordinator role as the first message instead.`,
					);
				}
				if (permissionMode === "bypass") {
					printWarning(
						"auto mode: the coordinator runs WITHOUT permission prompts (bypassPermissions). Use --safe to prompt.",
					);
				}
				printInfo(muted(`  launching ${runtime.id} … (Ctrl+C to exit the chat)`));
				store.close();

				// 3. Hand the terminal to the interactive agent (inherited stdio).
				// The runtime's provider env mapping (base URLs, auth) applies in BOTH
				// modes; only the permission-bypass env is branch-specific: under
				// `--safe`, strip the runtime's bypass var (e.g. OpenCode's
				// OPENCODE_PERMISSION) so its own approval prompts stay in effect.
				// buildEnv returns a fresh object, so deleting here is safe.
				const interactiveEnv = runtime.buildEnv(resolved);
				if (permissionMode !== "bypass") {
					delete interactiveEnv.OPENCODE_PERMISSION;
				}
				// Mail the coordinator sends from its chat is sent as "coordinator", never "operator".
				interactiveEnv[AGENT_IDENTITY_ENV] = COORDINATOR_NAME;
				let exitCode: number;
				try {
					const proc = Bun.spawn(resolveArgv(launch.argv), {
						cwd: root,
						env: { ...process.env, ...interactiveEnv },
						stdin: "inherit",
						stdout: "inherit",
						stderr: "inherit",
					});
					exitCode = await proc.exited;
				} finally {
					// Leave the root as we found it: drop the file this chat generated.
					if (launch.generatedFile) removeGeneratedInstructionFile(launch.generatedFile);
				}

				// 4. On exit, mark the coordinator stopped.
				const closeStore = createSessionStore(sessionsDbPath(root));
				try {
					const current = closeStore.getSessionByAgent(COORDINATOR_NAME);
					if (current) closeStore.updateSessionState(current.id, "stopped");
				} finally {
					closeStore.close();
				}
				if (exitCode !== 0) {
					printWarning(`coordinator session exited with code ${exitCode}`);
				}
			},
		);
}

function statusCommand(): Command {
	return new Command("status")
		.description("Show coordinator state")
		.option("--json", "output JSON")
		.action((_opts: { json?: boolean }, command: Command) => {
			const useJson = command.optsWithGlobals().json === true;
			const root = requireInit();
			const store = createSessionStore(sessionsDbPath(root));
			try {
				const session = store.getSessionByAgent(COORDINATOR_NAME);
				if (useJson) {
					jsonOutput({ coordinator: session });
					return;
				}
				if (!session) {
					printInfo("No coordinator. Run `agentplate coordinator start`.");
					return;
				}
				printInfo(`${brand("coordinator")} ${session.state} — run ${session.runId}`);
			} finally {
				store.close();
			}
		});
}

function sendCommand(): Command {
	return new Command("send")
		.description("Send a message to the coordinator")
		.argument("<body>", "message body")
		.requiredOption("--subject <text>", "subject")
		.option("--from <name>", "sender (default: this agent inside its turn, else operator)")
		.action((body: string, opts: { subject: string; from?: string }) => {
			const root = requireInit();
			// Same attribution rule as `mail send`: inside an agent's turn the mail is
			// sent as that agent, so only the operator's own shell can speak as "operator".
			const from = resolveSender(opts.from);
			const mail = createMailClient(root);
			try {
				mail.send({
					from,
					to: COORDINATOR_NAME,
					subject: opts.subject,
					body,
					type: "status",
				});
				printSuccess("Message queued for coordinator.");
			} finally {
				mail.close();
			}
		});
}

function stopCommand(): Command {
	return new Command("stop").description("Stop the coordinator session").action(() => {
		const root = requireInit();
		const store = createSessionStore(sessionsDbPath(root));
		try {
			const session = store.getSessionByAgent(COORDINATOR_NAME);
			if (!session) throw new NotFoundError("No coordinator session to stop.");
			store.updateSessionState(session.id, "stopped");
			printSuccess("Coordinator stopped.");
		} finally {
			store.close();
		}
	});
}

export function createCoordinatorCommand(): Command {
	return new Command("coordinator")
		.description("Top-level orchestration session")
		.addCommand(startCommand())
		.addCommand(statusCommand())
		.addCommand(sendCommand())
		.addCommand(stopCommand());
}
