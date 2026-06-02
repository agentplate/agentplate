/**
 * SQLite-backed deploy audit store (append-only).
 *
 * Every deploy/rollback the pipeline executes writes one immutable row here
 * (`deploys.db`). The audit log is the source of truth for *what shipped where*:
 * `ap deploy status` reads it, and rollback uses {@link DeployAudit.latest} to
 * find the last good deployment id to revert to.
 *
 * Design notes:
 * - Opened through {@link openDatabase} (WAL mode + busy timeout) because deployer
 *   and verifier agents may write/read concurrently.
 * - Columns are snake_case (SQL idiom); the public {@link DeployAuditRow} shape is
 *   camelCase. {@link rowToAuditRow} is the single translation point.
 * - `dry_run` is stored as an INTEGER (0/1) because SQLite has no boolean type.
 * - `urls` (string[]) and `outputs` (Record<string,string>) are serialized as JSON
 *   text and round-tripped on read.
 * - NEVER store secrets. There is deliberately no secrets column; the caller
 *   guarantees `outputs`/`urls` are already redacted (see logging/sanitizer.ts).
 * - Greenfield schema: `CREATE TABLE IF NOT EXISTS` is the whole story, no
 *   migrations.
 */

import { openDatabase } from "../db/sqlite.ts";
import type { DeployAuditRow } from "../types.ts";

/** Filters accepted by {@link DeployAudit.list}. */
export interface DeployAuditFilter {
	target?: string;
	environment?: string;
	/** Cap the number of rows returned (newest first). */
	limit?: number;
}

/** The deploy audit storage contract. */
export interface DeployAudit {
	/** Persist one audit row; assigns id + createdAt and returns the stored view. */
	record(row: Omit<DeployAuditRow, "id" | "createdAt">): DeployAuditRow;
	/** Query rows with optional filters, newest first. */
	list(filter?: DeployAuditFilter): DeployAuditRow[];
	/** Most recent successful *deploy* for a target+environment (rollback target). */
	latest(target: string, environment: string): DeployAuditRow | null;
	/** Close the underlying database connection. */
	close(): void;
}

/**
 * Row shape as stored in SQLite. Distinct from {@link DeployAuditRow} because
 * columns are snake_case, `dry_run` is an integer, and `urls`/`outputs` are JSON
 * text rather than structured values.
 */
interface AuditRow {
	/** Monotonic insertion sequence; the deterministic ordering tiebreak. */
	seq: number;
	id: string;
	run_id: string | null;
	agent_name: string;
	target: string;
	environment: string;
	action: string;
	dry_run: number;
	gate_decision: string;
	approved_by: string | null;
	status: string;
	deployment_id: string | null;
	urls: string;
	outputs: string;
	commit_sha: string;
	created_at: string;
}

const CREATE_TABLE = `
CREATE TABLE IF NOT EXISTS deploy_audit (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  run_id TEXT,
  agent_name TEXT NOT NULL,
  target TEXT NOT NULL,
  environment TEXT NOT NULL,
  action TEXT NOT NULL,
  dry_run INTEGER NOT NULL DEFAULT 0,
  gate_decision TEXT NOT NULL,
  approved_by TEXT,
  status TEXT NOT NULL,
  deployment_id TEXT,
  urls TEXT NOT NULL DEFAULT '[]',
  outputs TEXT NOT NULL DEFAULT '{}',
  commit_sha TEXT NOT NULL,
  created_at TEXT NOT NULL
)`;

// The hot read path is rollback lookup: most recent successful deploy for a
// (target, environment). Index those three columns up front, not per query.
const CREATE_INDEXES = `
CREATE INDEX IF NOT EXISTS idx_deploy_audit_lookup
  ON deploy_audit(target, environment, status)`;

/** Parse a JSON text column into a string array (tolerates legacy/empty values). */
function parseUrls(text: string): string[] {
	const parsed: unknown = JSON.parse(text);
	if (!Array.isArray(parsed)) {
		return [];
	}
	return parsed.filter((item): item is string => typeof item === "string");
}

/** Parse a JSON text column into a string→string map (tolerates legacy/empty values). */
function parseOutputs(text: string): Record<string, string> {
	const parsed: unknown = JSON.parse(text);
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
		return {};
	}
	const out: Record<string, string> = {};
	for (const [key, value] of Object.entries(parsed)) {
		if (typeof value === "string") {
			out[key] = value;
		}
	}
	return out;
}

