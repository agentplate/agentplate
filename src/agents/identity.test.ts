import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import yaml from "js-yaml";
import { ConfigError } from "../errors.ts";
import { type AgentIdentity, createIdentity, loadIdentity, updateIdentity } from "./identity.ts";

// Real filesystem against a throwaway temp dir — no mocks. The module only
// touches the fs + YAML, so a plain temp root (no git) is sufficient.
let root: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "agentplate-identity-"));
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

/** Path where the module is expected to store an agent's CV. */
function identityFile(name: string): string {
	return join(root, ".agentplate", "agents", name, "identity.yaml");
}

describe("createIdentity", () => {
	test("creates the directory and file with sane defaults", () => {
		const id = createIdentity(root, "alice", "builder");

		expect(id.name).toBe("alice");
		expect(id.capability).toBe("builder");
		expect(id.sessionsCompleted).toBe(0);
		expect(id.expertiseDomains).toEqual([]);
		expect(id.recentTasks).toEqual([]);
		// created is an ISO-8601 string.
		expect(new Date(id.created).toISOString()).toBe(id.created);
		expect(existsSync(identityFile("alice"))).toBe(true);
	});

	test("is idempotent: returns existing identity without clobbering history", () => {
		createIdentity(root, "bob", "scout");
		updateIdentity(root, "bob", { taskId: "t-1", summary: "did a thing" });

		// Re-create with a different capability — must NOT reset the CV.
		const again = createIdentity(root, "bob", "reviewer");
		expect(again.capability).toBe("scout"); // original preserved
		expect(again.sessionsCompleted).toBe(1);
		expect(again.recentTasks).toHaveLength(1);
	});
});

describe("loadIdentity", () => {
	test("returns null when no identity exists", () => {
		expect(loadIdentity(root, "ghost")).toBeNull();
	});

	test("round-trips a created identity", () => {
		const created = createIdentity(root, "carol", "lead");
		const loaded = loadIdentity(root, "carol");
		expect(loaded).not.toBeNull();
		expect(loaded).toEqual(created);
	});

	test("treats an empty file as no identity", () => {
		const path = identityFile("empty");
		// Create the dir via a real identity first, then blank the file.
		createIdentity(root, "empty", "builder");
		writeFileSync(path, "", "utf8");
		expect(loadIdentity(root, "empty")).toBeNull();
	});

	test("throws ConfigError on malformed YAML", () => {
		const path = identityFile("broken");
		createIdentity(root, "broken", "builder");
		writeFileSync(path, "name: [unclosed\n", "utf8");
		expect(() => loadIdentity(root, "broken")).toThrow(ConfigError);
	});
});

describe("updateIdentity", () => {
	test("increments sessionsCompleted on each update", () => {
		createIdentity(root, "dave", "builder");

		const first = updateIdentity(root, "dave", { domains: ["api"] });
		expect(first.sessionsCompleted).toBe(1);

		const second = updateIdentity(root, "dave", { domains: ["db"] });
		expect(second.sessionsCompleted).toBe(2);

		// Persisted, not just in-memory.
		const reloaded = loadIdentity(root, "dave");
		expect(reloaded?.sessionsCompleted).toBe(2);
		expect(reloaded?.expertiseDomains).toEqual(["api", "db"]);
	});

	test("merges domains uniquely, preserving first-seen order", () => {
		createIdentity(root, "erin", "builder");
		updateIdentity(root, "erin", { domains: ["api", "db"] });
		const out = updateIdentity(root, "erin", { domains: ["db", "ui", "api"] });
		expect(out.expertiseDomains).toEqual(["api", "db", "ui"]);
	});

	test("appends a task only when taskId is provided", () => {
		createIdentity(root, "frank", "builder");

		// No taskId -> no task appended, but session still counts.
		const noTask = updateIdentity(root, "frank", { domains: ["api"] });
		expect(noTask.recentTasks).toHaveLength(0);
		expect(noTask.sessionsCompleted).toBe(1);

		const withTask = updateIdentity(root, "frank", {
			taskId: "task-42",
			summary: "implemented endpoint",
		});
		expect(withTask.recentTasks).toHaveLength(1);
		const last = withTask.recentTasks.at(-1);
		expect(last?.taskId).toBe("task-42");
		expect(last?.summary).toBe("implemented endpoint");
		const completedAt = last?.completedAt ?? "";
		expect(new Date(completedAt).toISOString()).toBe(completedAt);
	});

	test("creates an identity on the fly if none exists", () => {
		// No createIdentity call first.
		const id = updateIdentity(root, "grace", { taskId: "t-1", summary: "s" });
		expect(id.sessionsCompleted).toBe(1);
		expect(id.recentTasks).toHaveLength(1);
		expect(existsSync(identityFile("grace"))).toBe(true);
	});

	test("caps recentTasks at 20, keeping the newest (push 25, expect 20)", () => {
		createIdentity(root, "heidi", "builder");

		for (let i = 0; i < 25; i++) {
			updateIdentity(root, "heidi", { taskId: `task-${i}`, summary: `summary ${i}` });
		}

		const loaded = loadIdentity(root, "heidi");
		expect(loaded).not.toBeNull();
		expect(loaded?.recentTasks).toHaveLength(20);
		// Oldest five (task-0..task-4) dropped; newest is last.
		expect(loaded?.recentTasks[0]?.taskId).toBe("task-5");
		expect(loaded?.recentTasks.at(-1)?.taskId).toBe("task-24");
		// 25 updates -> 25 sessions counted regardless of the cap.
		expect(loaded?.sessionsCompleted).toBe(25);
	});
});

describe("on-disk format", () => {
	test("identity.yaml is valid YAML round-trippable by js-yaml", () => {
		createIdentity(root, "ivan", "merger");
		updateIdentity(root, "ivan", { taskId: "t-1", summary: "x", domains: ["api"] });

		const text = readFileSync(identityFile("ivan"), "utf8");
		const parsed = yaml.load(text) as AgentIdentity;
		expect(parsed.name).toBe("ivan");
		expect(parsed.capability).toBe("merger");
		expect(parsed.expertiseDomains).toEqual(["api"]);
		expect(parsed.recentTasks[0]?.taskId).toBe("t-1");
	});
});
