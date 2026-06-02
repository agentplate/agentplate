/**
 * Deploy secret store adapter.
 *
 * Bridges the project-wide secret store ({@link getSecret}/{@link hasSecret},
 * file-then-`process.env`) to the deploy pipeline's contracts. Deploy targets
 * only ever see env-var *names*; values are resolved here at the moment a
 * {@link DeployContext.secretEnv} map is built and injected into a child
 * process. Nothing in this module persists or logs secret values.
 *
 * Three entry points:
 * - {@link createDeploySecretStore} wraps the union store as a
 *   {@link DeploySecretStore} handed to a target's `buildSecretEnv`.
 * - {@link resolveTargetSecretEnv} turns a target's `secretEnv` bindings
 *   (logicalKey → { fromEnv: ENV_NAME }) into a concrete KEY→value map,
 *   including only the bindings whose env var is present.
 * - {@link missingSecretKeys} reports which required env-var names are absent,
 *   for preflight / gate fail-fast.
 */

import { getSecret, hasSecret } from "../secrets.ts";
import type { DeployTargetConfig } from "../types.ts";
import type { DeploySecretStore } from "./types.ts";

/**
 * Build the union secret store ({@link DeploySecretStore}) for a project root.
 * `get`/`has` delegate to {@link getSecret}/{@link hasSecret}, which check the
 * gitignored secrets file first, then `process.env`. This is the store passed
 * to a target's `buildSecretEnv`.
 */
export function createDeploySecretStore(root: string): DeploySecretStore {
	return {
		get(key: string): string | undefined {
			return getSecret(root, key);
		},
		has(key: string): boolean {
			return hasSecret(root, key);
		},
	};
}

/**
 * Resolve a target's secret bindings into a concrete env map for
 * {@link DeployContext.secretEnv}. For each `secretEnv[logicalKey] = { fromEnv:
 * ENV_NAME }`, read the value for `ENV_NAME` and, when present, map
 * `logicalKey → value`. Bindings whose env var is absent are silently omitted
 * (callers use {@link missingSecretKeys} to detect required gaps).
 */
export function resolveTargetSecretEnv(
	root: string,
	targetConfig: DeployTargetConfig,
): Record<string, string> {
	const resolved: Record<string, string> = {};
	for (const [logicalKey, binding] of Object.entries(targetConfig.secretEnv)) {
		const value = getSecret(root, binding.fromEnv);
		if (value !== undefined) resolved[logicalKey] = value;
	}
	return resolved;
}

/**
 * Return the subset of `requiredSecretKeys` (env-var NAMES) that have no value
 * available from the file store or `process.env`. Order and duplicates from the
 * input are preserved as given; an empty result means every required secret is
 * present. Used for preflight and deploy-gate fail-fast — names only, never
 * values.
 */
export function missingSecretKeys(root: string, requiredSecretKeys: string[]): string[] {
	return requiredSecretKeys.filter((key) => !hasSecret(root, key));
}
