import { describe, expect, test } from "bun:test";

import type { OutcomeStatus } from "../types.ts";
import {
	computeConfidence,
	evaluateLifecycle,
	type LifecycleConfig,
	wilsonLowerBound,
} from "./feedback.ts";
import type { Skill, SkillOutcome, SkillStatus } from "./types.ts";

// --- builders -------------------------------------------------------------

let outcomeSeq = 0;

/** Build a minimal {@link SkillOutcome} carrying just the status under test. */
function outcome(status: OutcomeStatus): SkillOutcome {
	outcomeSeq += 1;
	return {
		status,
		agent: "builder-1",
		taskId: `task-${outcomeSeq}`,
		gates: status,
		ts: new Date(2026, 4, 31, 0, 0, outcomeSeq).toISOString(),
	};
}

/** Build N outcomes of the same status. */
function outcomes(status: OutcomeStatus, n: number): SkillOutcome[] {
	return Array.from({ length: n }, () => outcome(status));
}

/** Build a {@link Skill} with overridable derived fields for lifecycle tests. */
function makeSkill(overrides: Partial<Skill> = {}): Skill {
	return {
		id: "00000000-0000-0000-0000-000000000000",
		slug: "example-skill",
		title: "Example skill",
		version: 1,
		status: "active",
		goal: "Do the thing reliably.",
		whenToUse: ["when the thing needs doing"],
		filePatterns: ["src/**/*.ts"],
		tags: ["example"],
		created: "2026-05-31T00:00:00.000Z",
		updatedAt: "2026-05-31T00:00:00.000Z",
		relatesTo: [],
		supersedes: [],
		body: "Steps go here.",
		confidence: 0.9,
		appliedCount: 0,
		successCount: 0,
		lastOutcome: null,
		...overrides,
	};
}

const CFG: LifecycleConfig = { quarantineBelow: 0.3, minSamples: 5 };

// --- wilsonLowerBound -----------------------------------------------------

describe("wilsonLowerBound", () => {
	test("n <= 0 returns 0 (no evidence, no confidence)", () => {
		expect(wilsonLowerBound(0, 0)).toBe(0);
		expect(wilsonLowerBound(5, 0)).toBe(0);
		expect(wilsonLowerBound(3, -2)).toBe(0);
	});

	test("0 successes out of n yields a lower bound of 0", () => {
		expect(wilsonLowerBound(0, 1)).toBe(0);
		expect(wilsonLowerBound(0, 10)).toBe(0);
		expect(wilsonLowerBound(0, 1000)).toBe(0);
	});

	test("all successes give a high bound but strictly below 1 for small n", () => {
		const small = wilsonLowerBound(1, 1);
		expect(small).toBeGreaterThan(0);
		expect(small).toBeLessThan(1);

		// More all-success evidence pushes the bound up, but never reaches 1.
		const more = wilsonLowerBound(20, 20);
		expect(more).toBeLessThan(1);
		expect(more).toBeGreaterThan(small);
	});

	test("result is always clamped to [0, 1]", () => {
		for (const [s, n] of [
			[0, 1],
			[1, 1],
			[5, 10],
			[10, 10],
			[100, 100],
			[3, 7],
		] as const) {
			const lb = wilsonLowerBound(s, n);
			expect(lb).toBeGreaterThanOrEqual(0);
			expect(lb).toBeLessThanOrEqual(1);
		}
	});

	test("out-of-range successes are clamped, keeping the bound in [0,1]", () => {
		// successes > n is clamped to n -> behaves like an all-success run.
		expect(wilsonLowerBound(99, 10)).toBe(wilsonLowerBound(10, 10));
		// negative successes clamp to 0.
		expect(wilsonLowerBound(-5, 10)).toBe(wilsonLowerBound(0, 10));
	});

	test("monotonic in successes at fixed n", () => {
		const n = 10;
		let previous = -1;
		for (let s = 0; s <= n; s += 1) {
			const lb = wilsonLowerBound(s, n);
			expect(lb).toBeGreaterThan(previous);
			previous = lb;
		}
	});

	test("monotonic in n for a fixed perfect success rate (more evidence => higher bound)", () => {
		let previous = -1;
		for (const n of [1, 2, 5, 10, 25, 50, 100]) {
			const lb = wilsonLowerBound(n, n);
			expect(lb).toBeGreaterThan(previous);
			previous = lb;
		}
	});

	test("larger z (wider interval) lowers the bound", () => {
		const tight = wilsonLowerBound(8, 10, 1.0);
		const wide = wilsonLowerBound(8, 10, 2.576);
		expect(wide).toBeLessThan(tight);
	});

	test("supports fractional (weighted) successes", () => {
		// 5 partials over 10 trials -> weight 2.5; bound sits between 0 and the
		// 0.5 raw proportion.
		const lb = wilsonLowerBound(2.5, 10);
		expect(lb).toBeGreaterThan(0);
		expect(lb).toBeLessThan(0.5);
	});
});

