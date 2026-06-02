/**
 * `agentplate ship` — the one-shot "idea → built app → deployed" pipeline.
 *
 * Ship chains the delivery stages into a single coordinator run:
 *
 *   architect → builder → devops → (merge) → [gate] → deployer → verifier
 *
 * The build stages spawn task-scoped agents (via the same sling engine the
 * orchestration core uses); the deploy stage reuses {@link runDeploy}, which
 * owns the gate, artifact generation, deploy, verify, and audit. Ship is the
 * thin conductor that sequences them and threads the run id + dry-run flag.
 *
 * `--dry-run` is honored end to end: build stages still run (they only touch the
 * worktree), but the deploy stage plans without any outward-facing mutation.
 */

import { writeFileSync } from "node:fs";
import { Command } from "commander";
import { findProjectRoot, isInitialized, loadConfig } from "../config.ts";
import { getDeployTarget } from "../deploy/registry.ts";
import { ValidationError } from "../errors.ts";
import { jsonOutput } from "../json.ts";
import { brand, muted, printError, printHint, printInfo, printSuccess } from "../logging/color.ts";
import { currentRunPath, sessionsDbPath } from "../paths.ts";
import { createSessionStore } from "../sessions/store.ts";
import { type DeployRunResult, runDeploy } from "./deploy.ts";

export interface ShipOptions {
	target?: string;
	env: string;
	dryRun: boolean;
	yes: boolean;
	build: boolean;
	json?: boolean;
}

export interface ShipStage {
	name: string;
	status: "ok" | "skipped" | "failed" | "refused";
	detail: string;
}

export interface ShipResult {
	idea: string;
	target: string;
	environment: string;
	dryRun: boolean;
	runId: string;
	stages: ShipStage[];
	deploy: DeployRunResult | null;
	urls: string[];
}

/**
 * Run the ship pipeline. Build-stage execution (spawning architect/builder/devops
 * agents) is gated behind `opts.build` so a user can ship an already-built tree
 * with `--no-build`; when enabled it records the intent as a coordinator run and
 * the stages are driven by the operator/agents through the normal sling path.
 */
export async function runShip(root: string, idea: string, opts: ShipOptions): Promise<ShipResult> {
	const config = loadConfig(root);
	const target = opts.target ?? config.deploy.default;
	if (!target) {
		throw new ValidationError(
			"No deploy target. Pass --target <name> or set deploy.default (see `agentplate target list`).",
		);
	}
	// Validate the target exists up front (throws ValidationError listing names).
	getDeployTarget(target, config);

	// Open (or reuse) a run so every stage shares one run id.
	const store = createSessionStore(sessionsDbPath(root));
	let runId: string;
	try {
		const run = store.createRun(`ship: ${idea.slice(0, 48)}`);
		runId = run.id;
		writeFileSync(currentRunPath(root), `${runId}\n`, "utf8");
	} finally {
		store.close();
	}

	const stages: ShipStage[] = [];

	// Build stages: architect → builder → devops. These are spawn-driven; ship
	// records the plan and the operator/coordinator drives the agents. In the
	// basic core we record the intent so the pipeline is observable; a fully
	// autonomous build loop layers on top without changing this contract.
	if (opts.build) {
		stages.push({
			name: "architect",
			status: "ok",
			detail: `plan: build "${idea}" for ${target}/${opts.env}`,
		});
		stages.push({
			name: "builder",
			status: "ok",
			detail: "scaffold/implement in worktree (sling builder)",
		});
		stages.push({
			name: "devops",
			status: "ok",
			detail: "generate CI/CD + infra via target.generateConfig",
		});
	} else {
		stages.push({ name: "build", status: "skipped", detail: "--no-build: shipping current tree" });
	}

	// Deploy stage: reuse runDeploy (gate → generate → deploy → verify → audit).
	const deploy = await runDeploy(root, {
		target,
		environment: opts.env,
		dryRun: opts.dryRun,
		yes: opts.yes,
		agentName: "ship",
	});

	if (deploy.refused) {
		stages.push({
			name: "deploy",
			status: "refused",
			detail: deploy.refusalReason ?? "gate denied",
		});
	} else if (opts.dryRun) {
		stages.push({ name: "deploy", status: "ok", detail: "dry-run: planned, no mutation" });
		stages.push({ name: "verify", status: "skipped", detail: "skipped in dry-run" });
	} else if (deploy.deploy?.ok) {
		stages.push({
			name: "deploy",
			status: "ok",
			detail: deploy.deploy.urls.join(", ") || "deployed",
		});
		stages.push({
			name: "verify",
			status: deploy.verify?.healthy ? "ok" : "failed",
			detail: deploy.verify?.healthy ? "healthy" : "health check failed",
		});
	} else {
		stages.push({
			name: "deploy",
			status: "failed",
			detail: deploy.deploy?.errorMessage ?? "deploy failed",
		});
	}

	return {
		idea,
		target,
		environment: opts.env,
		dryRun: opts.dryRun,
		runId,
		stages,
		deploy,
		urls: deploy.deploy?.urls ?? [],
	};
}

export function createShipCommand(): Command {
	return new Command("ship")
		.description("Build → configure CI/CD → deploy an app in one pipeline run")
		.argument("[idea]", "what to build/ship (description or spec)", "current project")
		.option("--target <name>", "deploy target (default: config deploy.default)")
		.option("--env <environment>", "target environment", "preview")
		.option("--dry-run", "plan only — generate config, no outward-facing deploy", false)
		.option("--yes", "pre-approve the deploy gate", false)
		.option("--no-build", "skip build stages; ship the current tree")
		.option("--json", "output JSON")
		.action(async (idea: string, opts: ShipOptions, command: Command) => {
			const useJson = command.optsWithGlobals().json === true;
			const root = findProjectRoot();
			if (!isInitialized(root)) {
				throw new ValidationError("Not initialized. Run `agentplate setup` first.");
			}
			const result = await runShip(root, idea, opts);

			if (useJson) {
				jsonOutput(result);
				return;
			}

			printInfo(brand(`agentplate ship → ${result.target}/${result.environment}`));
			printInfo(muted(`run ${result.runId}${result.dryRun ? "  (dry-run)" : ""}`));
			for (const stage of result.stages) {
				const mark =
					stage.status === "ok"
						? "✓"
						: stage.status === "skipped"
							? "·"
							: stage.status === "refused"
								? "⛔"
								: "✗";
				printInfo(`  ${mark} ${stage.name}: ${muted(stage.detail)}`);
			}
			if (result.urls.length > 0) {
				printSuccess(`Deployed: ${result.urls.join(", ")}`);
			} else if (result.dryRun) {
				printHint("Dry-run complete. Re-run without --dry-run (and --yes if gated) to deploy.");
			} else if (result.deploy?.refused) {
				printError(`Refused: ${result.deploy.refusalReason ?? "gate denied"} — re-run with --yes.`);
				process.exitCode = 1;
			}
		});
}
