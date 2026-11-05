/**
 * `agentplate merge` — fold agent branches into the canonical (or chosen) branch.
 *
 * Supports a single `--branch`, `--all` completed agent branches, and a
 * side-effect-free `--dry-run` that predicts the resolution tier and conflicts.
 * Merges run under a sentinel lock so two `merge` invocations never race on the
 * same target.
 */

import { Command } from "commander";
import { loadConfig } from "../config.ts";
import { ValidationError } from "../errors.ts";
import { jsonOutput } from "../json.ts";
import { printError, printInfo, printSuccess } from "../logging/color.ts";
import { withMergeLock } from "../merge/lock.ts";
import { createMergeQueue } from "../merge/queue.ts";
import { mergeBranch, predictMerge } from "../merge/resolver.ts";
import { mergeDbPath, sessionsDbPath } from "../paths.ts";
import { createSessionStore } from "../sessions/store.ts";
import type { AgentSession, MergeResult } from "../types.ts";
import { requireInit } from "./shared.ts";

export function createMergeCommand(): Command {
	return new Command("merge")
		.description("Merge agent branches into the canonical branch")
		.option("--branch <name>", "merge a specific branch")
		.option("--all", "merge all completed agent branches")
		.option("--into <branch>", "target branch (default: project canonical branch)")
		.option("--dry-run", "predict conflicts/tier without merging")
		.option("--json", "output JSON")
		.action(
			async (
				opts: {
					branch?: string;
					all?: boolean;
					into?: string;
					dryRun?: boolean;
					json?: boolean;
				},
				command: Command,
			) => {
				const useJson = command.optsWithGlobals().json === true;
				const root = requireInit();
				const config = loadConfig(root);
				const target = opts.into ?? config.project.canonicalBranch;

				const store = createSessionStore(sessionsDbPath(root));
				let branches: Array<{ branch: string; session?: AgentSession }> = [];
				try {
					if (opts.branch) {
						const session = store.listSessions().find((s) => s.branchName === opts.branch);
						branches = [{ branch: opts.branch, session }];
					} else if (opts.all) {
						branches = store
							.listSessions({ state: "completed" })
							.map((s) => ({ branch: s.branchName, session: s }));
					} else {
						throw new ValidationError("Pass --branch <name> or --all.");
					}
				} finally {
					store.close();
				}

				if (branches.length === 0) {
					if (useJson) jsonOutput({ merged: [], message: "no branches to merge" });
					else printInfo("No branches to merge.");
					return;
				}

				// Dry-run: predict only. predictMerge uses `git merge-tree`, which never
				// touches HEAD, the index, or the working tree, so no lock is needed.
				if (opts.dryRun) {
					const predictions: MergeResult[] = [];
					for (const { branch } of branches) {
						// One bad entry (e.g. a completed session whose branch was deleted)
						// is reported on its own line instead of aborting the whole --all run.
						try {
							predictions.push(
								await predictMerge(root, branch, target, {
									autoResolve: config.merge.aiResolveEnabled,
								}),
							);
						} catch (err) {
							predictions.push({
								branchName: branch,
								status: "failed",
								tier: null,
								conflictFiles: [],
								message: err instanceof Error ? err.message : String(err),
							});
						}
					}
					if (useJson) {
						jsonOutput({ dryRun: true, target, predictions });
						return;
					}
					for (const p of predictions) {
						if (p.status === "failed") {
							printError(`${p.branchName} → ${target}: predicted failure — ${p.message}`);
							continue;
						}
						printInfo(
							`${p.branchName} → ${target}: predicted ${p.tier}` +
								(p.conflictFiles.length ? ` (${p.conflictFiles.length} conflict file(s))` : ""),
						);
					}
					return;
				}

				const queue = createMergeQueue(mergeDbPath(root));
				const results: MergeResult[] = [];
				try {
					for (const { branch, session } of branches) {
						const entry = queue.enqueue({
							branchName: branch,
							agentName: session?.agentName ?? "unknown",
							taskId: session?.taskId ?? "unknown",
							targetBranch: target,
						});
						let result: MergeResult;
						try {
							result = await withMergeLock(root, () =>
								mergeBranch(root, branch, target, { autoResolve: config.merge.aiResolveEnabled }),
							);
						} catch (err) {
							// Record the attempt so the queue row is not left "pending" forever.
							queue.markStatus(entry.id, "failed");
							throw err;
						}
						queue.markStatus(entry.id, result.status);
						results.push(result);
					}
				} finally {
					queue.close();
				}

				if (useJson) {
					jsonOutput({ target, results });
					return;
				}
				for (const r of results) {
					if (r.status === "merged") {
						printSuccess(`${r.branchName} → ${target}: ${r.tier}`);
					} else {
						printError(
							`${r.branchName} → ${target}: ${r.status}` +
								(r.conflictFiles.length ? ` (${r.conflictFiles.join(", ")})` : ""),
						);
					}
				}
			},
		);
}
