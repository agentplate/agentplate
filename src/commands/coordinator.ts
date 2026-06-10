/**
 * `agentplate coordinator` — the top-level orchestration session.
 *
 * Basic core: `start` opens a run and registers a coordinator session that
 * worker agents attach to (via `agentplate sling`, which inherits the current run).
 * `send` queues a message for the coordinator, `status` shows its state, `stop`
 * ends it. Driving a fully headless coordinator turn-loop (where the coordinator
 * itself spawns leads via real AI) builds on this in a later phase.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Command } from "commander";
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
import { createMailClient } from "../mail/client.ts";
import { currentRunPath, sessionsDbPath } from "../paths.ts";
import { getRuntime } from "../runtimes/registry.ts";
import { resolveModel } from "../runtimes/resolve.ts";
import { createSessionStore } from "../sessions/store.ts";
import type { AgentSession } from "../types.ts";
import { resolveArgv } from "../utils/detect.ts";

const COORDINATOR_NAME = "coordinator";

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
				if (!runtime.buildInteractiveSpawn) {
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
				// Also write the role to the runtime's own instruction file (e.g.
				// AGENTS.md for opencode/codex, .claude/CLAUDE.md for claude) so the
				// coordinator is primed even on runtimes without a system-prompt flag.
				try {
					const instr = join(root, runtime.instructionPath);
					mkdirSync(dirname(instr), { recursive: true });
					writeFileSync(instr, systemPrompt, "utf8");
				} catch {
					// Non-fatal: the agent still works; --append-system-prompt covers
					// runtimes that support it (claude).
				}
				// Default to auto/bypass mode so the coordinator runs unattended (no
				// per-action permission prompts); `--safe` restores prompting.
				const permissionMode = opts.safe ? "default" : "bypass";
				const argv = runtime.buildInteractiveSpawn({
					model: resolved.model,
					systemPrompt,
					permissionMode,
					initialMessage: opts.print,
				});

				printSuccess(`${brand("coordinator")} started — run ${run.id}`);
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
				const proc = Bun.spawn(resolveArgv(argv), {
					cwd: root,
					env: { ...process.env, ...interactiveEnv },
					stdin: "inherit",
					stdout: "inherit",
					stderr: "inherit",
				});
				const exitCode = await proc.exited;

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
		.option("--from <name>", "sender", "operator")
		.action((body: string, opts: { subject: string; from: string }) => {
			const root = requireInit();
			const mail = createMailClient(root);
			try {
				mail.send({
					from: opts.from,
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
