/**
 * `agentplate turn <agent>` — run the NEXT headless turn for an existing agent.
 *
 * Where `sling` opens a fresh runtime session (turn 1), `turn` **resumes** it: it
 * passes the session's captured `runtimeSessionId` to the runtime's `--resume`, so
 * follow-up turns keep the warm context and skip the cold-start cost. The agent's
 * unread mail is injected as the turn's prompt; the shared {@link driveTurn} core
 * handles the state transition, skills loop, and auto-merge identically to turn 1.
 *
 * This is the multi-turn primitive: a coordinator/lead (or a future watcher) calls
 * it when new mail arrives for an `idle` agent. Spawn-per-turn is preserved — each
 * call is one fresh, resumed runtime subprocess.
 */

import { Command } from "commander";
import { driveAgentTurn } from "../agents/drive.ts";
import { findProjectRoot, isInitialized, loadConfig } from "../config.ts";
import { NotFoundError, ValidationError } from "../errors.ts";
import { createEventStore } from "../events/store.ts";
import { jsonOutput } from "../json.ts";
import { brand, muted, printInfo, printSuccess } from "../logging/color.ts";
import { createMailClient } from "../mail/client.ts";
import { eventsDbPath, sessionsDbPath } from "../paths.ts";
import { createSessionStore } from "../sessions/store.ts";
import type { SessionState } from "../types.ts";

interface TurnOptions {
	json?: boolean;
}

/** States a turn can be driven from: paused/awaiting mail (not terminal, not mid-turn). */
const DRIVABLE_STATES: ReadonlySet<SessionState> = new Set<SessionState>(["idle", "booting"]);

export function createTurnCommand(): Command {
	return new Command("turn")
		.description("Run the next (resumed) turn for an existing agent")
		.argument("<agent>", "agent name")
		.option("--json", "output JSON")
		.action(async (agent: string, opts: TurnOptions, command: Command) => {
			const useJson = command.optsWithGlobals().json === true;
			const root = findProjectRoot();
			if (!isInitialized(root)) {
				throw new ValidationError("Not initialized. Run `agentplate setup` first.");
			}
			const config = loadConfig(root);

			const store = createSessionStore(sessionsDbPath(root));
			const mail = createMailClient(root);
			const events = createEventStore(eventsDbPath(root));
			try {
				const session = store.getSessionByAgent(agent);
				if (!session) throw new NotFoundError(`No agent named "${agent}".`);
				if (!DRIVABLE_STATES.has(session.state)) {
					throw new ValidationError(
						`Agent "${agent}" is ${session.state}; only an idle agent can take another turn.`,
					);
				}

				const { finalState, exitCode } = await driveAgentTurn({
					root,
					config,
					session,
					store,
					events,
					mail,
				});

				if (useJson) {
					jsonOutput({
						agent,
						capability: session.capability,
						taskId: session.taskId,
						state: finalState,
						resumed: Boolean(session.runtimeSessionId),
						exitCode,
					});
					return;
				}
				printSuccess(`${brand(agent)} [${session.capability}] → ${finalState}`);
				printInfo(`  resumed: ${session.runtimeSessionId ? "yes (warm)" : "no (cold)"}`);
				printInfo(`  worktree:${muted(` ${session.worktreePath}`)}`);
			} finally {
				events.close();
				mail.close();
				store.close();
			}
		});
}
