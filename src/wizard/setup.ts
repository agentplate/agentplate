/**
 * Interactive setup wizard (the Hermes-style onboarding).
 *
 * Walks the user through: provider selection → credentials → model → runtime,
 * then returns the resulting config plus an optional secret for the caller to
 * persist. Pure config construction is delegated to `providers/apply.ts`; this
 * module owns only the interactive I/O.
 */

import * as p from "@clack/prompts";
import { applyProviderSelection, buildProviderConfig } from "../providers/apply.ts";
import { getProviderSpec, listProviders, meetsContextFloor } from "../providers/registry.ts";
import type { AgentplateConfig, AuthMode } from "../types.ts";
import { commandOnPath, detectDefaultRuntime } from "../utils/detect.ts";

/** Runtimes the wizard can offer. */
const RUNTIME_CHOICES: ReadonlyArray<{ value: string; label: string; cli: string }> = [
	{ value: "claude", label: "Claude Code", cli: "claude" },
	{ value: "opencode", label: "OpenCode", cli: "opencode" },
	{ value: "codex", label: "OpenAI Codex", cli: "codex" },
	{ value: "gemini", label: "Gemini CLI", cli: "gemini" },
	{ value: "cursor", label: "Cursor", cli: "cursor-agent" },
];

/** Map a runtime id to the CLI binary that provides its login. */
function runtimeCli(runtime: string): string {
	return RUNTIME_CHOICES.find((r) => r.value === runtime)?.cli ?? runtime;
}

export interface WizardResult {
	/** The new config to persist. */
	config: AgentplateConfig;
	/** A secret to store (env-var name → value), if the user provided one. */
	secret?: { key: string; value: string };
}

/** Abort the wizard cleanly if the user cancelled a prompt. */
function ensure<T>(value: T | symbol): T {
	if (p.isCancel(value)) {
		p.cancel("Setup cancelled. No changes written.");
		process.exit(0);
	}
	return value;
}

