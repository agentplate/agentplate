import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ValidationError } from "../errors.ts";
import type { OverlayConfig } from "../types.ts";
import { generateOverlay, writeOverlay } from "./overlay.ts";

/**
 * Build a fully-populated OverlayConfig, allowing per-test overrides. Defaults
 * exercise the "rich" path (non-empty lists, siblings, spawner); individual
 * tests narrow to the empty/leaf cases as needed.
 */
function makeConfig(overrides: Partial<OverlayConfig> = {}): OverlayConfig {
	return {
		agentName: "builder-alpha",
		capability: "builder",
		taskId: "task-123",
		specPath: ".agentplate/specs/task-123.md",
		branchName: "agent/builder-alpha/task-123",
		worktreePath: "/repo/.agentplate/worktrees/builder-alpha",
		parentAgent: "lead-one",
		depth: 1,
		fileScope: ["src/foo.ts", "src/foo.test.ts"],
		baseDefinition: "# Builder\nYou implement features. UNIQUE_BASE_MARKER.",
		canSpawn: false,
		qualityGates: [
			{ name: "test", command: "bun test", description: "all tests pass" },
			{ name: "lint", command: "biome check .", description: "lint clean" },
		],
		constraints: ["Only touch your file scope", "Never push to main"],
		siblings: ["builder-beta", "builder-gamma"],
		...overrides,
	};
}

describe("generateOverlay", () => {
	test("substitutes every placeholder (no unresolved tokens remain)", () => {
		const out = generateOverlay(makeConfig());
		// The single most important invariant: nothing left to substitute.
		expect(out).not.toContain("{{");
		expect(out).not.toContain("}}");
	});

	test("injects core assignment values", () => {
		const out = generateOverlay(makeConfig());
		expect(out).toContain("builder-alpha");
		expect(out).toContain("task-123");
		expect(out).toContain("builder"); // capability
		expect(out).toContain("agent/builder-alpha/task-123"); // branch
		expect(out).toContain("/repo/.agentplate/worktrees/builder-alpha"); // worktree
		expect(out).toContain("lead-one"); // parent
		expect(out).toContain(".agentplate/specs/task-123.md"); // spec
	});

	test("embeds the base definition verbatim", () => {
		const out = generateOverlay(makeConfig());
		expect(out).toContain("UNIQUE_BASE_MARKER");
	});

	test("renders file scope and constraints as bullet lists", () => {
		const out = generateOverlay(makeConfig());
		expect(out).toContain("- `src/foo.ts`");
		expect(out).toContain("- `src/foo.test.ts`");
		expect(out).toContain("- `Only touch your file scope`");
		expect(out).toContain("- `Never push to main`");
	});

	test("renders quality gates as a numbered checklist with commands", () => {
		const out = generateOverlay(makeConfig());
		expect(out).toContain("1. **test:** `bun test` — all tests pass");
		expect(out).toContain("2. **lint:** `biome check .` — lint clean");
	});

	test("empty list-shaped fields collapse to (none)", () => {
		const out = generateOverlay(
			makeConfig({ fileScope: [], constraints: [], qualityGates: [], siblings: [] }),
		);
		// All four empty sections render the sentinel; assert it appears for each.
		// (At least four occurrences: file scope, constraints, gates, siblings.)
		const occurrences = out.split("(none)").length - 1;
		expect(occurrences).toBeGreaterThanOrEqual(4);
	});

	test("missing specPath renders (none)", () => {
		const out = generateOverlay(makeConfig({ specPath: undefined }));
		expect(out).toContain("**Spec:** (none)");
	});

	test("renders an Applicable Skills section heading", () => {
		const out = generateOverlay(makeConfig());
		expect(out).toContain("## Applicable Skills");
	});

	test("undefined skillsOverlay renders the (none yet) default", () => {
		const out = generateOverlay(makeConfig({ skillsOverlay: undefined }));
		expect(out).toContain("(none yet)");
	});

	test("provided skillsOverlay is rendered verbatim", () => {
		const out = generateOverlay(makeConfig({ skillsOverlay: "SKILL_BLOCK_XYZ" }));
		expect(out).toContain("SKILL_BLOCK_XYZ");
		expect(out).not.toContain("(none yet)");
	});

	test("provided skillsOverlay appears inside the Applicable Skills section", () => {
		// The retrieval renderer emits a self-contained block that already carries
		// the heading; the template substitutes it verbatim.
		const marker = "## Applicable Skills\n\nSKILL_BLOCK_INSIDE_SECTION";
		const out = generateOverlay(makeConfig({ skillsOverlay: marker }));
		const headingIdx = out.indexOf("## Applicable Skills");
		const markerIdx = out.indexOf("SKILL_BLOCK_INSIDE_SECTION");
		// The marker body must appear AFTER the section heading (and at all).
		expect(headingIdx).toBeGreaterThanOrEqual(0);
		expect(markerIdx).toBeGreaterThan(headingIdx);
	});

	test("siblings section names each sibling and warns about rebasing", () => {
		const out = generateOverlay(makeConfig());
		expect(out).toContain("- builder-beta");
		expect(out).toContain("- builder-gamma");
		expect(out.toLowerCase()).toContain("rebase");
	});

	test("leaf agent (canSpawn=false) states the prohibition", () => {
		const out = generateOverlay(makeConfig({ canSpawn: false }));
		expect(out).toContain("may NOT spawn");
		expect(out).not.toContain("agentplate sling <task-id>");
	});

	test("spawner (canSpawn=true) shows a sling example with incremented depth", () => {
		const out = generateOverlay(makeConfig({ canSpawn: true, depth: 1 }));
		expect(out).toContain("agentplate sling <task-id>");
		expect(out).toContain("--depth 2"); // depth + 1
		expect(out).toContain("--parent builder-alpha");
	});

	test("null parentAgent falls back to coordinator", () => {
		const out = generateOverlay(makeConfig({ parentAgent: null }));
		expect(out).toContain("**Parent:** coordinator");
		// And there is no literal "null" leaking into the parent line.
		expect(out).not.toContain("**Parent:** null");
	});

	test("uses the agentplate mail CLI (not ap) for the communication protocol", () => {
		const out = generateOverlay(makeConfig());
		expect(out).toContain("agentplate mail check --agent builder-alpha");
		expect(out).toContain("agentplate mail send");
	});
});

