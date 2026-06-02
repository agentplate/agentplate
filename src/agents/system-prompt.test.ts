import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildCoordinatorSystemPrompt, writeCoordinatorSystemPrompt } from "./system-prompt.ts";

const ctx = {
	projectName: "demo",
	runId: "run-abc",
	agentName: "coordinator",
	canonicalBranch: "main",
	instructionPath: "GEMINI.md",
};

describe("buildCoordinatorSystemPrompt", () => {
	test("includes the run context + key CLI verbs", () => {
		const text = buildCoordinatorSystemPrompt(ctx);
		expect(text).toContain("demo");
		expect(text).toContain("run-abc");
		expect(text).toContain("agentplate mail check --agent coordinator");
		expect(text).toContain("agentplate sling");
		// Appends the bundled coordinator base definition.
		expect(text.toLowerCase()).toContain("coordinator");
	});

	test("is provider-agnostic: references the runtime's overlay file, not CLAUDE.md", () => {
		expect(buildCoordinatorSystemPrompt(ctx)).toContain("GEMINI.md");
		expect(buildCoordinatorSystemPrompt({ ...ctx, instructionPath: "AGENTS.md" })).toContain(
			"AGENTS.md",
		);
	});

	test("mandates dispatch-only fan-out (never edit; multiple agents)", () => {
		const text = buildCoordinatorSystemPrompt(ctx).toLowerCase();
		expect(text).toContain("never edit");
		expect(text).toContain("at least two leads");
		expect(text).toContain("dispatcher, not an implementer");
	});
});

describe("writeCoordinatorSystemPrompt", () => {
	test("writes the prompt under the agent state dir", () => {
		const root = mkdtempSync(join(tmpdir(), "agentplate-sp-"));
		try {
			const { path, text } = writeCoordinatorSystemPrompt(root, ctx);
			expect(existsSync(path)).toBe(true);
			expect(readFileSync(path, "utf8")).toBe(text);
			expect(path).toContain(join(".agentplate", "agents", "coordinator"));
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
