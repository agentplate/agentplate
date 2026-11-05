/**
 * `agentplate target`, `agentplate deploy`, and `agentplate rollback` — the operator
 * surface for the build → CI/CD → deploy pipeline.
 *
 * These commands are deliberately thin: every consequential decision lives in
 * the deploy core (registry/context/secrets/audit) and the target adapters. The
 * command layer only resolves a target, detects an {@link AppProfile}, assembles
 * a {@link DeployContext}, applies the *gate policy*, drives the
 * generate → write → deploy → verify sequence, and records one append-only audit
 * row. Secrets flow exclusively through `ctx.secretEnv` (env-by-name) and are
 * never printed; captured target output is already redacted by the adapters.
 *
 * The `deploy`/`rollback`/`detect` actions are exported as standalone helpers so
 * tests can drive them directly without the CLI being registered in `index.ts`.
 * Each helper takes a resolved project `root` plus parsed options and returns a
 * structured result; the Commander actions are thin wrappers that resolve the
 * root, print, and (for `--json`) emit an envelope.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { Command } from "commander";
import { findProjectRoot, isInitialized, loadConfig } from "../config.ts";
import { createDeployAudit } from "../deploy/audit.ts";
import { buildDeployContext } from "../deploy/context.ts";
import { getAllDeployTargets, getDeployTarget } from "../deploy/registry.ts";
import { missingSecretKeys } from "../deploy/secrets.ts";
import type {
	AppProfile,
	DeployContext,
	DeployResult,
	DeployTarget,
	DetectResult,
	GeneratedArtifact,
	VerifyResult,
} from "../deploy/types.ts";
import { NotFoundError, ValidationError } from "../errors.ts";
import { jsonOutput } from "../json.ts";
import { muted, printError, printInfo, printSuccess, printWarning } from "../logging/color.ts";
import { currentRunPath, deploysDbPath } from "../paths.ts";
import type { DeployAuditRow } from "../types.ts";

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** Resolve + require an initialized project root (honors `--project`). */
function requireInit(): string {
	const root = findProjectRoot();
	if (!isInitialized(root)) {
		throw new ValidationError("Not initialized. Run `agentplate setup` first.");
	}
	return root;
}

/** Read the active run id from `.agentplate/current-run.txt`, or null when unset. */
function readCurrentRun(root: string): string | null {
	const path = currentRunPath(root);
	if (!existsSync(path)) return null;
	try {
		const trimmed = readFileSync(path, "utf8").trim();
		return trimmed === "" ? null : trimmed;
	} catch {
		return null;
	}
}

/**
 * Best-effort current commit sha for the audit row. Never throws: a project may
 * be a non-git directory or have no commits yet, in which case the audit records
 * an empty sha rather than failing the deploy.
 */
async function readCommitSha(root: string): Promise<string> {
	try {
		const proc = Bun.spawn(["git", "rev-parse", "HEAD"], {
			cwd: root,
			stdout: "pipe",
			stderr: "pipe",
		});
		const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
		if (exitCode !== 0) return "";
		return stdout.trim();
	} catch {
		return "";
	}
}

/**
 * Resolve a generated artifact's absolute path under `root`. The artifact `path`
 * is contract-defined as *relative to the worktree root*; an absolute path is
 * rejected so a target can never escape the project tree.
 */
function artifactPath(root: string, artifact: GeneratedArtifact): string {
	if (isAbsolute(artifact.path)) {
		throw new ValidationError(
			`Generated artifact path must be relative to the project root: "${artifact.path}"`,
		);
	}
	const target = resolve(root, artifact.path);
	// Defense in depth: refuse paths that resolve outside the project root.
	const rootResolved = resolve(root);
	if (target !== rootResolved && !target.startsWith(`${rootResolved}/`)) {
		throw new ValidationError(
			`Generated artifact path escapes the project root: "${artifact.path}"`,
		);
	}
	return target;
}

/** What the engine does (or, on a dry run, would do) with one generated artifact. */
export interface ArtifactPlan {
	/** Path relative to the project root, as the target emitted it. */
	path: string;
	/** Absolute path under the project root. */
	absolutePath: string;
	kind: GeneratedArtifact["kind"];
	/**
	 * "create" — no file exists yet; "unchanged" — the existing file already
	 * matches; "keep" — an existing, different file is left alone (no --force);
	 * "overwrite" — an existing, different file is replaced (--force).
	 */
	action: "create" | "unchanged" | "keep" | "overwrite";
	/** True only once the file has actually been written (never on a dry run). */
	written: boolean;
	/** The generated content (so a dry run can be diffed without writing). */
	content: string;
}

