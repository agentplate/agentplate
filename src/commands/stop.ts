/**
 * `agentplate stop <agent>` — mark an agent session stopped (and optionally remove
 * its worktree). Headless agents are spawn-per-turn, so there is no long-lived
 * process to kill; stopping records the terminal state so no further turns run.
 */

import { Command } from "commander";
import { findProjectRoot, isInitialized } from "../config.ts";
import { NotFoundError, ValidationError } from "../errors.ts";
import { createEventStore } from "../events/store.ts";
import { jsonOutput } from "../json.ts";
import { printSuccess, printWarning } from "../logging/color.ts";
import { createMailStore } from "../mail/store.ts";
import { createMergeQueue } from "../merge/queue.ts";
import { eventsDbPath, mailDbPath, mergeDbPath, sessionsDbPath } from "../paths.ts";
import { type PurgeReport, purgeAgentData } from "../sessions/purge.ts";
import { createSessionStore } from "../sessions/store.ts";
import { deleteBranch, removeWorktree } from "../worktree/manager.ts";

export function createStopCommand(): Command {
	return new Command("stop")
		.description("Terminate an agent session")
		.argument("<agent>", "agent name")
		.option("--clean-worktree", "also remove the agent's worktree")
		.option(
			"--purge",
			"fully erase the agent (worktree + mail, events, merges, state dir, session row)",
		)
		.option("--json", "output JSON")
		.action(
			async (
				agent: string,
				opts: { cleanWorktree?: boolean; purge?: boolean; json?: boolean },
				command: Command,
			) => {
				const useJson = command.optsWithGlobals().json === true;
				const root = findProjectRoot();
				if (!isInitialized(root)) {
					throw new ValidationError("Not initialized. Run `agentplate setup` first.");
				}
				// --purge implies removing the worktree: a full wipe leaves no worktree.
				const cleanWorktree = opts.cleanWorktree || opts.purge === true;
				const store = createSessionStore(sessionsDbPath(root));
				try {
					const session = store.getSessionByAgent(agent);
					if (!session) throw new NotFoundError(`No session for agent "${agent}"`);
					store.updateSessionState(session.id, "stopped");

					let worktreeRemoved = false;
					if (cleanWorktree) {
						try {
							await removeWorktree(root, session.worktreePath, { force: true });
							worktreeRemoved = true;
							// Best-effort branch cleanup (may be merged/shared — leave it then).
							try {
								await deleteBranch(root, session.branchName);
							} catch {
								// Branch kept; not fatal.
							}
						} catch (error) {
							printWarning(`Could not remove worktree: ${(error as Error).message}`);
						}
					}

					let purged: PurgeReport | null = null;
					if (opts.purge) {
						const events = createEventStore(eventsDbPath(root));
						const merge = createMergeQueue(mergeDbPath(root));
						const mail = createMailStore(mailDbPath(root));
						try {
							purged = purgeAgentData(root, session, { sessions: store, events, merge, mail });
						} finally {
							events.close();
							merge.close();
							mail.close();
						}
					}

					if (useJson) {
						jsonOutput({ agent, stopped: true, worktreeRemoved, purged });
					} else if (purged) {
						printSuccess(
							`Purged ${agent} (worktree removed, ${purged.mailDeleted} mail/${purged.eventsDeleted} events/${purged.mergeDeleted} merges erased)`,
						);
					} else {
						printSuccess(`Stopped ${agent}${worktreeRemoved ? " (worktree removed)" : ""}`);
					}
				} finally {
					store.close();
				}
			},
		);
}
