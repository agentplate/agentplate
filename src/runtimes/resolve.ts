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
 * actively break that login — we deliberately inject nothing. `none` providers
 * are keyless (e.g. a local Ollama server) and likewise inject nothing.
 *
 * The provider's `baseUrl` (gateway/local endpoint) is passed through on the
 * resolved model; runtimes that support endpoint override map it to their
 * CLI's env var.
 */

import { createLogger } from "../logging/logger.ts";
import { getSecret } from "../secrets.ts";
import type { AgentplateConfig, Capability, ResolvedModel } from "../types.ts";

const defaultWarn = createLogger({ scope: "resolve" }).warn;

/**
 * Resolve the concrete model + provider env for a manifest model alias.
 *
 * @param config  loaded Agentplate config
 * @param root    project root (to read the gitignored secret value)
 * @param manifestModel the model alias/id from the agent definition
 * @param capability optional agent capability for per-capability model tiering
 * @param warn    warning sink (injectable for tests; defaults to the logger)
 */
export function resolveModel(
	config: AgentplateConfig,
	root: string,
	manifestModel: string,
	capability?: Capability,
	warn: (message: string) => void = defaultWarn,
): ResolvedModel {
	const provider = config.providers[config.activeProvider];
	const tiered = capability ? provider?.models?.[capability] : undefined;
	const model = tiered ?? provider?.model ?? manifestModel;
	const env: Record<string, string> = {};

	// Default to "api-key" for legacy configs written before authMode existed.
	const authMode = provider?.authMode ?? (provider?.authTokenEnv ? "api-key" : "none");

	switch (authMode) {
		case "api-key":
		case "env": {
			// Key-bearing modes: resolve the secret by name and inject it.
			if (provider?.authTokenEnv) {
				const secret = getSecret(root, provider.authTokenEnv);
				if (secret) {
					env[provider.authTokenEnv] = secret;
					// A real credential routed to a non-loopback baseUrl: warn, so a
					// malicious committed config.yaml cannot silently exfiltrate the key.
					if (provider.baseUrl && !isLoopbackBaseUrl(provider.baseUrl)) {
						warn(
							`credential ${provider.authTokenEnv} will be sent to non-local endpoint ${provider.baseUrl}`,
						);
					}
				}
			}
			break;
		}
		case "subscription":
			// The runtime CLI's own login carries auth — inject nothing.
			break;
		case "none":
			// Keyless local provider (e.g. Ollama) — inject nothing.
			break;
	}

	const resolved: ResolvedModel = { model, env, authMode };
	if (provider?.baseUrl) resolved.baseUrl = provider.baseUrl;
	return resolved;
}

/**
 * True when a provider baseUrl points at this machine (localhost / 127.0.0.1 /
 * [::1]). Used to decide whether sending a real credential there deserves a
 * warning. An unparseable URL is treated as NOT loopback (warn — fail safe).
 */
export function isLoopbackBaseUrl(baseUrl: string): boolean {
	try {
		const host = new URL(baseUrl).hostname;
		return host === "localhost" || host === "127.0.0.1" || host === "[::1]";
	} catch {
		return false;
	}
}