/**
 * Decide, per artifact, whether writing it would create, overwrite, or leave a
 * file alone. An existing file the operator (or an agent) wrote is never
 * replaced unless `force` is set. Read-only.
 */
function planArtifacts(
	root: string,
	artifacts: GeneratedArtifact[],
	force: boolean,
): ArtifactPlan[] {
	return artifacts.map((artifact) => {
		const absolutePath = artifactPath(root, artifact);
		let action: ArtifactPlan["action"] = "create";
		if (existsSync(absolutePath)) {
			let existing: string | null = null;
			try {
				existing = readFileSync(absolutePath, "utf8");
			} catch {
				existing = null;
			}
			if (existing === artifact.content) action = "unchanged";
			else action = force ? "overwrite" : "keep";
		}
		return {
			path: artifact.path,
			absolutePath,
			kind: artifact.kind,
			action,
			written: false,
			content: artifact.content,
		};
	});
}

/**
 * Write the artifacts planned as "create" or "overwrite", creating parent
 * directories as needed and honoring the optional file `mode` (default 0o644).
 */
function writePlannedArtifacts(plans: ArtifactPlan[], artifacts: GeneratedArtifact[]): void {
	plans.forEach((plan, i) => {
		if (plan.action !== "create" && plan.action !== "overwrite") return;
		mkdirSync(dirname(plan.absolutePath), { recursive: true });
		writeFileSync(plan.absolutePath, plan.content, { mode: artifacts[i]?.mode ?? 0o644 });
		plan.written = true;
	});
}

/** Environments named like production (prod, production, prod-eu, preprod, …). */
const PRODUCTION_LIKE = /prod/i;

/**
 * Resolve the gate policy for an environment. Fails closed:
 *  - a production-like environment always requires confirmation (`--yes`);
 *  - otherwise only an explicit `"auto"` skips confirmation — a missing entry or
 *    any other value (a typo like `Confirm`, `manual`, `true`) means "confirm".
 */
export function gatePolicyFor(
	config: ReturnType<typeof loadConfig>,
	environment: string,
): "confirm" | "auto" {
	if (PRODUCTION_LIKE.test(environment)) return "confirm";
	const configured: unknown = config.deploy.gates[environment];
	return configured === "auto" ? "auto" : "confirm";
}

/**
 * Reject an environment the target does not declare. An unknown (or mistyped)
 * `--env` must never slip past the gate or reach generated config.
 */
function assertKnownEnvironment(target: DeployTarget, environment: string): void {
	if (!target.caps.environments.includes(environment)) {
		throw new ValidationError(
			`Unknown environment ${JSON.stringify(environment)} for target "${target.id}". ` +
				`Known environments: ${target.caps.environments.join(", ")}`,
		);
	}
}

// ---------------------------------------------------------------------------
// target list / detect / configure
// ---------------------------------------------------------------------------

/** A flattened, JSON-friendly view of a registered target for `target list`. */
interface TargetListItem {
	id: string;
	label: string;
	description: string;
	stability: DeployTarget["stability"];
	caps: DeployTarget["caps"];
}

/** Build the `target list` payload from the registry (no project state needed). */
export function buildTargetList(): TargetListItem[] {
	return getAllDeployTargets().map((t) => ({
		id: t.id,
		label: t.label,
		description: t.description,
		stability: t.stability,
		caps: t.caps,
	}));
}

/** One target's detection outcome, used by `target detect`. */
interface TargetDetection {
	id: string;
	label: string;
	stability: DeployTarget["stability"];
	detect: DetectResult;
}

/** The full `target detect` result: every target ranked, plus the winner. */
export interface DetectReport {
	dir: string;
	detections: TargetDetection[];
	/** Highest-confidence *fitting* target id, or null when nothing fits. */
	chosenTarget: string | null;
	/** The chosen target's detected profile, or null when nothing fits. */
	chosenProfile: AppProfile | null;
}

/**
 * Run every registered target's `detect()` against `dir`, rank by descending
 * confidence (fitting targets first), and pick the best fit. Pure read-only.
 */
