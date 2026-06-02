/**
 * Tests for the deploy audit store.
 *
 * Uses a real temp-file SQLite database (not a mock and not `:memory:`) so the
 * tests exercise the same WAL-mode file path deployer/verifier agents use in
 * production. Each test gets a fresh file via beforeEach/afterEach.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DeployAuditRow } from "../types.ts";
import { createDeployAudit, type DeployAudit } from "./audit.ts";

/** Minimal valid audit-row input (no id/createdAt — the store assigns those). */
function newRow(
	overrides: Partial<Omit<DeployAuditRow, "id" | "createdAt">> = {},
): Omit<DeployAuditRow, "id" | "createdAt"> {
	return {
		runId: "run-1",
		agentName: "deployer-1",
		target: "docker-gha",
		environment: "production",
		action: "deploy",
		dryRun: false,
		gateDecision: "auto",
		approvedBy: null,
		status: "success",
		deploymentId: "sha256:abc",
		urls: [],
		outputs: {},
		commitSha: "deadbeef",
		...overrides,
	};
}

describe("deploy audit store", () => {
	let tmpRoot: string;
	let dbPath: string;
	let audit: DeployAudit;

	beforeEach(() => {
		tmpRoot = mkdtempSync(join(tmpdir(), "agentplate-audit-"));
		dbPath = join(tmpRoot, "deploys.db");
		audit = createDeployAudit(dbPath);
	});

	afterEach(() => {
		audit.close();
		rmSync(tmpRoot, { recursive: true, force: true });
	});

	test("record assigns id + createdAt and returns the stored view", () => {
		const stored = audit.record(newRow());

		expect(stored.id).toBeTruthy();
		// crypto.randomUUID() shape.
		expect(stored.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
		expect(stored.createdAt).toBeTruthy();
		expect(new Date(stored.createdAt).toISOString()).toBe(stored.createdAt);
		expect(stored.target).toBe("docker-gha");
		expect(stored.status).toBe("success");
	});

	test("record persists a row retrievable via list", () => {
		const stored = audit.record(newRow());

		const all = audit.list();
		expect(all).toHaveLength(1);
		expect(all[0]?.id).toBe(stored.id);
		expect(all[0]?.agentName).toBe("deployer-1");
		expect(all[0]?.action).toBe("deploy");
		expect(all[0]?.commitSha).toBe("deadbeef");
	});

	test("urls and outputs round-trip through JSON", () => {
		const urls = ["https://app.example.com", "https://app-preview.example.com"];
		const outputs = { region: "us-east-1", digest: "sha256:abc", count: "3" };

		const stored = audit.record(newRow({ urls, outputs }));
		// Returned view from record() already carries the structured values.
		expect(stored.urls).toEqual(urls);
		expect(stored.outputs).toEqual(outputs);

		// And they survive the SQLite JSON round-trip on read.
		const [read] = audit.list();
		expect(read?.urls).toEqual(urls);
		expect(read?.outputs).toEqual(outputs);
	});

	test("empty urls/outputs default to [] and {}", () => {
		audit.record(newRow({ urls: [], outputs: {} }));

		const [read] = audit.list();
		expect(read?.urls).toEqual([]);
		expect(read?.outputs).toEqual({});
	});

	test("dryRun and nullable fields round-trip correctly", () => {
		audit.record(
			newRow({
				dryRun: true,
				runId: null,
				approvedBy: "alice",
				deploymentId: null,
				gateDecision: "approved",
			}),
		);

		const [read] = audit.list();
		expect(read?.dryRun).toBe(true);
		expect(read?.runId).toBeNull();
		expect(read?.approvedBy).toBe("alice");
		expect(read?.deploymentId).toBeNull();
		expect(read?.gateDecision).toBe("approved");
	});

	test("list returns rows newest first", () => {
		const first = audit.record(newRow({ commitSha: "c1" }));
		const second = audit.record(newRow({ commitSha: "c2" }));
		const third = audit.record(newRow({ commitSha: "c3" }));

		const rows = audit.list();
		expect(rows.map((r) => r.id)).toEqual([third.id, second.id, first.id]);
	});

	test("list filters by target", () => {
		audit.record(newRow({ target: "docker-gha" }));
		audit.record(newRow({ target: "fly" }));
		audit.record(newRow({ target: "docker-gha" }));

		const rows = audit.list({ target: "docker-gha" });
		expect(rows).toHaveLength(2);
		expect(rows.every((r) => r.target === "docker-gha")).toBe(true);
	});

	test("list filters by environment", () => {
		audit.record(newRow({ environment: "production" }));
		audit.record(newRow({ environment: "staging" }));
		audit.record(newRow({ environment: "staging" }));

		const rows = audit.list({ environment: "staging" });
		expect(rows).toHaveLength(2);
		expect(rows.every((r) => r.environment === "staging")).toBe(true);
	});

	test("list combines target and environment filters", () => {
		audit.record(newRow({ target: "fly", environment: "production" }));
		audit.record(newRow({ target: "fly", environment: "staging" }));
		audit.record(newRow({ target: "docker-gha", environment: "production" }));

		const rows = audit.list({ target: "fly", environment: "production" });
		expect(rows).toHaveLength(1);
		expect(rows[0]?.target).toBe("fly");
		expect(rows[0]?.environment).toBe("production");
	});

	test("list honors the limit (newest first)", () => {
		const a = audit.record(newRow({ commitSha: "a" }));
		const b = audit.record(newRow({ commitSha: "b" }));
		audit.record(newRow({ commitSha: "c" }));

		const rows = audit.list({ limit: 2 });
		expect(rows).toHaveLength(2);
		// Two newest, so the first-inserted (a) is excluded.
		expect(rows.map((r) => r.commitSha)).toEqual(["c", "b"]);
		expect(rows.map((r) => r.id)).not.toContain(a.id);
		expect(b.id).toBeTruthy();
	});

	test("latest returns null when there is no successful deploy", () => {
		expect(audit.latest("docker-gha", "production")).toBeNull();

		// A failed deploy must not count.
		audit.record(newRow({ status: "failed" }));
		expect(audit.latest("docker-gha", "production")).toBeNull();
	});

	test("latest returns the newest successful deploy", () => {
		audit.record(newRow({ commitSha: "old", deploymentId: "sha256:old" }));
		const newest = audit.record(newRow({ commitSha: "new", deploymentId: "sha256:new" }));

		const latest = audit.latest("docker-gha", "production");
		expect(latest?.id).toBe(newest.id);
		expect(latest?.commitSha).toBe("new");
		expect(latest?.deploymentId).toBe("sha256:new");
	});

	test("latest ignores failed, rollback, and dry-run rows", () => {
		const good = audit.record(newRow({ deploymentId: "sha256:good" }));
		// Newer rows that must NOT be selected as the rollback target:
		audit.record(newRow({ status: "failed", deploymentId: "sha256:failed" }));
		audit.record(newRow({ action: "rollback", deploymentId: "sha256:rolledback" }));
		audit.record(newRow({ dryRun: true, deploymentId: "sha256:dry" }));

		const latest = audit.latest("docker-gha", "production");
		expect(latest?.id).toBe(good.id);
		expect(latest?.deploymentId).toBe("sha256:good");
	});

	test("latest is scoped to the requested target and environment", () => {
		audit.record(newRow({ target: "fly", environment: "production" }));
		audit.record(newRow({ target: "docker-gha", environment: "staging" }));
		const match = audit.record(newRow({ target: "docker-gha", environment: "production" }));
		// A later success for a *different* target/env must not win.
		audit.record(newRow({ target: "fly", environment: "staging" }));

		const latest = audit.latest("docker-gha", "production");
		expect(latest?.id).toBe(match.id);
	});

	test("persists across reopen (real file, WAL mode)", () => {
		const stored = audit.record(newRow({ urls: ["https://x.example"], outputs: { k: "v" } }));
		audit.close();

		const reopened = createDeployAudit(dbPath);
		try {
			const rows = reopened.list();
			expect(rows).toHaveLength(1);
			expect(rows[0]?.id).toBe(stored.id);
			expect(rows[0]?.urls).toEqual(["https://x.example"]);
			expect(rows[0]?.outputs).toEqual({ k: "v" });

			const latest = reopened.latest("docker-gha", "production");
			expect(latest?.id).toBe(stored.id);
		} finally {
			reopened.close();
			// Re-open so the afterEach close() is balanced.
			audit = createDeployAudit(dbPath);
		}
	});
});
