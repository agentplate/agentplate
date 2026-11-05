import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GENERATED_MARKER, writeGeneratedInstructionFile } from "../agents/instruction-file.ts";
import { DEFAULT_CONFIG, serializeConfig, setProjectRootOverride } from "../config.ts";
import { sessionsDbPath } from "../paths.ts";
import { ClaudeRuntime } from "../runtimes/claude.ts";
import { CodexRuntime } from "../runtimes/codex.ts";
import { GeminiRuntime } from "../runtimes/gemini.ts";
import { createSessionStore } from "../sessions/store.ts";
import { createCoordinatorCommand, planCoordinatorLaunch } from "./coordinator.ts";

let root: string;

function initProject(runtime: string): void {
	mkdirSync(join(root, ".agentplate"), { recursive: true });
	const config = structuredClone(DEFAULT_CONFIG);
	config.project.name = "coord-test";
	config.project.root = root;
	config.runtime.default = runtime;
	writeFileSync(join(root, ".agentplate", "config.yaml"), serializeConfig(config), "utf8");
}

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "agentplate-coord-"));
	setProjectRootOverride(root);
});

afterEach(() => {
	setProjectRootOverride(null);
	rmSync(root, { recursive: true, force: true });
	delete process.env.AGENTPLATE_MOCK_INTERACTIVE;
});

async function runCoordinator(args: string[]): Promise<void> {
	const program = createCoordinatorCommand();
	program.exitOverride();
	await program.parseAsync(["node", "coordinator", ...args]);
}

describe("coordinator start", () => {
	test("--no-attach registers the run + coordinator session without spawning", async () => {
		initProject("mock");
		await runCoordinator(["start", "--no-attach"]);
		const store = createSessionStore(sessionsDbPath(root));
		try {
			const session = store.getSessionByAgent("coordinator");
			expect(session?.state).toBe("working");
			expect(store.listRuns(1).length).toBe(1);
		} finally {
			store.close();
		}
	});

	test("interactive (mock runtime) spawns then marks the coordinator stopped", async () => {
		initProject("mock");
		// Mock interactive session exits immediately (a no-op), so the spawn path
		// runs end to end without forking a real claude.
		process.env.AGENTPLATE_MOCK_INTERACTIVE = "true";
		await runCoordinator(["start"]);
		const store = createSessionStore(sessionsDbPath(root));
		try {
			const session = store.getSessionByAgent("coordinator");
			// After the (instant) mock session exits, the coordinator is stopped.
			expect(session?.state).toBe("stopped");
		} finally {
			store.close();
		}
	});

	test("the coordinator chat carries its own mail identity, so it never mails as 'operator'", async () => {
		initProject("mock");
		process.env.AGENTPLATE_MOCK_INTERACTIVE = `printf '%s' "\${AGENTPLATE_AGENT_NAME-unset}" > who.txt`;
		await runCoordinator(["start"]);
		expect(readFileSync(join(root, "who.txt"), "utf8")).toBe("coordinator");
	});

	test("interactive start never overwrites the operator's root instruction file", async () => {
		initProject("mock");
		// The mock runtime reads its role from <root>/CLAUDE.md (no system-prompt flag).
		const operatorFile = join(root, "CLAUDE.md");
		writeFileSync(operatorFile, "# Hand-written project rules\n", "utf8");
		// Snapshot what the live session sees at the root while it runs.
		process.env.AGENTPLATE_MOCK_INTERACTIVE = "cp CLAUDE.md seen.md";
		await runCoordinator(["start"]);
		expect(readFileSync(join(root, "seen.md"), "utf8")).toBe("# Hand-written project rules\n");
		expect(readFileSync(operatorFile, "utf8")).toBe("# Hand-written project rules\n");
	});

	test("interactive start generates an absent instruction file and removes it on exit", async () => {
		initProject("mock");
		process.env.AGENTPLATE_MOCK_INTERACTIVE = "cp CLAUDE.md seen.md";
		await runCoordinator(["start"]);
		const seen = readFileSync(join(root, "seen.md"), "utf8");
		expect(seen.startsWith(GENERATED_MARKER)).toBe(true);
		expect(seen).toContain("COORDINATOR");
		expect(existsSync(join(root, "CLAUDE.md"))).toBe(false);
	});

	test("status reports the coordinator after start", async () => {
		initProject("mock");
		await runCoordinator(["start", "--no-attach"]);
		// Should not throw; the session exists.
		await runCoordinator(["status", "--json"]);
		expect(true).toBe(true);
	});
});

describe("planCoordinatorLaunch", () => {
	const systemPrompt = "# Run context\n\nYou are the COORDINATOR.";
	const base = { model: "m", systemPrompt, permissionMode: "bypass" as const };

	test("claude: role goes via --append-system-prompt; .claude/CLAUDE.md is not touched", () => {
		const path = join(root, ".claude", "CLAUDE.md");
		mkdirSync(join(root, ".claude"), { recursive: true });
		writeFileSync(path, "# Operator's Claude rules\n", "utf8");
		const launch = planCoordinatorLaunch(root, new ClaudeRuntime(), base);
		expect(launch.argv).toContain("--append-system-prompt");
		expect(launch.argv).toContain(systemPrompt);
		expect(launch.generatedFile).toBeNull();
		expect(launch.seededBecause).toBeNull();
		expect(readFileSync(path, "utf8")).toBe("# Operator's Claude rules\n");
	});

	test("claude: no instruction file is created at the root when none exists", () => {
		planCoordinatorLaunch(root, new ClaudeRuntime(), base);
		expect(existsSync(join(root, ".claude", "CLAUDE.md"))).toBe(false);
	});

	test("codex: an existing AGENTS.md is left untouched and the role is seeded instead", () => {
		const path = join(root, "AGENTS.md");
		writeFileSync(path, "# Team AGENTS.md\n", "utf8");
		const launch = planCoordinatorLaunch(root, new CodexRuntime(), {
			...base,
			initialMessage: "build a todo app",
		});
		expect(readFileSync(path, "utf8")).toBe("# Team AGENTS.md\n");
		expect(launch.generatedFile).toBeNull();
		expect(launch.seededBecause).toMatch(/AGENTS\.md/);
		const seed = launch.argv.at(-1) ?? "";
		expect(seed.startsWith(systemPrompt)).toBe(true);
		expect(seed.endsWith("build a todo app")).toBe(true);
	});

	test("gemini: writes GEMINI.md only when absent, stamped as Agentplate-generated", () => {
		const launch = planCoordinatorLaunch(root, new GeminiRuntime(), base);
		const path = join(root, "GEMINI.md");
		expect(launch.generatedFile).toBe(path);
		expect(launch.seededBecause).toBeNull();
		const onDisk = readFileSync(path, "utf8");
		expect(onDisk.startsWith(GENERATED_MARKER)).toBe(true);
		expect(onDisk).toContain(systemPrompt);
		// The role is in the file, so it is not also seeded as a chat message.
		expect(launch.argv.some((a) => a.includes(systemPrompt))).toBe(false);
	});

	test("codex: a stale Agentplate-generated AGENTS.md is refreshed", () => {
		writeGeneratedInstructionFile(root, "AGENTS.md", "stale role from a crashed run");
		const launch = planCoordinatorLaunch(root, new CodexRuntime(), base);
		expect(launch.generatedFile).toBe(join(root, "AGENTS.md"));
		const onDisk = readFileSync(join(root, "AGENTS.md"), "utf8");
		expect(onDisk).toContain(systemPrompt);
		expect(onDisk).not.toContain("stale role");
	});
});
