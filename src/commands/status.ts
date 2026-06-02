/**
 * `agentplate status` — show runs, active agent sessions, and worktrees.
 */

import { Command } from "commander";
import { findProjectRoot, isInitialized, loadConfig } from "../config.ts";
import { ValidationError } from "../errors.ts";
import { jsonOutput } from "../json.ts";
import { brand, muted, printInfo } from "../logging/color.ts";
import { sessionsDbPath } from "../paths.ts";
import { createSessionStore } from "../sessions/store.ts";
import { listWorktrees } from "../worktree/manager.ts";

export function createStatusCommand(): Command {
	return new Command("status")
		.description("Show runs, agent sessions, and worktrees")
		.option("--all", "show sessions from all runs (default: current run only)")
		.option("--json", "output JSON")
		.action(async (opts: { all?: boolean; json?: boolean }, command: Command) => {
			const useJson = command.optsWithGlobals().json === true;
			const root = findProjectRoot();
			if (!isInitialized(root)) {
				throw new ValidationError("Not initialized. Run `agentplate setup` first.");
			}
			loadConfig(root);
			const store = createSessionStore(sessionsDbPath(root));
			try {
				const runs = store.listRuns(10);
				const currentRun = runs[0];
				const sessions = store.listSessions(
					opts.all || !currentRun ? undefined : { runId: currentRun.id },
				);
				const worktrees = await listWorktrees(root);

				if (useJson) {
					jsonOutput({ runs, sessions, worktrees });
					return;
				}

				printInfo(brand("agentplate status"));
				printInfo(`\nruns (${runs.length})`);
				for (const run of runs) {
					printInfo(`  ${run.id}  ${run.status}  ${muted(run.createdAt)}`);
				}
				printInfo(`\nsessions (${sessions.length})`);
				if (sessions.length === 0) printInfo(muted("  none"));
				for (const s of sessions) {
					printInfo(
						`  ${s.agentName}  [${s.capability}]  ${s.state}  task:${s.taskId}  ${muted(s.branchName)}`,
					);
				}
				printInfo(`\nworktrees (${worktrees.length})`);
				for (const w of worktrees) {
					printInfo(`  ${w.branch || "(detached)"}  ${muted(w.path)}`);
				}
			} finally {
				store.close();
			}
		});
}