/** Run the interactive wizard. Returns the config + optional secret to persist. */
export async function runSetupWizard(currentConfig: AgentplateConfig): Promise<WizardResult> {
	p.intro("Agentplate setup");

	// 1. Provider ----------------------------------------------------------
	const providerId = ensure(
		await p.select({
			message: "Choose your AI provider",
			initialValue: currentConfig.activeProvider,
			options: listProviders().map((spec) => ({
				value: spec.id,
				label: spec.label,
				hint: spec.description,
			})),
		}),
	);
	const spec = getProviderSpec(providerId);
	if (!spec) {
		p.cancel(`Unknown provider "${providerId}".`);
		process.exit(1);
	}

	// 2. Base URL (custom endpoints only) ----------------------------------
	let baseUrl: string | undefined;
	if (spec.requiresBaseUrl) {
		baseUrl = ensure(
			await p.text({
				message: "Base URL for the endpoint",
				placeholder: "https://my-endpoint.example.com/v1",
				validate: (v) => (v.trim().length === 0 ? "A base URL is required" : undefined),
			}),
		);
	} else {
		baseUrl = spec.defaultBaseUrl;
	}

	// 3. Authentication method --------------------------------------------
	// Offer the same kind of choice Claude Code shows: use an existing
	// subscription/CLI login, an existing env var, or enter an API key.
	let secret: WizardResult["secret"];
	let authMode: AuthMode;

	if (spec.keyless) {
		authMode = "none";
		p.note("This provider runs locally and needs no credentials.", spec.label);
	} else {
		const envPresent = Boolean(process.env[spec.authEnvVar]?.length);
		const subInstalled = spec.subscriptionRuntime
			? await commandOnPath(runtimeCli(spec.subscriptionRuntime))
			: false;

		const options: Array<{ value: AuthMode; label: string; hint?: string }> = [];
		if (spec.supportsSubscription) {
			options.push({
				value: "subscription",
				label: spec.subscriptionLabel ?? `${spec.label} subscription / CLI login`,
				hint: subInstalled ? "CLI detected — uses its login" : "requires the CLI to be logged in",
			});
		}
		if (envPresent) {
			options.push({
				value: "env",
				label: `Use existing ${spec.authEnvVar} from your environment`,
				hint: "already set — nothing stored",
			});
		}
		options.push({
			value: "api-key",
			label: "Enter an API key (pay-per-token)",
			hint: "stored in .agentplate/secrets.local.yaml (gitignored)",
		});

		// Default to the most convenient available method.
		const initialAuth: AuthMode = spec.supportsSubscription
			? "subscription"
			: envPresent
				? "env"
				: "api-key";

		authMode =
			options.length === 1
				? "api-key"
				: ensure(
						await p.select({
							message: `How should Agentplate authenticate with ${spec.label}?`,
							initialValue: initialAuth,
							options,
						}),
					);

		if (authMode === "subscription") {
			const cli = spec.subscriptionRuntime ? runtimeCli(spec.subscriptionRuntime) : spec.id;
			if (!subInstalled) {
				p.note(
					`Agentplate will use your ${spec.subscriptionLabel ?? "CLI"} login.\n` +
						`Make sure \`${cli}\` is installed and logged in (run \`${cli}\` once to sign in).`,
					"Subscription auth",
				);
			} else {
				p.note(`Using your existing \`${cli}\` login — no API key stored.`, "Subscription auth");
			}
		} else if (authMode === "api-key") {
			const key = ensure(
				await p.password({
					message: `Enter your ${spec.label} API key (${spec.authEnvVar})`,
					validate: (v) => (v.trim().length === 0 ? "An API key is required" : undefined),
				}),
			);
			secret = { key: spec.authEnvVar, value: key.trim() };
		}
		// authMode === "env": nothing to store; resolved from the environment at run time.
	}

	// 4. Model -------------------------------------------------------------
	const eligible = spec.models.filter(meetsContextFloor);
	let model: string;
	if (eligible.length > 0) {
		const choice = ensure(
			await p.select({
				message: "Choose a default model",
				options: [
					...eligible.map((m) => ({
						value: m.id,
						label: m.label,
						hint: `${Math.round(m.contextWindow / 1000)}k context`,
					})),
					{ value: "__custom__", label: "Custom model id…", hint: "type your own" },
				],
			}),
		);
		model =
			choice === "__custom__"
				? ensure(
						await p.text({
							message: "Model id",
							validate: (v) => (v.trim().length === 0 ? "A model id is required" : undefined),
						}),
					).trim()
				: choice;
	} else {
		model = ensure(
			await p.text({
				message: "Model id",
				placeholder: "provider/model-name",
				validate: (v) => (v.trim().length === 0 ? "A model id is required" : undefined),
			}),
		).trim();
	}

	// 5. Runtime -----------------------------------------------------------
	const detected = await detectDefaultRuntime();
	const installed = new Set<string>();
	await Promise.all(
		RUNTIME_CHOICES.map(async (r) => {
			if (await commandOnPath(r.cli)) installed.add(r.value);
		}),
	);
	// When the user picked subscription/OAuth auth, the login lives in the
	// provider's own CLI (e.g. a ChatGPT login in `codex`, a Google login in
	// `gemini`). Default the runtime to that CLI so the OAuth credentials are
	// actually reused — otherwise a mismatched runtime (e.g. `claude` driving a
	// GPT model with no key) would silently break the login.
	const initialRuntime =
		authMode === "subscription" && spec.subscriptionRuntime ? spec.subscriptionRuntime : detected;
	const runtime = ensure(
		await p.select({
			message: "Which coding-agent runtime should drive workers?",
			initialValue: initialRuntime,
			options: RUNTIME_CHOICES.map((r) => ({
				value: r.value,
				label: r.label,
				hint: installed.has(r.value) ? "installed" : "not detected on PATH",
			})),
		}),
	);

	// 6. Summary -----------------------------------------------------------
	const previewProvider = buildProviderConfig(spec, model, authMode, baseUrl);
	const authSummary: Record<AuthMode, string> = {
		subscription: `subscription / ${runtimeCli(spec.subscriptionRuntime ?? runtime)} login (no key stored)`,
		"api-key": `${spec.authEnvVar} → secrets.local.yaml`,
		env: `${spec.authEnvVar} (from environment)`,
		none: "none (local)",
	};
	p.note(
		[
			`provider:  ${spec.label} (${providerId})`,
			`model:     ${model}`,
			`runtime:   ${runtime}`,
			`auth:      ${authSummary[authMode]}`,
			previewProvider.baseUrl ? `base URL:  ${previewProvider.baseUrl}` : undefined,
		]
			.filter(Boolean)
			.join("\n"),
		"Configuration",
	);

	const config = applyProviderSelection(currentConfig, {
		providerId,
		spec,
		model,
		authMode,
		baseUrl,
		runtime,
	});

	p.outro("Ready to write configuration.");
	return secret ? { config, secret } : { config };
}