// --- computeConfidence ----------------------------------------------------

describe("computeConfidence", () => {
	test("empty outcome log -> zeroed result with null lastOutcome", () => {
		expect(computeConfidence([])).toEqual({
			confidence: 0,
			appliedCount: 0,
			successCount: 0,
			lastOutcome: null,
		});
	});

	test("weights outcomes: success=1, partial=0.5, failure=0", () => {
		const result = computeConfidence([
			outcome("success"),
			outcome("partial"),
			outcome("failure"),
			outcome("success"),
		]);
		expect(result.appliedCount).toBe(4);
		// 1 + 0.5 + 0 + 1 = 2.5 (kept as a real-valued weight sum, NOT rounded).
		expect(result.successCount).toBe(2.5);
		expect(result.confidence).toBeCloseTo(wilsonLowerBound(2.5, 4), 12);
	});

	test("lastOutcome reflects the final element in chronological order", () => {
		expect(computeConfidence([outcome("success"), outcome("failure")]).lastOutcome).toBe("failure");
		expect(computeConfidence([outcome("failure"), outcome("partial")]).lastOutcome).toBe("partial");
		expect(computeConfidence([outcome("success")]).lastOutcome).toBe("success");
	});

	test("successCount is a SUM of weights, not a rounded integer", () => {
		const result = computeConfidence(outcomes("partial", 3));
		expect(result.successCount).toBe(1.5);
		expect(Number.isInteger(result.successCount)).toBe(false);
	});

	test("all-success confidence equals the Wilson bound for n/n", () => {
		const result = computeConfidence(outcomes("success", 8));
		expect(result.successCount).toBe(8);
		expect(result.confidence).toBeCloseTo(wilsonLowerBound(8, 8), 12);
		expect(result.confidence).toBeLessThan(1);
	});

	test("all-failure confidence is 0", () => {
		const result = computeConfidence(outcomes("failure", 6));
		expect(result.successCount).toBe(0);
		expect(result.confidence).toBe(0);
	});

	test("small-sample penalty: 1/1 success has LOWER confidence than 30/33", () => {
		const oneOfOne = computeConfidence(outcomes("success", 1));

		const thirtyOfThirtyThree = computeConfidence([
			...outcomes("success", 30),
			...outcomes("failure", 3),
		]);

		expect(thirtyOfThirtyThree.appliedCount).toBe(33);
		expect(thirtyOfThirtyThree.successCount).toBe(30);
		expect(oneOfOne.confidence).toBeLessThan(thirtyOfThirtyThree.confidence);
	});

	test("more consistent successes raise confidence over time", () => {
		const few = computeConfidence(outcomes("success", 3));
		const many = computeConfidence(outcomes("success", 30));
		expect(many.confidence).toBeGreaterThan(few.confidence);
	});

	test("confidence stays within [0, 1] across mixed logs", () => {
		const result = computeConfidence([
			...outcomes("success", 7),
			...outcomes("partial", 4),
			...outcomes("failure", 5),
		]);
		expect(result.confidence).toBeGreaterThanOrEqual(0);
		expect(result.confidence).toBeLessThanOrEqual(1);
		expect(result.appliedCount).toBe(16);
		expect(result.successCount).toBe(9); // 7 + 2 + 0
	});
});