describe("writeOverlay", () => {
	let tempRoot: string;

	beforeEach(() => {
		// Real temp dir that contains the required worktree marker segment so the
		// guard is satisfied for the happy path.
		tempRoot = mkdtempSync(join(tmpdir(), "agentplate-overlay-"));
	});

	afterEach(() => {
		rmSync(tempRoot, { recursive: true, force: true });
	});

	test("writes the rendered overlay under a real worktree path", () => {
		const worktreePath = join(tempRoot, ".agentplate", "worktrees", "builder-alpha");
		const instructionPath = join(".claude", "CLAUDE.md");
		const config = makeConfig({ worktreePath });

		const written = writeOverlay(config, instructionPath);

		expect(written).toBe(join(worktreePath, instructionPath));
		const onDisk = readFileSync(written, "utf8");
		// Round-trips the generated content (creating parent dirs along the way).
		expect(onDisk).toBe(generateOverlay(config));
		expect(onDisk).toContain("builder-alpha");
		expect(onDisk).not.toContain("{{");
	});

	test("throws ValidationError when the path is not a Agentplate worktree", () => {
		// A plausible-but-wrong target: a real project root, no /.agentplate/worktrees/.
		const config = makeConfig({ worktreePath: join(tempRoot, "some-project") });
		expect(() => writeOverlay(config, "CLAUDE.md")).toThrow(ValidationError);
	});

	test("guard message explains why the write was refused", () => {
		const config = makeConfig({ worktreePath: "/Users/me/Projects/real-app" });
		expect(() => writeOverlay(config, "CLAUDE.md")).toThrow(/worktree/i);
	});
});
