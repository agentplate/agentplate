/**
 * Wizard helper tests. The interactive prompts themselves need a TTY, but the
 * pure pieces are unit-tested directly. `detectQualityGates` reads a project's
 * package.json to suggest gate commands.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectQualityGates, localPairingWarning, ollamaContextTip } from "./setup.ts";

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "agentplate-wizard-"));
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe("detectQualityGates", () => {
	test("falls back to stack defaults when there is no package.json", () => {
		const gates = detectQualityGates(dir);
		expect(gates).toEqual([
			{ name: "test", command: "bun test" },
			{ name: "lint", command: "biome check ." },
			{ name: "typecheck", command: "tsc --noEmit" },
		]);
	});

	test("prefers `bun run <script>` for scripts the project defines", () => {
		writeFileSync(
			join(dir, "package.json"),
			JSON.stringify({ scripts: { test: "vitest", typecheck: "tsc -p ." } }),
			"utf8",
		);
		const gates = detectQualityGates(dir);
		const byName = Object.fromEntries(gates.map((g) => [g.name, g.command]));
		expect(byName.test).toBe("bun run test"); // script present → run it
		expect(byName.typecheck).toBe("bun run typecheck"); // script present
		expect(byName.lint).toBe("biome check ."); // no lint script → fallback
	});
});

describe("localPairingWarning", () => {
	const url = "http://localhost:11434";

	test("warns when a keyless local provider is paired with a non-claude runtime", () => {
		const warning = localPairingWarning("none", url, "codex");
		expect(warning).toContain("ANTHROPIC_BASE_URL");
		expect(warning).toContain("'codex'");
	});

	test("no warning for the claude runtime", () => {
		expect(localPairingWarning("none", url, "claude")).toBeNull();
	});

	test("no warning for keyed auth modes", () => {
		expect(localPairingWarning("api-key", url, "codex")).toBeNull();
	});

	test("no warning without a base URL", () => {
		expect(localPairingWarning("none", undefined, "codex")).toBeNull();
	});
});

describe("ollamaContextTip", () => {
	test("returns the num_ctx recipe with the chosen model interpolated", () => {
		const tip = ollamaContextTip("ollama", "qwen3-coder:30b");
		expect(tip).toContain("32k default context window");
		expect(tip).toContain("PARAMETER num_ctx 65536");
		expect(tip).toContain("FROM qwen3-coder:30b");
		expect(tip).toContain("ollama create qwen3-coder:30b-64k -f Modelfile");
	});

	test("returns null for any other provider", () => {
		expect(ollamaContextTip("anthropic", "claude-sonnet-4-5")).toBeNull();
	});
});
