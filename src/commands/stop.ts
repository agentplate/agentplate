/**
 * `agentplate stop <agent>` — mark an agent session stopped (and optionally remove
 * its worktree). Headless agents are spawn-per-turn, so there is no long-lived
 * process to kill; stopping records the terminal state so no further turns run.
 */

import { Command } from "commander";
import { findProjectRoot, isInitialized } from "../config.ts";
import { NotFoundError, ValidationError } from "../errors.ts";
import { jsonOutput } from "../json.ts";
import { printSuccess, printWarning } from "../logging/color.ts";
import { sessionsDbPath } from "../paths.ts";
import { createSessionStore } from "../sessions/store.ts";
import { removeWorktree } from "../worktree/manager.ts";

export function createStopCommand(): Command {
	return new Command("stop")
		.description("Terminate an agent session")
		.argument("<agent>", "agent name")
		.option("--clean-worktree", "also remove the agent's worktree")
		.option("--json", "output JSON")
		.action(
			async (
				agent: string,
				opts: { cleanWorktree?: boolean; json?: boolean },
				command: Command,
			) => {
				const useJson = command.optsWithGlobals().json === true;
				const root = findProjectRoot();
				if (!isInitialized(root)) {
					throw new ValidationError("Not initialized. Run `agentplate setup` first.");
				}
				const store = createSessionStore(sessionsDbPath(root));
				try {
					const session = store.getSessionByAgent(agent);
					if (!session) throw new NotFoundError(`No session for agent "${agent}"`);
					store.updateSessionState(session.id, "stopped");

					let worktreeRemoved = false;
					if (opts.cleanWorktree) {
						try {
							await removeWorktree(root, session.worktreePath, { force: true });
							worktreeRemoved = true;
						} catch (error) {
							printWarning(`Could not remove worktree: ${(error as Error).message}`);
						}
					}

					if (useJson) jsonOutput({ agent, stopped: true, worktreeRemoved });
					else printSuccess(`Stopped ${agent}${worktreeRemoved ? " (worktree removed)" : ""}`);
				} finally {
					store.close();
				}
			},
		);
}