export async function detectTargets(dir: string): Promise<DetectReport> {
	const detections: TargetDetection[] = [];
	for (const target of getAllDeployTargets()) {
		const detect = await target.detect(dir);
		detections.push({ id: target.id, label: target.label, stability: target.stability, detect });
	}
	// Sort fitting targets ahead of non-fitting, then by confidence desc.
	detections.sort((a, b) => {
		if (a.detect.fit !== b.detect.fit) return a.detect.fit ? -1 : 1;
		return b.detect.confidence - a.detect.confidence;
	});
	const best = detections.find((d) => d.detect.fit) ?? null;
	return {
		dir,
		detections,
		chosenTarget: best ? best.id : null,
		chosenProfile: best ? best.detect.profile : null,
	};
}

/** The `target configure` payload: which secret env-var names a target needs. */
export interface ConfigureReport {
	target: string;
	label: string;
	environments: string[];
	/** Env-var NAMES required at deploy time (from a dry generateConfig). */
	requiredSecretKeys: string[];
	/** Subset of `requiredSecretKeys` not yet resolvable from file or env. */
	missingSecretKeys: string[];
}

/**
 * Compute the secret keys a target needs, by running `generateConfig` on a
 * dry-run context (the only side-effect-free way to learn `requiredSecretKeys`
 * without writing anything). Used by `target configure` to tell the operator
 * exactly which env vars to provide.
 */
export async function configureTarget(
	root: string,
	name: string,
	environment: string,
): Promise<ConfigureReport> {
	const config = loadConfig(root);
	const target = getDeployTarget(name, config);
	assertKnownEnvironment(target, environment);
	const detect = await target.detect(root);
	const ctx = buildDeployContext({
		root,
		worktreePath: root,
		target,
		environment,
		profile: detect.profile,
		dryRun: true,
		runId: readCurrentRun(root),
		agentName: "operator",
		config,
	});
	const generated = await target.generateConfig(ctx);
	return {
		target: target.id,
		label: target.label,
		environments: target.caps.environments,
		requiredSecretKeys: generated.requiredSecretKeys,
		missingSecretKeys: missingSecretKeys(root, generated.requiredSecretKeys),
	};
}

// ---------------------------------------------------------------------------
// deploy
// ---------------------------------------------------------------------------

/** Options accepted by {@link runDeploy} (already parsed from the CLI). */
export interface DeployOptions {
	target?: string;
	environment: string;
	dryRun: boolean;
	yes: boolean;
	/** Overwrite existing files that differ from the generated config. */
	force?: boolean;
	agentName: string;
}

/** Why a deploy was refused, when it was. */
export type GateOutcome = DeployAuditRow["gateDecision"];

/** Structured result of {@link runDeploy}, suitable for `--json` and printing. */
export interface DeployRunResult {
	target: string;
	environment: string;
	dryRun: boolean;
	/** "auto" | "approved" | "denied" | "n/a" — what the gate decided. */
	gateDecision: GateOutcome;
	/** Set when the gate denied the deploy (no artifacts written, no deploy run). */
	refused: boolean;
	/** Human-readable reason for a refusal (else null). */
	refusalReason: string | null;
	summary: string;
	/** Paths (absolute) of artifacts written to the project root (none on a dry run). */
	writtenArtifacts: string[];
	/** Per-artifact plan: created, unchanged, kept (existing file), or overwritten. */
	artifacts: ArtifactPlan[];
	requiredSecretKeys: string[];
	missingSecretKeys: string[];
	/** The deploy execution result (null when refused, or when dry-run skips it). */
	deploy: DeployResult | null;
	/** The verify result (null unless a real deploy succeeded enough to verify). */
	verify: VerifyResult | null;
	/** The audit row written (null for a refusal — refusals are recorded too). */
	audit: DeployAuditRow | null;
}

/**
 * Execute (or plan) a deployment end to end.
 *
 * Sequence:
 *  1. Resolve the target (explicit `--target`, else `config.deploy.default`) and
 *     reject an environment the target does not declare.
 *  2. Detect the {@link AppProfile} on the project root.
 *  3. Build a {@link DeployContext} (`dryRun` from `--dry-run`).
 *  4. Apply the gate (see {@link gatePolicyFor}, which fails closed): refuse when
 *     `(policy === "confirm" || caps.irreversible)` and neither `--yes` nor a
 *     dry-run is in play — recording a "denied" audit row and stopping.
 *  5. `generateConfig` → plan each artifact against the project root. Existing
 *     files that differ are kept unless `--force`.
 *  6. Real run only: fail fast when any required secret is missing (before any
 *     file is written); write the planned artifacts; then `deploy()` and, on
 *     success, `verify()`.
 *  7. Write one audit row (carrying the dryRun flag, gate decision, status).
 *
 * A dry-run writes nothing: it reports the artifact plan (with content, so it
 * can be diffed) but never calls `deploy()` and never records a *success*; it
 * records a `dryRun:true` row so the plan is auditable without implying anything
 * shipped. `ctx.secretEnv` is never printed or persisted.
 */
