/**
 * Deploy context builder.
 *
 * Assembles the {@link DeployContext} every target method
 * (`generateConfig`/`deploy`/`verify`/`rollback`) receives. It is the single
 * seam where non-secret settings (from `config.deploy.targets[id].settings`)
 * meet resolved secret values (from the target's own `buildSecretEnv`, fed the
 * project secret store). Settings come from config; secret *values* are read
 * here at the moment of use and never persisted or logged — the context object
 * lives only for the duration of one pipeline step.
 */

import type { AgentplateConfig } from "../types.ts";
import { createDeploySecretStore } from "./secrets.ts";
import type { AppProfile, DeployContext, DeployTarget } from "./types.ts";

/** Inputs for {@link buildDeployContext}. */
export interface BuildDeployContextArgs {
	/** Absolute project root (used to resolve the secret store and as `projectRoot`). */
	root: string;
	/** Absolute path to the worktree the target operates on. */
	worktreePath: string;
	/** Resolved deploy target (its `id` keys into config settings; provides `buildSecretEnv`). */
	target: DeployTarget;
	/** Target environment ("preview" | "staging" | "production" | …). */
	environment: string;
	/** App profile detected (or supplied) for this deploy. */
	profile: AppProfile;
	/** When true: generate + plan only; no outward-facing mutation. */
	dryRun: boolean;
	/** Owning run id, or null when run outside a coordinator session. */
	runId: string | null;
	/** Name of the agent (or operator) performing the deploy. */
	agentName: string;
	/** Loaded Agentplate config (source of per-target non-secret settings). */
	config: AgentplateConfig;
}

/**
 * Build a {@link DeployContext} from a resolved target, environment, profile,
 * and config.
 *
 * Non-secret settings are read from `config.deploy.targets[target.id].settings`
 * (an empty object when the target has no config entry). Secret env is produced
 * by `target.buildSecretEnv(...)` given a {@link createDeploySecretStore} bound
 * to `root`, so each target decides exactly which named env vars it needs and
 * the values resolve from the gitignored secrets file or `process.env`. When no
 * secrets are configured the resulting `secretEnv` is simply empty.
 *
 * `projectRoot` is set to `root`; the returned object is plain data with no
 * retained references to the config beyond the shallow `settings` map.
 */
export function buildDeployContext(args: BuildDeployContextArgs): DeployContext {
	const { root, worktreePath, target, environment, profile, dryRun, runId, agentName, config } =
		args;

	const settings = config.deploy.targets[target.id]?.settings ?? {};
	const secretEnv = target.buildSecretEnv(createDeploySecretStore(root));

	return {
		target: target.id,
		environment,
		worktreePath,
		projectRoot: root,
		profile,
		secretEnv,
		settings,
		dryRun,
		runId,
		agentName,
	};
}
