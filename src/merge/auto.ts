/**
 * Auto-merge: land a completed worker's branch onto the canonical branch without
 * an operator running `agentplate merge`. Gated by `config.merge.autoMerge`:
 *
 *   off            → never (manual merge by the operator/coordinator)
 *   on-gates-pass  → merge only when the task's quality gates passed cleanly
 *   on-complete    → merge as soon as the agent finished without error
 *
 * This reuses the exact same path as the manual `merge` command — the merge queue
 * (audit), the cross-process merge lock (so parallel auto-merges serialize), and
 * {@link mergeBranch} (clean-merge / auto-resolve per `aiResolveEnabled`). Outcomes
 * are reported to the parent/coordinator over mail (`merged` / `merge_failed`), so
 * the existing coordination flow still sees every landing and handles conflicts.
 *
 * Pulled out of `sling` into its own unit so it can be tested against a real temp
 * git repo without driving an agent turn.
 */

import { createMailClient } from "../mail/client.ts";
import { mergeDbPath } from "../paths.ts";
import type { AutoMergeMode, Capability, MergeStatus, MergeTier, OutcomeStatus } from "../types.ts";
import { withMergeLock } from "./lock.ts";
import { createMergeQueue } from "./queue.ts";
import { mergeBranch } from "./resolver.ts";

/** Capabilities that never produce a branch worth landing on the canonical branch. */
const NON_MERGING_CAPABILITIES: ReadonlySet<Capability> = new Set<Capability>(["scout", "merger"]);

export interface AutoMergeParams {
	root: string;
	branchName: string;
	targetBranch: string;
	capability: Capability;
	agentName: string;
	taskId: string;
	/** Who to notify of the outcome (falls back to the coordinator). */
	parent: string | null;
	mode: AutoMergeMode;
	/** Conflict strategy passed through to `mergeBranch`. */
	aiResolveEnabled: boolean;
	/** The task's quality-gate outcome, or null if gates did not run. */
	gateStatus: OutcomeStatus | null;
	/** Mail surface for reporting the outcome (injectable for tests). */
	mail?: { send: (m: Parameters<ReturnType<typeof createMailClient>["send"]>[0]) => unknown };
}

export type AutoMergeOutcome =
	| { merged: true; status: MergeStatus; tier: MergeTier | null }
	| {
			merged: false;
			reason: "disabled" | "capability-skipped" | "gates-not-passed" | "merge-failed";
			conflictFiles?: string[];
	  };

/**
 * Decide whether to auto-merge `branchName` and, if so, do it under the merge lock.
 * Never throws on a merge conflict — it reports `merge_failed` and returns a
 * non-merged outcome so the spawn that called it is never failed by a landing.
 */
export async function maybeAutoMerge(params: AutoMergeParams): Promise<AutoMergeOutcome> {
	const mail = params.mail ?? createMailClient(params.root);
	const to = params.parent ?? "coordinator";

	if (params.mode === "off") return { merged: false, reason: "disabled" };
	if (NON_MERGING_CAPABILITIES.has(params.capability)) {
		return { merged: false, reason: "capability-skipped" };
	}
	// Fail closed: on-gates-pass merges ONLY on a clean pass. A null status (gates
	// not configured / not run) or any non-success holds the merge for a human.
	if (params.mode === "on-gates-pass" && params.gateStatus !== "success") {
		mail.send({
			from: params.agentName,
			to,
			subject: `Auto-merge held: ${params.branchName}`,
			body: `Quality gates did not pass (status: ${params.gateStatus ?? "not run"}); not merging. Review and merge manually.`,
			type: "status",
		});
		return { merged: false, reason: "gates-not-passed" };
	}

	const queue = createMergeQueue(mergeDbPath(params.root));
	try {
		const entry = queue.enqueue({
			branchName: params.branchName,
			agentName: params.agentName,
			taskId: params.taskId,
			targetBranch: params.targetBranch,
		});
		const result = await withMergeLock(params.root, () =>
			mergeBranch(params.root, params.branchName, params.targetBranch, {
				autoResolve: params.aiResolveEnabled,
			}),
		);
		queue.markStatus(entry.id, result.status);

		if (result.status === "merged") {
			mail.send({
				from: params.agentName,
				to,
				subject: `Auto-merged: ${params.branchName} → ${params.targetBranch}`,
				body: `Landed via ${result.tier ?? "merge"}.`,
				type: "merged",
			});
			return { merged: true, status: result.status, tier: result.tier };
		}

		mail.send({
			from: params.agentName,
			to,
			subject: `Auto-merge failed: ${params.branchName}`,
			body: `Conflicts in: ${result.conflictFiles.join(", ") || "unknown"}. Merge manually.`,
			type: "merge_failed",
		});
		return { merged: false, reason: "merge-failed", conflictFiles: result.conflictFiles };
	} finally {
		queue.close();
	}
}