/** Translate a stored row (snake_case, int boolean, JSON text) into a {@link DeployAuditRow}. */
function rowToAuditRow(row: AuditRow): DeployAuditRow {
	return {
		id: row.id,
		runId: row.run_id,
		agentName: row.agent_name,
		target: row.target,
		environment: row.environment,
		// The CHECK-free schema trusts callers (typed at DeployAuditRow) for valid
		// values; narrow back to the unions here so consumers get precise types.
		action: row.action as DeployAuditRow["action"],
		dryRun: row.dry_run === 1,
		gateDecision: row.gate_decision as DeployAuditRow["gateDecision"],
		approvedBy: row.approved_by,
		status: row.status as DeployAuditRow["status"],
		deploymentId: row.deployment_id,
		urls: parseUrls(row.urls),
		outputs: parseOutputs(row.outputs),
		commitSha: row.commit_sha,
		createdAt: row.created_at,
	};
}

/**
 * Open (or create) a deploy audit store backed by the SQLite database at `dbPath`.
 * Pass `":memory:"` for an ephemeral store (used in tests); production uses
 * {@link deploysDbPath}.
 */
export function createDeployAudit(dbPath: string): DeployAudit {
	const db = openDatabase(dbPath);
	db.exec(CREATE_TABLE);
	db.exec(CREATE_INDEXES);

	return {
		record(input: Omit<DeployAuditRow, "id" | "createdAt">): DeployAuditRow {
			const stored: DeployAuditRow = {
				...input,
				id: crypto.randomUUID(),
				createdAt: new Date().toISOString(),
			};

			db.query(
				`INSERT INTO deploy_audit
					(id, run_id, agent_name, target, environment, action, dry_run,
					 gate_decision, approved_by, status, deployment_id, urls, outputs,
					 commit_sha, created_at)
				VALUES
					($id, $runId, $agentName, $target, $environment, $action, $dryRun,
					 $gateDecision, $approvedBy, $status, $deploymentId, $urls, $outputs,
					 $commitSha, $createdAt)`,
			).run({
				$id: stored.id,
				$runId: stored.runId,
				$agentName: stored.agentName,
				$target: stored.target,
				$environment: stored.environment,
				$action: stored.action,
				// SQLite stores booleans as integers.
				$dryRun: stored.dryRun ? 1 : 0,
				$gateDecision: stored.gateDecision,
				$approvedBy: stored.approvedBy,
				$status: stored.status,
				$deploymentId: stored.deploymentId,
				// urls/outputs are JSON-encoded; never store secrets (caller guarantees).
				$urls: JSON.stringify(stored.urls),
				$outputs: JSON.stringify(stored.outputs),
				$commitSha: stored.commitSha,
				$createdAt: stored.createdAt,
			});

			return stored;
		},

		list(filter?: DeployAuditFilter): DeployAuditRow[] {
			// Build the WHERE clause dynamically from whichever filters are set.
			// Parameters are always bound (never interpolated) to avoid injection.
			const conditions: string[] = [];
			const params: Record<string, string | number> = {};

			if (filter?.target !== undefined) {
				conditions.push("target = $target");
				params.$target = filter.target;
			}
			if (filter?.environment !== undefined) {
				conditions.push("environment = $environment");
				params.$environment = filter.environment;
			}

			const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
			// Newest first. The seq tiebreak makes ordering deterministic even when
			// many rows share a created_at (sub-millisecond inserts); UUID ids would not.
			let sql = `SELECT * FROM deploy_audit ${where} ORDER BY created_at DESC, seq DESC`;
			if (filter?.limit !== undefined) {
				sql += " LIMIT $limit";
				params.$limit = filter.limit;
			}

			const rows = db.query(sql).all(params) as AuditRow[];
			return rows.map(rowToAuditRow);
		},

		latest(target: string, environment: string): DeployAuditRow | null {
			// Rollback reverts to the last good *deploy* — a prior rollback is not a
			// state we roll forward to, so restrict action = 'deploy'. Dry runs never
			// mutated the live target, so exclude them too.
			const row = db
				.query(
					`SELECT * FROM deploy_audit
					WHERE target = $target
					  AND environment = $environment
					  AND status = 'success'
					  AND action = 'deploy'
					  AND dry_run = 0
					ORDER BY created_at DESC, seq DESC
					LIMIT 1`,
				)
				.get({ $target: target, $environment: environment }) as AuditRow | null;
			return row ? rowToAuditRow(row) : null;
		},

		close(): void {
			db.close();
		},
	};
}
