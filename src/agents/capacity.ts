/**
 * Orchestration capacity limits — enforced at spawn time.
 *
 * `agents.maxConcurrent`, `agents.maxAgentsPerLead`, and `agents.maxDepth` are
 * configured (and validated) but were previously decorative — nothing consulted
 * them. {@link assertCapacity} is the single gate `sling` calls before creating a
 * worktree, so a runaway fan-out is refused with a typed {@link CapacityError}
 * rather than spawning unbounded agents.
 *
 * Pure (counts are passed in) so it is unit-tested without a session store.
 */

import { CapacityError } from "../errors.ts";

export interface CapacityLimits {
	maxDepth: number;
	maxConcurrent: number;
	maxAgentsPerLead: number;
}

export interface CapacityCheck {
	/** Depth the new agent would occupy. */
	depth: number;
	/** Active agents in the run right now (excluding the one being spawned). */
	active: number;
	/** Spawning parent, or null for a top-level spawn. */
	parentAgent: string | null;
	/** Active children the parent already has (ignored when parentAgent is null). */
	parentActiveChildren: number;
	limits: CapacityLimits;
}

/** Throw {@link CapacityError} if spawning would exceed any configured limit. */
export function assertCapacity(c: CapacityCheck): void {
	if (c.depth > c.limits.maxDepth) {
		throw new CapacityError(
			`Cannot spawn at depth ${c.depth}: exceeds agents.maxDepth (${c.limits.maxDepth}).`,
		);
	}
	if (c.active >= c.limits.maxConcurrent) {
		throw new CapacityError(
			`Cannot spawn: ${c.active} agent(s) already active, at agents.maxConcurrent (${c.limits.maxConcurrent}). Wait for some to finish.`,
		);
	}
	if (c.parentAgent && c.parentActiveChildren >= c.limits.maxAgentsPerLead) {
		throw new CapacityError(
			`Cannot spawn: ${c.parentAgent} already has ${c.parentActiveChildren} active child(ren), at agents.maxAgentsPerLead (${c.limits.maxAgentsPerLead}).`,
		);
	}
}
