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
import { PROVIDERS } from "../providers/registry.ts";
import { getSecret } from "../secrets.ts";
import type { AgentplateConfig, Capability, ResolvedModel } from "../types.ts";
import { isAnthropicBaseUrl } from "./claude.ts";

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
	// A credential routed to a non-loopback baseUrl gets a warning, so a
	// malicious committed config.yaml cannot silently exfiltrate it.
	const remoteBaseUrl =
		provider?.baseUrl && !isLoopbackBaseUrl(provider.baseUrl) ? provider.baseUrl : undefined;
	let authTokenEnv: string | undefined;

	switch (authMode) {
		case "api-key":
		case "env": {
			// Key-bearing modes: resolve the secret by name and inject it.
			const secret = provider?.authTokenEnv ? getSecret(root, provider.authTokenEnv) : undefined;
			if (provider?.authTokenEnv && secret) {
				env[provider.authTokenEnv] = secret;
				authTokenEnv = provider.authTokenEnv;
				if (remoteBaseUrl) {
					warn(
						`credential ${provider.authTokenEnv} will be sent to non-local endpoint ${remoteBaseUrl}`,
					);
				}
			} else if (remoteBaseUrl && !isVendorLoginEndpoint(remoteBaseUrl)) {
				// No key resolved: a runtime that honors the baseUrl falls back to its
				// CLI's own login (e.g. a Claude OAuth token) and sends THAT there.
				warn(
					`credential ${provider?.authTokenEnv ?? "(none configured)"} is unset, so the runtime CLI's own login credential will be sent to non-local endpoint ${remoteBaseUrl}`,
				);
			}
			break;
		}
		case "subscription":
			// The runtime CLI's own login carries auth — inject nothing. That login
			// is still a credential, and it goes wherever the baseUrl points.
			if (remoteBaseUrl && !isVendorLoginEndpoint(remoteBaseUrl)) {
				warn(
					`credential (the runtime CLI's own login) will be sent to non-local endpoint ${remoteBaseUrl}`,
				);
			}
			break;
		case "none":
			// Keyless local provider (e.g. Ollama) — inject nothing.
			break;
	}

	const resolved: ResolvedModel = { model, env, authMode };
	if (authTokenEnv) resolved.authTokenEnv = authTokenEnv;
	if (provider?.baseUrl) resolved.baseUrl = provider.baseUrl;
	return resolved;
}

/**
 * True when `baseUrl` is a vendor's own endpoint for a CLI login: Anthropic's
 * API, or the catalog default of a subscription-capable provider (OpenAI for
 * `codex login`, OpenCode Zen, Google). A runtime's login going to its own
 * vendor is expected, so only key-less configs pointing elsewhere warn.
 */
function isVendorLoginEndpoint(baseUrl: string): boolean {
	if (isAnthropicBaseUrl(baseUrl)) return true;
	return PROVIDERS.some(
		(spec) => spec.supportsSubscription === true && spec.defaultBaseUrl === baseUrl,
	);
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
