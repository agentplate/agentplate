/**
 * Model resolution — bridge between the agent manifest (which names models by
 * alias) and a concrete {@link ResolvedModel} the runtime can spawn.
 *
 * The active provider's configured `model` (set by `agentplate setup`) is the
 * concrete model, and the provider's `authTokenEnv` secret is injected as an env
 * var. Per-capability **model tiering** is supported: when a `capability` is given
 * and the provider has a `models[capability]` override (e.g. a fast model for
 * `scout`/`reviewer`), that wins; otherwise the provider `model`, otherwise the
 * manifest alias.
 *
 * Auth mode matters here: only `api-key`/`env` providers inject a credential env
 * var. `subscription` providers delegate to the runtime CLI's own login (e.g. a
 * Claude Pro/Max OAuth session), so injecting an empty/leftover key would
 * actively break that login — we deliberately inject nothing.
 */

import { getSecret } from "../secrets.ts";
import type { AgentplateConfig, Capability, ResolvedModel } from "../types.ts";

/**
 * Resolve the concrete model + provider env for a manifest model alias.
 *
 * @param config  loaded Agentplate config
 * @param root    project root (to read the gitignored secret value)
 * @param manifestModel the model alias/id from the agent definition
 * @param capability optional agent capability for per-capability model tiering
 */
export function resolveModel(
	config: AgentplateConfig,
	root: string,
	manifestModel: string,
	capability?: Capability,
): ResolvedModel {
	const provider = config.providers[config.activeProvider];
	const tiered = capability ? provider?.models?.[capability] : undefined;
	const model = tiered ?? provider?.model ?? manifestModel;
	const env: Record<string, string> = {};

	// Default to "api-key" for legacy configs written before authMode existed.
	const authMode = provider?.authMode ?? (provider?.authTokenEnv ? "api-key" : "none");
	const usesKey = authMode === "api-key" || authMode === "env";

	if (usesKey && provider?.authTokenEnv) {
		const secret = getSecret(root, provider.authTokenEnv);
		if (secret) env[provider.authTokenEnv] = secret;
	}
	return { model, env };
}
