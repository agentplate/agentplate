/**
 * Wizard helper tests. The interactive prompts themselves need a TTY, but the
 * pure pieces are unit-tested directly. `detectQualityGates` reads a project's
 * package.json to suggest gate commands.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectQualityGates } from "./setup.ts";

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