export async function runDeploy(root: string, opts: DeployOptions): Promise<DeployRunResult> {
	const config = loadConfig(root);
	const target = getDeployTarget(opts.target, config);
	const environment = opts.environment;
	assertKnownEnvironment(target, environment);

	const detect = await target.detect(root);
	const ctx: DeployContext = buildDeployContext({
		root,
		worktreePath: root,
		target,
		environment,
		profile: detect.profile,
		dryRun: opts.dryRun,
		runId: readCurrentRun(root),
		agentName: opts.agentName,
		config,
	});

	const policy = gatePolicyFor(config, environment);
	const gateRequiresConfirm = policy === "confirm" || target.caps.irreversible;
	const commitSha = await readCommitSha(root);
	const audit = createDeployAudit(deploysDbPath(root));

	try {
		// --- Gate: refuse a confirm-required / irreversible deploy without --yes.
		// Dry runs are exempt (they never mutate the live target).
		if (gateRequiresConfirm && !opts.yes && !opts.dryRun) {
			const reason =
				`Deploy to "${environment}" via "${target.id}" requires confirmation` +
				(target.caps.irreversible ? " (target is irreversible)" : ` (gate policy: ${policy})`) +
				". Re-run with --yes to approve.";
			const row = audit.record({
				runId: ctx.runId,
				agentName: ctx.agentName,
				target: target.id,
				environment,
				action: "deploy",
				dryRun: false,
				gateDecision: "denied",
				approvedBy: null,
				status: "failed",
				deploymentId: null,
				urls: [],
				outputs: {},
				commitSha,
			});
			return {
				target: target.id,
				environment,
				dryRun: false,
				gateDecision: "denied",
				refused: true,
				refusalReason: reason,
				summary: reason,
				writtenArtifacts: [],
				artifacts: [],
				requiredSecretKeys: [],
				missingSecretKeys: [],
				deploy: null,
				verify: null,
				audit: row,
			};
		}

		// We are past the refusal gate, so this deploy is allowed to proceed. The
		// decision recorded on the audit row is "approved" when the operator passed
		// --yes (an explicit go-ahead), otherwise "auto" — covering both an auto
		// gate and the dry-run exemption of a confirm gate (a dry-run is never a
		// live approval, so without --yes it stays "auto").
		const gateDecision: GateOutcome = opts.yes ? "approved" : "auto";

		// --- Generate + plan artifacts. Nothing is written yet: a dry run never
		// writes, and an existing file is never replaced without --force.
		const generated = await target.generateConfig(ctx);
		const artifacts = planArtifacts(root, generated.artifacts, opts.force === true);

		const missing = missingSecretKeys(root, generated.requiredSecretKeys);

		// --- Dry-run: plan only. No writes, no deploy(), no verify(), no success row.
		if (opts.dryRun) {
			const row = audit.record({
				runId: ctx.runId,
				agentName: ctx.agentName,
				target: target.id,
				environment,
				action: "deploy",
				dryRun: true,
				gateDecision,
				approvedBy: null,
				// A planned dry-run is itself a success (it produced a plan); the
				// dryRun flag makes clear nothing shipped, and latest() excludes it.
				status: "success",
				deploymentId: null,
				urls: [],
				outputs: {},
				commitSha,
			});
			return {
				target: target.id,
				environment,
				dryRun: true,
				gateDecision,
				refused: false,
				refusalReason: null,
				summary: generated.summary,
				writtenArtifacts: [],
				artifacts,
				requiredSecretKeys: generated.requiredSecretKeys,
				missingSecretKeys: missing,
				deploy: null,
				verify: null,
				audit: row,
			};
		}

		// --- Real run: fail fast on missing secrets before any mutation.
		if (missing.length > 0) {
			throw new ValidationError(
				`Cannot deploy to "${environment}" via "${target.id}": missing required secret(s): ` +
					`${missing.join(", ")}. Add them with \`agentplate setup\` or via the environment.`,
			);
		}

		writePlannedArtifacts(artifacts, generated.artifacts);
		const writtenArtifacts = artifacts.filter((a) => a.written).map((a) => a.absolutePath);

		// --- Execute + verify.
		const deployResult = await target.deploy(ctx);
		let verifyResult: VerifyResult | null = null;
		if (deployResult.ok) {
			verifyResult = await target.verify(ctx, deployResult);
		}

		const row = audit.record({
			runId: ctx.runId,
			agentName: ctx.agentName,
			target: target.id,
			environment,
			action: "deploy",
			dryRun: false,
			gateDecision,
			approvedBy: gateDecision === "approved" ? ctx.agentName : null,
			status: deployResult.ok ? "success" : "failed",
			deploymentId: deployResult.deploymentId,
			urls: deployResult.urls,
			outputs: deployResult.outputs,
			commitSha,
		});

		return {
			target: target.id,
			environment,
			dryRun: false,
			gateDecision,
			refused: false,
			refusalReason: null,
			summary: generated.summary,
			writtenArtifacts,
			artifacts,
			requiredSecretKeys: generated.requiredSecretKeys,
			missingSecretKeys: [],
			deploy: deployResult,
			verify: verifyResult,
			audit: row,
		};
	} finally {
		audit.close();
	}
}