// --- evaluateLifecycle ----------------------------------------------------

describe("evaluateLifecycle", () => {
	test("quarantines on low confidence WITH enough samples", () => {
		const skill = makeSkill({ status: "active", appliedCount: 10, confidence: 0.2 });
		expect(evaluateLifecycle(skill, [], CFG)).toBe("quarantined");
	});

	test("does NOT quarantine on low confidence when below minSamples", () => {
		const skill = makeSkill({ status: "active", appliedCount: 2, confidence: 0.1 });
		expect(evaluateLifecycle(skill, [], CFG)).toBe("active");
	});

	test("does NOT quarantine when confidence is at or above the floor", () => {
		const atFloor = makeSkill({ status: "active", appliedCount: 20, confidence: 0.3 });
		expect(evaluateLifecycle(atFloor, [], CFG)).toBe("active");

		const aboveFloor = makeSkill({ status: "active", appliedCount: 20, confidence: 0.8 });
		expect(evaluateLifecycle(aboveFloor, [], CFG)).toBe("active");
	});

	test("quarantines on three consecutive failures regardless of historical confidence", () => {
		const skill = makeSkill({ status: "active", appliedCount: 50, confidence: 0.95 });
		const recent = outcomes("failure", 3);
		expect(evaluateLifecycle(skill, recent, CFG)).toBe("quarantined");
	});

	test("inspects only the trailing 3 outcomes for the consecutive-failure rule", () => {
		const skill = makeSkill({ status: "active", appliedCount: 50, confidence: 0.95 });
		// Older failures + a recent success tail -> NOT quarantined.
		const recoveredTail: SkillOutcome[] = [
			...outcomes("failure", 5),
			outcome("success"),
			outcome("success"),
			outcome("success"),
		];
		expect(evaluateLifecycle(skill, recoveredTail, CFG)).toBe("active");

		// A full log whose final three are failures DOES quarantine.
		const regressedTail: SkillOutcome[] = [
			outcome("success"),
			outcome("success"),
			...outcomes("failure", 3),
		];
		expect(evaluateLifecycle(skill, regressedTail, CFG)).toBe("quarantined");
	});

	test("fewer than 3 trailing failures never trips the consecutive rule", () => {
		const skill = makeSkill({ status: "active", appliedCount: 50, confidence: 0.95 });
		expect(evaluateLifecycle(skill, outcomes("failure", 2), CFG)).toBe("active");
		expect(
			evaluateLifecycle(skill, [outcome("failure"), outcome("success"), outcome("failure")], CFG),
		).toBe("active");
	});

	test("preserves the current status when neither rule fires", () => {
		const healthy = makeSkill({ status: "active", appliedCount: 40, confidence: 0.7 });
		expect(evaluateLifecycle(healthy, outcomes("success", 3), CFG)).toBe("active");
	});

	test("never auto-resurrects a deprecated skill", () => {
		const deprecated = makeSkill({ status: "deprecated", appliedCount: 40, confidence: 0.99 });
		const status: SkillStatus = evaluateLifecycle(deprecated, outcomes("success", 3), CFG);
		expect(status).toBe("deprecated");
	});

	test("a deprecated skill can still be (re)quarantined by the rules", () => {
		const deprecated = makeSkill({ status: "deprecated", appliedCount: 40, confidence: 0.05 });
		expect(evaluateLifecycle(deprecated, [], CFG)).toBe("quarantined");
	});

	test("an already-quarantined skill stays quarantined when healthy again", () => {
		// Status is preserved (not promoted) — only an explicit action reactivates.
		const quarantined = makeSkill({ status: "quarantined", appliedCount: 40, confidence: 0.9 });
		expect(evaluateLifecycle(quarantined, outcomes("success", 3), CFG)).toBe("quarantined");
	});
});
