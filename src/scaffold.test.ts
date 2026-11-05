import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AGENTPLATE_DIR, DEFAULT_CONFIG } from "./config.ts";
import { scaffoldAgentplateDir } from "./scaffold.ts";

let root: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "agentplate-scaffold-"));
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

describe("scaffoldAgentplateDir", () => {
	test("the generated .gitignore keeps runtime state (incl. merge.lock) out of git", () => {
		scaffoldAgentplateDir(root, structuredClone(DEFAULT_CONFIG));
		const lines = readFileSync(join(root, AGENTPLATE_DIR, ".gitignore"), "utf8").split("\n");
		for (const entry of ["merge.lock", "*.db", "secrets.local.yaml", "worktrees/"]) {
			expect(lines).toContain(entry);
		}
	});
});