// ---------------------------------------------------------------------------
// rollback
// ---------------------------------------------------------------------------

/** Options accepted by {@link runRollback}. */
export interface RollbackOptions {
	target?: string;
	environment: string;
	/** Approve a rollback into an environment whose gate requires confirmation. */
	yes?: boolean;
	agentName: string;
}

/** Structured result of {@link runRollback}. */
export interface RollbackRunResult {
	target: string;
	environment: string;
	/** The audit row of the release live now, being rolled back from. */
	current: DeployAuditRow | null;
	/** The audit row of the previous release, being restored. */
	previous: DeployAuditRow | null;
	/** "auto" | "approved" | "denied" — what the gate decided. */
	gateDecision: GateOutcome;
	/** Set when the gate denied the rollback (target.rollback was not called). */
	refused: boolean;
	/** Human-readable reason for a refusal (else null). */
	refusalReason: string | null;
	rollback: DeployResult | null;
	audit: DeployAuditRow | null;
}

/**
 * Roll a target+environment back to the release that was live before the
 * current one. Resolves both from the audit store ({@link DeployAudit.releases}:
 * rolled-back releases are unwound, so a bad release is never restored),
 * applies the same gate as a deploy, reconstructs a minimal {@link DeployResult}
 * carrying the previous release's id and outputs, calls the target's `rollback`
 * with it, and records a "rollback" audit row.
 *
 * Throws {@link NotFoundError} when there is no earlier release to revert to, and
 * {@link ValidationError} for an unknown environment or a target that cannot
 * roll back.
 */
export async function runRollback(root: string, opts: RollbackOptions): Promise<RollbackRunResult> {
	const config = loadConfig(root);
	const target = getDeployTarget(opts.target, config);
	const environment = opts.environment;
	assertKnownEnvironment(target, environment);

	if (!target.caps.canRollback) {
		throw new ValidationError(`Target "${target.id}" does not support rollback.`);
	}

	const audit = createDeployAudit(deploysDbPath(root));
	try {
		const releases = audit.releases(target.id, environment);
		const current = releases[releases.length - 1] ?? null;
		const previous = releases[releases.length - 2] ?? null;
		if (current === null || previous === null) {
			const live = current?.deploymentId ? ` (only ${current.deploymentId} is on record)` : "";
			throw new NotFoundError(
				`No prior successful deploy found for "${target.id}" in "${environment}" to roll back to` +
					`${live}.`,
			);
		}

		const policy = gatePolicyFor(config, environment);
		const gateRequiresConfirm = policy === "confirm" || target.caps.irreversible;
		if (gateRequiresConfirm && opts.yes !== true) {
			const reason =
				`Rollback of "${environment}" via "${target.id}" requires confirmation` +
				(target.caps.irreversible ? " (target is irreversible)" : ` (gate policy: ${policy})`) +
				". Re-run with --yes to approve.";
			const row = audit.record({
				runId: readCurrentRun(root),
				agentName: opts.agentName,
				target: target.id,
				environment,
				action: "rollback",
				dryRun: false,
				gateDecision: "denied",
				approvedBy: null,
				status: "failed",
				deploymentId: null,
				urls: [],
				outputs: {},
				commitSha: previous.commitSha,
			});
			return {
				target: target.id,
				environment,
				current,
				previous,
				gateDecision: "denied",
				refused: true,
				refusalReason: reason,
				rollback: null,
				audit: row,
			};
		}
		const gateDecision: GateOutcome = opts.yes === true ? "approved" : "auto";

		const detect = await target.detect(root);
		const ctx: DeployContext = buildDeployContext({
			root,
			worktreePath: root,
			target,
			environment,
			profile: detect.profile,
			dryRun: false,
			runId: readCurrentRun(root),
			agentName: opts.agentName,
			config,
		});

		// Reconstruct the release to restore, from its audit row.
		const priorDeployment: DeployResult = {
			ok: true,
			urls: previous.urls,
			deploymentId: previous.deploymentId,
			log: "",
			outputs: previous.outputs,
			errorMessage: null,
		};

		const rollbackResult = await target.rollback(ctx, priorDeployment);
		const row = audit.record({
			runId: ctx.runId,
			agentName: ctx.agentName,
			target: target.id,
			environment,
			action: "rollback",
			dryRun: false,
			gateDecision,
			approvedBy: gateDecision === "approved" ? ctx.agentName : null,
			status: rollbackResult.ok ? "success" : "failed",
			deploymentId: rollbackResult.deploymentId,
			urls: rollbackResult.urls,
			outputs: rollbackResult.outputs,
			// The restored release's commit is what is live after a rollback.
			commitSha: previous.commitSha,
		});

		return {
			target: target.id,
			environment,
			current,
			previous,
			gateDecision,
			refused: false,
			refusalReason: null,
			rollback: rollbackResult,
			audit: row,
		};
	} finally {
		audit.close();
	}
}

