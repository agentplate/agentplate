/**
 * `agentplate worktree` — list and clean agent git worktrees.
 */

import { Command } from "commander";
import { findProjectRoot, isInitialized } from "../config.ts";
import { ValidationError } from "../errors.ts";
import { jsonOutput } from "../json.ts";
import { muted, printInfo, printSuccess } from "../logging/color.ts";
import { sessionsDbPath, worktreesDir } from "../paths.ts";
import { createSessionStore } from "../sessions/store.ts";
import { listWorktrees, removeWorktree } from "../worktree/manager.ts";

function requireInit(): string {
	const root = findProjectRoot();
	if (!isInitialized(root)) {
		throw new ValidationError("Not initialized. Run `agentplate setup` first.");
	}
	return root;
}

function listCommand(): Command {
	return new Command("list")
		.description("List git worktrees")
		.option("--json", "output JSON")
		.action(async (_opts: { json?: boolean }, command: Command) => {
			const useJson = command.optsWithGlobals().json === true;
			const root = requireInit();
			const worktrees = await listWorktrees(root);
			if (useJson) {
				jsonOutput(worktrees);
				return;
			}
			for (const w of worktrees) printInfo(`${w.branch || "(detached)"}  ${muted(w.path)}`);
		});
}

function cleanCommand(): Command {
	return new Command("clean")
		.description("Remove agent worktrees")
		.option("--completed", "only worktrees of completed/stopped agents")
		.option("--all", "all agent worktrees")
		.option("--force", "remove even if dirty/unmerged")
		.action(async (opts: { completed?: boolean; all?: boolean; force?: boolean }) => {
			const root = requireInit();
			if (!opts.completed && !opts.all) {
				throw new ValidationError("Pass --completed or --all.");
			}
			const base = worktreesDir(root);
			const worktrees = (await listWorktrees(root)).filter((w) => w.path.startsWith(base));

			const store = createSessionStore(sessionsDbPath(root));
			let removed = 0;
			try {
				const sessions = store.listSessions();
				for (const w of worktrees) {
					if (opts.completed) {
						const session = sessions.find((s) => s.worktreePath === w.path);
						const done = session && (session.state === "completed" || session.state === "stopped");
						if (!done) continue;
					}
					await removeWorktree(root, w.path, { force: opts.force });
					removed++;
				}
			} finally {
				store.close();
			}
			printSuccess(`Removed ${removed} worktree(s)`);
		});
}

export function createWorktreeCommand(): Command {
	return new Command("worktree")
		.description("Manage agent git worktrees")
		.addCommand(listCommand())
		.addCommand(cleanCommand());
}
