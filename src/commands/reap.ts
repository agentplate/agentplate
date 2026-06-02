/**
 * `agentplate reap` — terminate agents idle past the timeout.
 *
 * Sweeps the session store for workers with no activity for the idle window
 * (default `config.agents.idleTimeoutMinutes`, 10), marks each `stopped`, kills any
 * live process, and removes its worktree + branch. The coordinator is never
 * reaped. Run it manually or on a cron; `agentplate serve` also reaps on its own
 * loop. Use `--dry-run` to preview and `--keep-worktrees` to leave worktrees.
 */

import { Command } from "commander";
import { findProjectRoot, isInitialized, loadConfig } from "../config.ts";
import { ValidationError } from "../errors.ts";
import { jsonOutput } from "../json.ts";
import { muted, printInfo, printSuccess } from "../logging/color.ts";
import { sessionsDbPath } from "../paths.ts";
import { reapIdleSessions, selectIdleSessions } from "../sessions/reaper.ts";
import { createSessionStore } from "../sessions/store.ts";

export function createReapCommand(): Command {
	return new Command("reap")
		.description("Terminate agents idle past the timeout (stop + kill + remove worktree)")
		.option("--minutes <n>", "idle timeout in minutes (default: config.agents.idleTimeoutMinutes)")
		.option("--keep-worktrees", "mark stopped + kill process but keep worktrees/branches")
		.option("--dry-run", "list which agents would be reaped without changing anything")
		.option("--json", "output JSON")
		.action(
			async (
				opts: { minutes?: string; keepWorktrees?: boolean; dryRun?: boolean; json?: boolean },
				command: Command,
			) => {
				const useJson = command.optsWithGlobals().json === true;
				const root = findProjectRoot();
				if (!isInitialized(root)) {
					throw new ValidationError("Not initialized. Run `agentplate setup` first.");
				}
				const config = loadConfig(root);

				const minutes =
					opts.minutes !== undefined ? Number(opts.minutes) : config.agents.idleTimeoutMinutes;
				if (!Number.isFinite(minutes) || minutes < 0) {
					throw new ValidationError("--minutes must be a number >= 0");
				}
				const idleMs = minutes * 60_000;

				const store = createSessionStore(sessionsDbPath(root));
				try {
					if (opts.dryRun) {
						const candidates = selectIdleSessions(store.listSessions(), {
							idleMs,
							now: Date.now(),
						}).map((s) => ({ agent: s.agentName, capability: s.capability, state: s.state }));
						if (useJson) {
							jsonOutput({ dryRun: true, minutes, candidates });
						} else if (candidates.length === 0) {
							printInfo(`No agents idle longer than ${minutes}m.`);
						} else {
							printInfo(`Would reap ${candidates.length} agent(s) idle >${minutes}m:`);
							for (const c of candidates) {
								process.stdout.write(`  ${c.agent} ${muted(`(${c.capability}, ${c.state})`)}\n`);
							}
						}
						return;
					}

					const reaped = await reapIdleSessions(store, root, {
						idleMs,
						removeWorktrees: opts.keepWorktrees !== true,
					});

					if (useJson) {
						jsonOutput({ minutes, reapedCount: reaped.length, reaped });
					} else if (reaped.length === 0) {
						printInfo(`No agents idle longer than ${minutes}m.`);
					} else {
						printSuccess(`Reaped ${reaped.length} idle agent(s) (>${minutes}m):`);
						for (const r of reaped) {
							const wt = r.worktreeRemoved ? "worktree removed" : "worktree kept";
							process.stdout.write(`  ${r.agentName} ${muted(`(${r.capability}, ${wt})`)}\n`);
						}
					}
				} finally {
					store.close();
				}
			},
		);
}