// ---------------------------------------------------------------------------
// deploy status / history (read the audit store)
// ---------------------------------------------------------------------------

/** Read audit rows, newest first, with optional target/env/limit filters. */
export function readAuditHistory(
	root: string,
	filter: { target?: string; environment?: string; limit?: number },
): DeployAuditRow[] {
	const audit = createDeployAudit(deploysDbPath(root));
	try {
		return audit.list(filter);
	} finally {
		audit.close();
	}
}

// ---------------------------------------------------------------------------
// Printing helpers (human mode)
// ---------------------------------------------------------------------------

function printAuditRow(row: DeployAuditRow): void {
	const flag = row.dryRun ? muted(" [dry-run]") : "";
	const statusMark = row.status === "success" ? "✓" : "✗";
	printInfo(
		`${statusMark} ${row.createdAt}  ${row.action} ${row.target} → ${row.environment}` +
			`  (gate: ${row.gateDecision})${flag}`,
	);
	if (row.urls.length > 0) printInfo(muted(`    urls: ${row.urls.join(", ")}`));
	if (row.deploymentId) printInfo(muted(`    deployment: ${row.deploymentId}`));
}

function printArtifactPlan(plan: ArtifactPlan, dryRun: boolean): void {
	const verb: Record<ArtifactPlan["action"], string> = dryRun
		? {
				create: "would create",
				unchanged: "unchanged",
				keep: "would keep existing",
				overwrite: "would overwrite",
			}
		: { create: "wrote", unchanged: "unchanged", keep: "kept existing", overwrite: "overwrote" };
	const hint = plan.action === "keep" ? " (differs from generated; pass --force to overwrite)" : "";
	printInfo(muted(`    ${verb[plan.action]} ${plan.absolutePath}${hint}`));
}

// ---------------------------------------------------------------------------
// Command builders
// ---------------------------------------------------------------------------

function targetListCommand(): Command {
	return new Command("list")
		.description("List registered deploy targets")
		.option("--json", "output JSON")
		.action((_opts: { json?: boolean }, command: Command) => {
			const useJson = command.optsWithGlobals().json === true;
			const items = buildTargetList();
			if (useJson) {
				jsonOutput(items);
				return;
			}
			if (items.length === 0) {
				printInfo(muted("(no deploy targets registered)"));
				return;
			}
			for (const item of items) {
				printInfo(`${item.id}  ${muted(`(${item.stability})`)}  ${item.label}`);
				const capBits = [
					item.caps.canRollback ? "rollback" : "no-rollback",
					item.caps.irreversible ? "irreversible" : "reversible",
					item.caps.requiresCredentials ? "creds-required" : "no-creds",
					`envs: ${item.caps.environments.join("/")}`,
				];
				printInfo(muted(`    ${capBits.join(" · ")}`));
			}
		});
}

