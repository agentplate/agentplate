/**
 * Tests for the full agent-data purge ("clear the Office").
 *
 * Per project policy nothing is mocked: a real temp project root holds real
 * SQLite stores (sessions/events/merge/mail) at their canonical paths, plus a
 * real on-disk agent state dir and spec file. We seed each store, run
 * `purgeAgentData`, and assert that every trace of the agent is gone while a
 * second agent's data is untouched.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEventStore } from "../events/store.ts";
import { createMailStore } from "../mail/store.ts";
import { createMergeQueue } from "../merge/queue.ts";
import {
	agentStateDir,
	eventsDbPath,
	mailDbPath,
	mergeDbPath,
	sessionsDbPath,
	specPath,
} from "../paths.ts";
import type { AgentSession } from "../types.ts";
import { type PurgeStores, purgeAgentData } from "./purge.ts";
import { createSessionStore } from "./store.ts";

function mk(root: string, overrides: Partial<AgentSession>): AgentSession {
	const now = new Date().toISOString();
	return {
		id: `s-${overrides.agentName ?? "a"}`,
		agentName: "a",
		capability: "builder",
		taskId: "task-1",
		runId: "run-1",
		worktreePath: join(root, ".agentplate", "worktrees", overrides.agentName ?? "a"),
		branchName: "agentplate/a",
		state: "stopped",
		parentAgent: null,
		depth: 1,
		pid: null,
		runtimeSessionId: null,
		startedAt: now,
		lastActivity: now,
		...overrides,
	};
}

describe("purgeAgentData", () => {
	let root: string;
	let stores: PurgeStores;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "ap-purge-"));
		stores = {
			sessions: createSessionStore(sessionsDbPath(root)),
			events: createEventStore(eventsDbPath(root)),
			merge: createMergeQueue(mergeDbPath(root)),
			mail: createMailStore(mailDbPath(root)),
		};
	});

	afterEach(() => {
		stores.sessions.close();
		stores.events.close();
		stores.merge.close();
		stores.mail.close();
		rmSync(root, { recursive: true, force: true });
	});

	test("erases every trace of the agent and reports the counts", () => {
		const session = mk(root, { id: "s-doomed", agentName: "doomed" });
		stores.sessions.upsertSession(session);

		// Seed each store + on-disk artifact for the doomed agent.
		stores.events.record({ agentName: "doomed", runId: "run-1", type: "tool-start" });
		stores.events.record({ agentName: "doomed", runId: "run-1", type: "tool-end" });
		stores.mail.send({ from: "doomed", to: "lead", subject: "s", body: "b", type: "status" });
		stores.mail.send({ from: "lead", to: "doomed", subject: "s", body: "b", type: "dispatch" });
		stores.merge.enqueue({
			branchName: "agentplate/doomed",
			agentName: "doomed",
			taskId: "task-1",
			targetBranch: "main",
		});
		mkdirSync(agentStateDir(root, "doomed"), { recursive: true });
		writeFileSync(join(agentStateDir(root, "doomed"), "identity.yaml"), "sessions: 1\n");
		mkdirSync(join(root, ".agentplate", "specs"), { recursive: true });
		writeFileSync(specPath(root, "task-1"), "# spec\n");

		const report = purgeAgentData(root, session, stores);

		expect(report).toEqual({
			mailDeleted: 2,
			eventsDeleted: 2,
			mergeDeleted: 1,
			stateDirRemoved: true,
			specRemoved: true,
			sessionDeleted: true,
		});
		// Nothing of the agent remains.
		expect(stores.sessions.getSession("s-doomed")).toBeNull();
		expect(stores.events.list({ agentName: "doomed" })).toEqual([]);
		expect(stores.mail.list({ to: "doomed" })).toEqual([]);
		expect(stores.mail.list({ from: "doomed" })).toEqual([]);
		expect(stores.merge.listPending()).toEqual([]);
		expect(existsSync(agentStateDir(root, "doomed"))).toBe(false);
		expect(existsSync(specPath(root, "task-1"))).toBe(false);
	});

	test("leaves a second agent's data untouched", () => {
		const doomed = mk(root, { id: "s-doomed", agentName: "doomed", taskId: "task-1" });
		const keeper = mk(root, { id: "s-keeper", agentName: "keeper", taskId: "task-2" });
		stores.sessions.upsertSession(doomed);
		stores.sessions.upsertSession(keeper);
		stores.events.record({ agentName: "keeper", runId: "run-1", type: "tool-start" });
		stores.mail.send({ from: "keeper", to: "lead", subject: "s", body: "b", type: "status" });

		purgeAgentData(root, doomed, stores);

		expect(stores.sessions.getSession("s-keeper")).not.toBeNull();
		expect(stores.events.list({ agentName: "keeper" }).length).toBe(1);
		expect(stores.mail.list({ from: "keeper" }).length).toBe(1);
	});

	test("keeps the spec file while another session still references the task", () => {
		const a = mk(root, { id: "s-a", agentName: "agent-a", taskId: "shared" });
		const b = mk(root, { id: "s-b", agentName: "agent-b", taskId: "shared" });
		stores.sessions.upsertSession(a);
		stores.sessions.upsertSession(b);
		mkdirSync(join(root, ".agentplate", "specs"), { recursive: true });
		writeFileSync(specPath(root, "shared"), "# shared spec\n");

		// Purging the first sibling keeps the spec (b still uses it).
		const first = purgeAgentData(root, a, stores);
		expect(first.specRemoved).toBe(false);
		expect(existsSync(specPath(root, "shared"))).toBe(true);

		// Purging the last sibling finally removes the spec.
		const second = purgeAgentData(root, b, stores);
		expect(second.specRemoved).toBe(true);
		expect(existsSync(specPath(root, "shared"))).toBe(false);
	});

	test("is resilient when there is nothing to purge", () => {
		const session = mk(root, { id: "s-empty", agentName: "empty" });
		stores.sessions.upsertSession(session);

		const report = purgeAgentData(root, session, stores);
		expect(report.mailDeleted).toBe(0);
		expect(report.eventsDeleted).toBe(0);
		expect(report.mergeDeleted).toBe(0);
		expect(report.stateDirRemoved).toBe(false); // dir never existed
		expect(report.sessionDeleted).toBe(true);
		expect(stores.sessions.getSession("s-empty")).toBeNull();
	});
});
