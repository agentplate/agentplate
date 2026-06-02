/**
 * Confidence + lifecycle scoring for skills — the canonical, pure implementation.
 *
 * A skill earns trust through use. Every time an agent applies a skill the
 * session-end feedback step appends a {@link SkillOutcome} to its
 * `outcomes.jsonl`. This module turns that outcome log into the derived
 * confidence track record (Wilson lower bound) and decides when a skill should
 * be quarantined out of retrieval.
 *
 * WHY the Wilson score lower bound (rather than a naive success ratio): a skill
 * that succeeded once (1/1) should NOT outrank a skill that succeeded 30 of 33
 * times. The naive ratio gives the 1/1 skill a "perfect" 1.0; Wilson penalises
 * small samples by reporting the lower bound of the confidence interval on the
 * true success rate, so 1/1 lands well below 30/33. Outcomes are weighted —
 * `partial` counts as half a success — so the "successes" fed to Wilson is a
 * real-valued weight, not an integer count.
 *
 * PURITY: this module performs no I/O and imports no store. The skill store and
 * the session-end hook each recompute these values inline at write time, but
 * they converge on the formulas defined here (this is the single tested source
 * of truth). Do NOT import the store from here — that would create a cycle.
 */

import type { OutcomeStatus } from "../types.ts";
import type { Skill, SkillOutcome, SkillStatus } from "./types.ts";

/** z-score for a 95% one-sided confidence interval (the default for Wilson). */
const DEFAULT_Z = 1.96;

/** Outcome-to-weight mapping for the success proportion. */
const OUTCOME_WEIGHT: Record<OutcomeStatus, number> = {
	success: 1.0,
	partial: 0.5,
	failure: 0.0,
};

/** Derived confidence figures recomputed from a skill's full outcome log. */
export interface ConfidenceResult {
	/** Wilson lower bound (0..1) of the weighted success proportion. */
	confidence: number;
	/** Total number of recorded outcomes (= the sample size n). */
	appliedCount: number;
	/** Sum of outcome weights (success=1, partial=0.5, failure=0) — a real number. */
	successCount: number;
	/** Status of the most recent outcome, or null when there are none. */
	lastOutcome: OutcomeStatus | null;
}

/**
 * Wilson score interval lower bound for a proportion.
 *
 * Given `successes` out of `n` trials (successes may be fractional, since
 * outcomes are weighted), returns the lower bound of the Wilson confidence
 * interval at the given z-score. This is a small-sample-aware estimate of the
 * true success rate: it rewards more evidence and stays conservative when n is
 * tiny.
 *
 * Edge cases: `n <= 0` returns 0 (no evidence ⇒ no confidence). The result is
 * clamped to `[0, 1]`. `successes` is clamped to `[0, n]` defensively so a
 * caller passing a slightly out-of-range weight cannot push the bound outside
 * the unit interval.
 *
 * Formula (one-sided lower bound):
 *
 *   p  = successes / n
 *   lb = (p + z²/2n − z·√( (p(1−p) + z²/4n) / n )) / (1 + z²/n)
 */
export function wilsonLowerBound(successes: number, n: number, z: number = DEFAULT_Z): number {
	if (n <= 0) {
		return 0;
	}
	// Defensive clamp: weighted successes must lie within [0, n].
	const s = Math.min(Math.max(successes, 0), n);
	const p = s / n;
	const z2 = z * z;
	const denominator = 1 + z2 / n;
	const centre = p + z2 / (2 * n);
	const margin = z * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n);
	const lb = (centre - margin) / denominator;
	// Clamp to the unit interval — guards against tiny floating-point overshoot.
	return Math.min(Math.max(lb, 0), 1);
}

/**
 * Recompute a skill's derived confidence figures from its full outcome log.
 *
 * Weights each outcome (success=1.0, partial=0.5, failure=0.0), sums the weights
 * into `successCount`, and feeds `p = successCount / appliedCount` to the Wilson
 * lower bound. With no outcomes, confidence is 0 and `lastOutcome` is null.
 *
 * `outcomes` is treated as chronologically ordered (append-only `outcomes.jsonl`
 * order), so `lastOutcome` is the status of the final element.
 */
export function computeConfidence(outcomes: SkillOutcome[]): ConfidenceResult {
	const appliedCount = outcomes.length;
	if (appliedCount === 0) {
		return { confidence: 0, appliedCount: 0, successCount: 0, lastOutcome: null };
	}

	let successCount = 0;
	for (const outcome of outcomes) {
		successCount += OUTCOME_WEIGHT[outcome.status];
	}

	const confidence = wilsonLowerBound(successCount, appliedCount);
	const last = outcomes[appliedCount - 1];
	const lastOutcome: OutcomeStatus | null = last ? last.status : null;

	return { confidence, appliedCount, successCount, lastOutcome };
}

/** How many trailing failures in a row trigger an automatic quarantine. */
const CONSECUTIVE_FAILURE_LIMIT = 3;

/** Tunables controlling when a skill is quarantined out of retrieval. */
export interface LifecycleConfig {
	/** Quarantine when confidence drops below this (and the skill has >= minSamples). */
	quarantineBelow: number;
	/** Minimum sample size before the confidence floor is enforced. */
	minSamples: number;
}

/**
 * Decide a skill's lifecycle status given its (already-recomputed) confidence
 * and its most recent outcomes.
 *
 * Returns `"quarantined"` when EITHER:
 *   - the skill has enough evidence and its confidence is below the floor
 *     (`skill.appliedCount >= minSamples && skill.confidence < quarantineBelow`), OR
 *   - its last three outcomes are all failures (a sudden regression, regardless
 *     of historical confidence).
 *
 * Otherwise the skill keeps its current `status`. In particular this never
 * auto-resurrects a `deprecated` (or already `quarantined`) skill back to
 * `active` — promotion is an explicit, human/distiller action, not a side
 * effect of a few good runs.
 *
 * `recentOutcomes` should be the most recent outcomes in chronological order;
 * only the final {@link CONSECUTIVE_FAILURE_LIMIT} are inspected for the
 * consecutive-failure rule, so passing the full log or just the tail both work.
 */
export function evaluateLifecycle(
	skill: Skill,
	recentOutcomes: SkillOutcome[],
	cfg: LifecycleConfig,
): SkillStatus {
	const lowConfidenceWithEvidence =
		skill.appliedCount >= cfg.minSamples && skill.confidence < cfg.quarantineBelow;

	if (lowConfidenceWithEvidence || hasConsecutiveFailures(recentOutcomes)) {
		return "quarantined";
	}

	return skill.status;
}

/**
 * True when the final {@link CONSECUTIVE_FAILURE_LIMIT} outcomes are all
 * failures. Requires at least that many outcomes — fewer than the limit can
 * never trip the rule.
 */
function hasConsecutiveFailures(outcomes: SkillOutcome[]): boolean {
	if (outcomes.length < CONSECUTIVE_FAILURE_LIMIT) {
		return false;
	}
	const tail = outcomes.slice(-CONSECUTIVE_FAILURE_LIMIT);
	return tail.every((outcome) => outcome.status === "failure");
}