function targetDetectCommand(): Command {
	return new Command("detect")
		.description("Detect which deploy targets fit a project directory")
		.argument("[dir]", "directory to inspect (default: project root)")
		.option("--json", "output JSON")
		.action(async (dir: string | undefined, _opts: { json?: boolean }, command: Command) => {
			const useJson = command.optsWithGlobals().json === true;
			const root = requireInit();
			const inspectDir = dir ? resolve(root, dir) : root;
			const report = await detectTargets(inspectDir);
			if (useJson) {
				jsonOutput(report);
				return;
			}
			printInfo(`Detected targets for ${muted(report.dir)}:`);
			for (const d of report.detections) {
				const mark = d.detect.fit ? "✓" : "·";
				printInfo(
					`  ${mark} ${d.id}  conf=${d.detect.confidence.toFixed(2)}  ${muted(d.detect.reason)}`,
				);
			}
			if (report.chosenTarget && report.chosenProfile) {
				printSuccess(`Chosen: ${report.chosenTarget}`);
				const p = report.chosenProfile;
				printInfo(
					muted(
						`    profile: ${p.language}` +
							`${p.framework ? `/${p.framework}` : ""}` +
							` kind=${p.kind} port=${p.port ?? "n/a"}`,
					),
				);
			} else {
				printWarning("No target fits this directory.");
			}
		});
}

function targetConfigureCommand(): Command {
	return new Command("configure")
		.description("Show the secrets a target needs and how to provide them")
		.argument("<name>", "deploy target id")
		.option("--env <e>", "environment to configure for", "production")
		.option("--json", "output JSON")
		.action(async (name: string, opts: { env: string; json?: boolean }, command: Command) => {
			const useJson = command.optsWithGlobals().json === true;
			const root = requireInit();
			const report = await configureTarget(root, name, opts.env);
			if (useJson) {
				jsonOutput(report);
				return;
			}
			printInfo(`Configure ${report.target} (${report.label}) for ${opts.env}:`);
			if (report.requiredSecretKeys.length === 0) {
				printSuccess("This target needs no secrets.");
			} else {
				printInfo("Required secret env var(s):");
				for (const key of report.requiredSecretKeys) {
					const present = !report.missingSecretKeys.includes(key);
					const mark = present ? "✓" : "✗";
					printInfo(`  ${mark} ${key}${present ? muted("  (set)") : muted("  (missing)")}`);
				}
				if (report.missingSecretKeys.length > 0) {
					printWarning(
						`Provide the missing secret(s) via the environment or ` +
							`\`agentplate setup\` before deploying.`,
					);
				}
			}
		});
}

/** `agentplate target <list|detect|configure>` — inspect + prep deploy targets. */
export function createTargetCommand(): Command {
	return new Command("target")
		.description("Inspect and configure deploy targets")
		.addCommand(targetListCommand())
		.addCommand(targetDetectCommand())
		.addCommand(targetConfigureCommand());
}

function deployStatusCommand(): Command {
	return new Command("status")
		.description("Show the most recent deploy/rollback activity")
		.option("--target <name>", "filter by target")
		.option("--env <e>", "filter by environment")
		.option("--json", "output JSON")
		.action((opts: { target?: string; env?: string; json?: boolean }, command: Command) => {
			const useJson = command.optsWithGlobals().json === true;
			const root = requireInit();
			const rows = readAuditHistory(root, {
				target: opts.target,
				environment: opts.env,
				limit: 1,
			});
			if (useJson) {
				jsonOutput({ latest: rows[0] ?? null });
				return;
			}
			if (rows.length === 0) {
				printInfo(muted("(no deploy activity recorded)"));
				return;
			}
			printAuditRow(rows[0] as DeployAuditRow);
		});
}

function deployHistoryCommand(): Command {
	return new Command("history")
		.description("List deploy/rollback audit rows (newest first)")
		.option("--target <name>", "filter by target")
		.option("--env <e>", "filter by environment")
		.option("--limit <n>", "max rows", "20")
		.option("--json", "output JSON")
		.action(
			(
				opts: { target?: string; env?: string; limit: string; json?: boolean },
				command: Command,
			) => {
				const useJson = command.optsWithGlobals().json === true;
				const root = requireInit();
				const limit = Number.parseInt(opts.limit, 10);
				const rows = readAuditHistory(root, {
					target: opts.target,
					environment: opts.env,
					limit: Number.isFinite(limit) && limit > 0 ? limit : 20,
				});
				if (useJson) {
					jsonOutput(rows);
					return;
				}
				if (rows.length === 0) {
					printInfo(muted("(no deploy activity recorded)"));
					return;
				}
				for (const row of rows) printAuditRow(row);
			},
		);
}

