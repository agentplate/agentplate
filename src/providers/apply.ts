/**
 * Pure helpers that turn a wizard selection into config — separated from the
 * interactive I/O so they can be unit-tested without a TTY.
 */

import type { AgentplateConfig, AuthMode, ProviderConfig } from "../types.ts";
import type { ProviderSpec } from "./registry.ts";

export interface ProviderSelection {
	/** Provider id (catalog id, or a user-chosen id for custom endpoints). */
	providerId: string;
	/** The catalog spec the selection was based on. */
	spec: ProviderSpec;
	/** Chosen model id. */
	model: string;
	/** How credentials are obtained (subscription / api-key / env / none). */
	authMode: AuthMode;
	/** Base URL (gateway/custom providers). */
	baseUrl?: string;
	/** Coding-agent runtime to drive workers (e.g. "claude"). */
	runtime: string;
}

/** Build a {@link ProviderConfig} from a catalog spec and the chosen values. */
export function buildProviderConfig(
	spec: ProviderSpec,
	model: string,
	authMode: AuthMode,
	baseUrl?: string,
): ProviderConfig {
	const config: ProviderConfig = {
		type: spec.kind,
		authMode,
		model,
	};
	// Subscription/none auth delegates to the runtime login — no env var binding.
	if (authMode === "api-key" || authMode === "env") {
		config.authTokenEnv = spec.authEnvVar;
	}
	const resolvedBaseUrl = baseUrl ?? spec.defaultBaseUrl;
	if (spec.kind === "gateway" && resolvedBaseUrl) {
		config.baseUrl = resolvedBaseUrl;
	}
	return config;
}

/**
 * Apply a provider selection to a config, returning a new config with the
 * provider registered, marked active, and the runtime set. Does not mutate the
 * input.
 */
export function applyProviderSelection(
	config: AgentplateConfig,
	selection: ProviderSelection,
): AgentplateConfig {
	const next = structuredClone(config);
	next.providers[selection.providerId] = buildProviderConfig(
		selection.spec,
		selection.model,
		selection.authMode,
		selection.baseUrl,
	);
	next.activeProvider = selection.providerId;
	next.runtime.default = selection.runtime;
	return next;
}
