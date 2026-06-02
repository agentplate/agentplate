import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG, serializeConfig, setProjectRootOverride } from "../config.ts";
import { sessionsDbPath } from "../paths.ts";
import { createSessionStore } from "../sessions/store.ts";
import { createCoordinatorCommand } from "./coordinator.ts";

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

	test("status reports the coordinator after start", async () => {
		initProject("mock");
		await runCoordinator(["start", "--no-attach"]);
		// Should not throw; the session exists.
		await runCoordinator(["status", "--json"]);
		expect(true).toBe(true);
	});
});