/** `agentplate deploy` — generate config, apply the gate, deploy, verify, audit. */
export function createDeployCommand(): Command {
	return new Command("deploy")
		.description("Build, gate-check, deploy, and verify the project to a target")
		.option("--target <name>", "deploy target id (default: config.deploy.default)")
		.option("--env <e>", "environment", "production")
		.option("--dry-run", "plan only: generate config in memory; never write files or deploy")
		.option("--yes", "approve a deploy that requires confirmation")
		.option("--force", "overwrite existing Dockerfile/CI files that differ from the generated ones")
		.option("--json", "output JSON")
		.addCommand(deployStatusCommand())
		.addCommand(deployHistoryCommand())
		.action(
			async (
				opts: {
					target?: string;
					env: string;
					dryRun?: boolean;
					yes?: boolean;
					force?: boolean;
					json?: boolean;
				},
				command: Command,
			) => {
				const useJson = command.optsWithGlobals().json === true;
				const root = requireInit();
				const result = await runDeploy(root, {
					target: opts.target,
					environment: opts.env,
					dryRun: opts.dryRun === true,
					yes: opts.yes === true,
					force: opts.force === true,
					agentName: "operator",
				});

				if (useJson) {
					jsonOutput(result);
					// A refusal is a non-zero exit so scripts can branch on it.
					if (result.refused) process.exitCode = new ValidationError("").exitCode;
					return;
				}

				if (result.refused) {
					printError(result.refusalReason ?? "Deploy refused by gate.");
					process.exitCode = new ValidationError("").exitCode;
					return;
				}

				if (result.dryRun) {
					printSuccess(`[dry-run] ${result.summary}`);
					for (const plan of result.artifacts) printArtifactPlan(plan, true);
					if (result.requiredSecretKeys.length > 0) {
						printInfo(
							muted(
								`    requires secrets: ${result.requiredSecretKeys.join(", ")}` +
									(result.missingSecretKeys.length > 0
										? ` (missing: ${result.missingSecretKeys.join(", ")})`
										: ""),
							),
						);
					}
					printInfo(muted("    (dry-run — nothing was deployed)"));
					return;
				}

				for (const plan of result.artifacts) printArtifactPlan(plan, false);
				if (result.deploy?.ok) {
					printSuccess(`Deployed ${result.target} → ${result.environment}`);
					for (const url of result.deploy.urls) printInfo(`    ${url}`);
					for (const [k, v] of Object.entries(result.deploy.outputs)) {
						printInfo(muted(`    ${k}: ${v}`));
					}
					if (result.verify) {
						const vmark = result.verify.healthy ? "✓" : "✗";
						printInfo(`  ${vmark} verify: ${result.verify.healthy ? "healthy" : "unhealthy"}`);
						for (const check of result.verify.checks) {
							printInfo(muted(`      ${check.ok ? "✓" : "✗"} ${check.name}: ${check.detail}`));
						}
					}
				} else {
					printError(`Deploy failed: ${result.deploy?.errorMessage ?? "unknown error"}`);
					process.exitCode = 1;
				}
			},
		);
}

/** `agentplate rollback` — revert a target+environment to the release before the live one. */
export function createRollbackCommand(): Command {
	return new Command("rollback")
		.description("Roll a target back to the release before the one live now")
		.option("--target <name>", "deploy target id (default: config.deploy.default)")
		.option("--env <e>", "environment", "production")
		.option("--yes", "approve a rollback that requires confirmation")
		.option("--json", "output JSON")
		.action(
			async (
				opts: { target?: string; env: string; yes?: boolean; json?: boolean },
				command: Command,
			) => {
				const useJson = command.optsWithGlobals().json === true;
				const root = requireInit();
				const result = await runRollback(root, {
					target: opts.target,
					environment: opts.env,
					yes: opts.yes === true,
					agentName: "operator",
				});
				if (useJson) {
					jsonOutput(result);
					if (result.refused) process.exitCode = new ValidationError("").exitCode;
					return;
				}
				if (result.refused) {
					printError(result.refusalReason ?? "Rollback refused by gate.");
					process.exitCode = new ValidationError("").exitCode;
					return;
				}
				if (result.rollback?.ok) {
					printSuccess(
						`Rolled back ${result.target} → ${result.environment}` +
							(result.rollback.deploymentId ? ` to ${result.rollback.deploymentId}` : ""),
					);
				} else {
					printError(`Rollback failed: ${result.rollback?.errorMessage ?? "unknown error"}`);
					process.exitCode = 1;
				}
			},
		);
}
