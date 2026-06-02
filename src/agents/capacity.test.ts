/**
 * Tests for assertCapacity — the spawn-time orchestration limit gate.
 */

import { describe, expect, test } from "bun:test";
import { CapacityError } from "../errors.ts";
import { assertCapacity, type CapacityCheck } from "./capacity.ts";

const base: CapacityCheck = {
	depth: 1,
	active: 0,
	parentAgent: "lead-1",
	parentActiveChildren: 0,
	limits: { maxDepth: 2, maxConcurrent: 10, maxAgentsPerLead: 5 },
};

describe("assertCapacity", () => {
	test("passes when under every limit", () => {
		expect(() => assertCapacity(base)).not.toThrow();
	});

	test("refuses when depth exceeds maxDepth", () => {
		expect(() => assertCapacity({ ...base, depth: 3 })).toThrow(CapacityError);
	});

	test("allows depth exactly at maxDepth", () => {
		expect(() => assertCapacity({ ...base, depth: 2 })).not.toThrow();
	});

	test("refuses when active is at maxConcurrent", () => {
		expect(() => assertCapacity({ ...base, active: 10 })).toThrow(CapacityError);
		// one below the cap is still allowed
		expect(() => assertCapacity({ ...base, active: 9 })).not.toThrow();
	});

	test("refuses when the parent is at maxAgentsPerLead", () => {
		expect(() => assertCapacity({ ...base, parentActiveChildren: 5 })).toThrow(CapacityError);
	});

	test("ignores the per-lead cap for a top-level spawn (no parent)", () => {
		expect(() =>
			assertCapacity({ ...base, parentAgent: null, parentActiveChildren: 99 }),
		).not.toThrow();
	});

	test("the error is a CapacityError with the CAPACITY_EXCEEDED code", () => {
		try {
			assertCapacity({ ...base, active: 10 });
			throw new Error("expected to throw");
		} catch (e) {
			expect(e).toBeInstanceOf(CapacityError);
			expect((e as CapacityError).code).toBe("CAPACITY_EXCEEDED");
		}
	});
});
