// Runs under the root `bun test` (pure module). Excluded from the UI tsconfig.

import { describe, expect, test } from "bun:test";
import { feedKey, withStableKeys } from "./keys.ts";

const row = (ts: string, summary: string) => ({
	ts,
	agent: "builder-1",
	label: "TOOL+",
	summary,
	kind: "event",
});

describe("withStableKeys", () => {
	test("keys are unique even for identical rows", () => {
		const keys = withStableKeys([row("t1", "a"), row("t1", "a"), row("t2", "b")], feedKey).map(
			(r) => r.key,
		);
		expect(new Set(keys).size).toBe(3);
	});

	test("a row keeps its key when new rows are prepended (unlike index keys)", () => {
		const before = withStableKeys([row("t1", "a"), row("t2", "b")], feedKey);
		const after = withStableKeys([row("t0", "new"), row("t1", "a"), row("t2", "b")], feedKey);
		expect(after[1]?.key).toBe(before[0]?.key ?? "missing");
		expect(after[2]?.key).toBe(before[1]?.key ?? "missing");
	});
});
