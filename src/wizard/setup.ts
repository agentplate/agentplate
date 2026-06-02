/**
 * Interactive setup wizard (the Hermes-style onboarding).
 *
 * Walks the user through: provider selection → credentials → model → runtime,
 * then returns the resulting config plus an optional secret for the caller to
 * persist. Pure config construction is delegated to `providers/apply.ts`; this
 * module owns only the interactive I/O.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as p from "@clack/prompts";
import { applyProviderSelection, buildProviderConfig } from "../providers/apply.ts";
import { getProviderSpec, listProviders, meetsContextFloor } from "../providers/registry.ts";
import type {
	AgentplateConfig,
	AuthMode,
	AutoMergeMode,
	Capability,
	QualityGate,
} from "../types.ts";
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

/**
 * Suggest quality gates for a project. Prefers the project's own package.json
 * scripts (`bun run <script>`) when present, falling back to the Bun/Biome/TS
 * defaults this stack uses. The user confirms/deselects in the wizard.
 */
export function detectQualityGates(root: string): QualityGate[] {
	let scripts: Record<string, string> = {};
	try {
		const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
			scripts?: Record<string, string>;
		};
		scripts = pkg.scripts ?? {};
	} catch {
		// No package.json (or unreadable) — fall back to stack defaults below.
	}
	const gate = (name: string, fallback: string): QualityGate => ({
		name,
		command: scripts[name] ? `bun run ${name}` : fallback,
	});
	return [
		gate("test", "bun test"),
		gate("lint", "biome check ."),
		gate("typecheck", "tsc --noEmit"),
	];
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
				validate: (v) => (!v || v.trim().length === 0 ? "A base URL is required" : undefined),
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
					validate: (v) => (!v || v.trim().length === 0 ? "An API key is required" : undefined),
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
							validate: (v) => (!v || v.trim().length === 0 ? "A model id is required" : undefined),
						}),
					).trim()
				: choice;
	} else {
		model = ensure(
			await p.text({
				message: "Model id",
				placeholder: "provider/model-name",
				validate: (v) => (!v || v.trim().length === 0 ? "A model id is required" : undefined),
			}),
		).trim();
	}

	// 4b. Model tiering — optionally use a faster/cheaper model for read-only
	//     roles (scout, reviewer), keeping the chosen model for the rest.
	let modelsByCapability: Partial<Record<Capability, string>> | undefined;
	if (eligible.length > 1) {
		const wantTiering = ensure(
			await p.confirm({
				message: "Use a faster/cheaper model for read-only roles (scout & reviewer)?",
				initialValue: false,
			}),
		);
		if (wantTiering) {
			const fast = ensure(
				await p.select({
					message: "Fast model for scout & reviewer",
					options: eligible.map((m) => ({
						value: m.id,
						label: m.label,
						hint: `${Math.round(m.contextWindow / 1000)}k context`,
					})),
				}),
			) as string;
			modelsByCapability = { scout: fast, reviewer: fast };
		}
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

	// 6. Orchestration & merge --------------------------------------------
	const canonicalBranch = currentConfig.project.canonicalBranch;
	const suggestedGates = detectQualityGates(currentConfig.project.root || ".");
	const chosenGateNames = ensure(
		await p.multiselect({
			message:
				"Quality gates to run on a worker's output (used by skill distillation and 'on gates pass' auto-merge)",
			options: suggestedGates.map((g) => ({ value: g.name, label: g.name, hint: g.command })),
			initialValues: suggestedGates.map((g) => g.name),
			required: false,
		}),
	) as string[];
	const qualityGates = suggestedGates.filter((g) => chosenGateNames.includes(g.name));

	const autoMerge = ensure(
		await p.select({
			message: `Auto-merge a worker's branch into ${canonicalBranch} when it finishes?`,
			initialValue: "off",
			options: [
				{ value: "off", label: "Never — merge manually", hint: "default; safest" },
				{
					value: "on-gates-pass",
					label: "On quality gates pass",
					hint: qualityGates.length
						? "merge only when gates are green"
						: "needs gates — will hold otherwise",
				},
				{
					value: "on-complete",
					label: "On complete",
					hint: "merge as soon as the agent finishes (no gate check)",
				},
			],
		}),
	) as AutoMergeMode;

	if (autoMerge === "on-gates-pass" && qualityGates.length === 0) {
		p.note(
			"No quality gates selected, so 'on gates pass' will hold every merge for manual review.\nAdd gates or pick a different mode to actually auto-merge.",
			"Heads up",
		);
	}

	// 6b. Advanced limits — gated so the common path stays short.
	const agents = { ...currentConfig.agents };
	const tuneAdvanced = ensure(
		await p.confirm({
			message: "Tune advanced limits (concurrency, timeouts, skip steps)?",
			initialValue: false,
		}),
	);
	if (tuneAdvanced) {
		const posInt = (v: string | undefined): string | undefined =>
			v && Number.isInteger(Number(v)) && Number(v) >= 0 ? undefined : "Enter a whole number ≥ 0";
		agents.maxConcurrent = Number(
			ensure(
				await p.text({
					message: "Max agents running at once",
					initialValue: String(agents.maxConcurrent),
					validate: (v) => (v && Number(v) >= 1 ? undefined : "Enter a number ≥ 1"),
				}),
			),
		);
		agents.maxAgentsPerLead = Number(
			ensure(
				await p.text({
					message: "Max workers per lead",
					initialValue: String(agents.maxAgentsPerLead),
					validate: (v) => (v && Number(v) >= 1 ? undefined : "Enter a number ≥ 1"),
				}),
			),
		);
		agents.turnTimeoutMinutes = Number(
			ensure(
				await p.text({
					message: "Per-turn timeout in minutes (0 = no cap)",
					initialValue: String(agents.turnTimeoutMinutes),
					validate: posInt,
				}),
			),
		);
		const skips = ensure(
			await p.multiselect({
				message: "Default speed shortcuts (leave empty for none)",
				options: [
					{
						value: "skipScout",
						label: "Skip scout step",
						hint: "leads dispatch builders directly",
					},
					{ value: "skipReview", label: "Skip review step", hint: "no reviewer before integrate" },
					{
						value: "skipGates",
						label: "Skip quality gates",
						hint: "faster; disables on-gates-pass merge",
					},
					{ value: "skipSkills", label: "Skip skill distillation" },
				],
				initialValues: [],
				required: false,
			}),
		) as string[];
		agents.skipScout = skips.includes("skipScout");
		agents.skipReview = skips.includes("skipReview");
		agents.skipGates = skips.includes("skipGates");
		agents.skipSkills = skips.includes("skipSkills");

		agents.purgeOnReap = ensure(
			await p.confirm({
				message: "Fully erase idle agents when reaped (mail, events, merges, files, session)?",
				initialValue: agents.purgeOnReap,
			}),
		);
	}

	// 7. Summary -----------------------------------------------------------
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
			`gates:     ${qualityGates.length ? qualityGates.map((g) => g.name).join(", ") : "none"}`,
			`auto-merge:${autoMerge}`,
			agents.purgeOnReap ? "purge-on-reap: on (idle agents fully erased)" : undefined,
			modelsByCapability?.scout
				? `fast model: ${modelsByCapability.scout} (scout, reviewer)`
				: undefined,
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
	config.merge = { ...config.merge, autoMerge };
	config.agents = agents;
	if (qualityGates.length) config.project = { ...config.project, qualityGates };
	if (modelsByCapability) {
		const pc = config.providers[providerId];
		if (pc) config.providers[providerId] = { ...pc, models: modelsByCapability };
	}

	p.outro("Ready to write configuration.");
	return secret ? { config, secret } : { config };
}
