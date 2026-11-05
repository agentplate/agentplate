/**
 * Tests for the deploy audit store.
 *
 * Uses a real temp-file SQLite database (not a mock and not `:memory:`) so the
 * tests exercise the same WAL-mode file path deployer/verifier agents use in
 * production. Each test gets a fresh file via beforeEach/afterEach.
 */

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DeployAuditRow } from "../types.ts";
import { createDeployAudit, DEPLOY_AUDIT_MIGRATIONS, type DeployAudit } from "./audit.ts";

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

	/** Deployment ids of the release stack, oldest first. */
	function releaseIds(): Array<string | null> {
		return audit.releases("docker-gha", "production").map((r) => r.deploymentId);
	}

	test("releases is empty with no successful real deploy", () => {
		audit.record(newRow({ status: "failed", deploymentId: "A" }));
		audit.record(newRow({ dryRun: true, deploymentId: "B" }));
		expect(releaseIds()).toEqual([]);
	});

	test("releases puts the live release last and the one before it second-to-last", () => {
		audit.record(newRow({ deploymentId: "A" }));
		audit.record(newRow({ deploymentId: "B" }));
		// The rollback target is A, not the live (latest) B.
		expect(releaseIds()).toEqual(["A", "B"]);
		expect(audit.latest("docker-gha", "production")?.deploymentId).toBe("B");
	});

	test("releases ignores failed, dry-run, and other target/env rows", () => {
		audit.record(newRow({ deploymentId: "A" }));
		audit.record(newRow({ deploymentId: "X", status: "failed" }));
		audit.record(newRow({ deploymentId: "Y", dryRun: true }));
		audit.record(newRow({ deploymentId: "Z", environment: "staging" }));
		audit.record(newRow({ deploymentId: "W", target: "fly" }));
		audit.record(newRow({ deploymentId: "B" }));
		expect(releaseIds()).toEqual(["A", "B"]);
	});

	test("re-deploying the live release is not a new rollback point", () => {
		audit.record(newRow({ deploymentId: "A" }));
		audit.record(newRow({ deploymentId: "B", commitSha: "first" }));
		audit.record(newRow({ deploymentId: "B", commitSha: "second" }));
		expect(releaseIds()).toEqual(["A", "B"]);
		// The newest row for the live release is the one kept.
		expect(audit.releases("docker-gha", "production").at(-1)?.commitSha).toBe("second");
	});

	test("a rollback unwinds the stack, so the rolled-back release is never restored", () => {
		audit.record(newRow({ deploymentId: "A" }));
		audit.record(newRow({ deploymentId: "B" }));
		audit.record(newRow({ action: "rollback", deploymentId: "A" }));
		// A is live again and nothing older exists: no roll-forward to bad B.
		expect(releaseIds()).toEqual(["A"]);
		// A new release C after the rollback rolls back to A, skipping B.
		audit.record(newRow({ deploymentId: "C" }));
		expect(releaseIds()).toEqual(["A", "C"]);
	});

	test("consecutive rollbacks walk further back", () => {
		audit.record(newRow({ deploymentId: "A" }));
		audit.record(newRow({ deploymentId: "B" }));
		audit.record(newRow({ deploymentId: "C" }));
		audit.record(newRow({ action: "rollback", deploymentId: "B" }));
		expect(releaseIds()).toEqual(["A", "B"]);
		// A failed rollback changes nothing.
		audit.record(newRow({ action: "rollback", deploymentId: "A", status: "failed" }));
		expect(releaseIds()).toEqual(["A", "B"]);
	});

	test("a rollback to a release not in the stack fails closed (no rollback target)", () => {
		audit.record(newRow({ deploymentId: "A" }));
		audit.record(newRow({ deploymentId: "B" }));
		audit.record(newRow({ action: "rollback", deploymentId: "unknown" }));
		expect(releaseIds()).toEqual([]);
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

	test("newest-first list() is served by the created_at index (no full scan + temp sort)", () => {
		const db = new Database(dbPath);
		try {
			// The same ORDER BY DeployAudit.list() uses.
			const detail = (
				db
					.query(
						"EXPLAIN QUERY PLAN SELECT * FROM deploy_audit ORDER BY created_at DESC, seq DESC LIMIT 100",
					)
					.all() as Array<{ detail: string }>
			)
				.map((r) => r.detail)
				.join("\n");
			expect(detail).toContain("idx_deploy_audit_created");
			expect(detail).not.toContain("TEMP B-TREE");
			const { user_version } = db.query("PRAGMA user_version").get() as { user_version: number };
			expect(user_version).toBe(DEPLOY_AUDIT_MIGRATIONS.at(-1)?.version ?? -1);
		} finally {
			db.close();
		}
	});

	test("a pre-versioning deploys.db is upgraded in place and keeps its rows", () => {
		const stored = audit.record(newRow());
		audit.close();
		const raw = new Database(dbPath);
		raw.exec("DROP INDEX idx_deploy_audit_created");
		raw.exec("PRAGMA user_version = 0");
		raw.close();

		audit = createDeployAudit(dbPath);
		expect(audit.list().map((r) => r.id)).toEqual([stored.id]);
		const check = new Database(dbPath);
		const index = check
			.query("SELECT name FROM sqlite_master WHERE name = 'idx_deploy_audit_created'")
			.get();
		check.close();
		expect(index).not.toBeNull();
	});
});
