/**
 * `agentplate watch` — the mail pump that makes warm-start automatic.
 *
 * Each tick it finds **idle** agents (paused after a turn, awaiting mail) that now
 * have **unread mail**, and runs each one's next turn via {@link driveAgentTurn},
 * which **resumes** the runtime session (warm start). Detection is non-destructive
 * (`mail.check(..., { unreadOnly })`); the turn itself injects + marks the mail
 * read. Each pass drives eligible agents concurrently, capped at the fleet's
 * `maxConcurrent`; a failing turn is logged and the loop continues.
 *
 * Modes: `--once` (single pass), `--until-idle` (loop until no active agents
 * remain — the run drained), or the default (loop until Ctrl-C).
 */

import { existsSync, readFileSync } from "node:fs";
import { Command } from "commander";
import { driveAgentTurn } from "../agents/drive.ts";
import { findProjectRoot, isInitialized, loadConfig } from "../config.ts";
import { ValidationError } from "../errors.ts";
import { createEventStore } from "../events/store.ts";
import { jsonOutput } from "../json.ts";
import { brand, muted, printInfo, printSuccess, printWarning } from "../logging/color.ts";
import { createMailClient } from "../mail/client.ts";
import { currentRunPath, eventsDbPath, sessionsDbPath } from "../paths.ts";
import { createSessionStore } from "../sessions/store.ts";
import type { AgentSession } from "../types.ts";

interface WatchOptions {
	run?: string;
	interval?: string;
	once?: boolean;
	untilIdle?: boolean;
	json?: boolean;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Current run id from `.agentplate/current-run.txt`, or undefined (= all runs). */
function readCurrentRun(root: string): string | undefined {
	const path = currentRunPath(root);
	if (!existsSync(path)) return undefined;
	return readFileSync(path, "utf8").trim() || undefined;
}

export function createWatchCommand(): Command {
	return new Command("watch")
		.description("Auto-advance idle agents: run their next (resumed) turn when they have mail")
		.option("--run <id>", "scope to a run (default: the current run)")
		.option("--interval <ms>", "poll interval in milliseconds", "2000")
		.option("--once", "run a single pass, then exit")
		.option("--until-idle", "exit once no active agents remain (the run has drained)")
		.option("--json", "output a JSON summary")
		.action(async (opts: WatchOptions, command: Command) => {
			const useJson = command.optsWithGlobals().json === true;
			const root = findProjectRoot();
			if (!isInitialized(root)) {
				throw new ValidationError("Not initialized. Run `agentplate setup` first.");
			}
			const config = loadConfig(root);
			const interval = Number(opts.interval ?? "2000");
			if (!Number.isFinite(interval) || interval < 0) {
				throw new ValidationError("--interval must be a non-negative number of milliseconds.");
			}
			const runId = opts.run ?? readCurrentRun(root);

			const store = createSessionStore(sessionsDbPath(root));
			const mail = createMailClient(root);
			const events = createEventStore(eventsDbPath(root));

			let stop = false;
			const onSigint = (): void => {
				stop = true;
			};
			process.once("SIGINT", onSigint);

			let totalDriven = 0;
			const drivenLog: Array<{ agent: string; state: string }> = [];
			// Cap simultaneous turns at the fleet's maxConcurrent (>= 1).
			const concurrency = Math.max(1, config.agents.maxConcurrent);

			/** Drive one agent's next turn, recording the outcome. */
			const driveOne = async (session: AgentSession): Promise<void> => {
				try {
					const { finalState } = await driveAgentTurn({
						root,
						config,
						session,
						store,
						events,
						mail,
					});
					totalDriven++;
					drivenLog.push({ agent: session.agentName, state: finalState });
					if (!useJson) printInfo(`  ${brand(session.agentName)} → ${finalState}`);
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					if (!useJson) printWarning(`  ${session.agentName}: turn failed — ${message}`);
				}
			};

			/**
			 * One pass: drive every idle agent that has unread mail, up to `concurrency`
			 * turns at a time. Returns the number driven.
			 */
			const pass = async (): Promise<number> => {
				const eligible = store
					.listSessions({ runId, state: "idle" })
					.filter((s) => mail.check(s.agentName, { unreadOnly: true }).length > 0);
				let next = 0;
				const worker = async (): Promise<void> => {
					while (!stop) {
						const session = eligible[next++];
						if (!session) break;
						await driveOne(session);
					}
				};
				const lanes = Math.min(concurrency, eligible.length);
				await Promise.all(Array.from({ length: lanes }, () => worker()));
				return eligible.length;
			};

			try {
				if (opts.once) {
					await pass();
				} else {
					if (!useJson) {
						printInfo(
							`Watching${runId ? ` run ${muted(runId)}` : " all runs"} (every ${interval}ms; Ctrl-C to stop)…`,
						);
					}
					while (!stop) {
						await pass();
						if (opts.untilIdle && store.countActive(runId) === 0) break;
						if (stop) break;
						await sleep(interval);
					}
				}
			} finally {
				process.removeListener("SIGINT", onSigint);
				events.close();
				mail.close();
				store.close();
			}

			if (useJson) {
				jsonOutput({ runId: runId ?? null, driven: totalDriven, turns: drivenLog });
				return;
			}
			printSuccess(`Watch finished — drove ${totalDriven} turn(s).`);
		});
}
