/**
 * `agentplate model` — switch the active provider/model after initial setup.
 *
 * Reuses the same wizard as `agentplate setup` (à la Hermes' `hermes model`), so
 * provider/model/runtime changes go through one consistent flow.
 */

import { Command } from "commander";
import { isInitialized, loadCommittedConfig, loadConfig } from "../config.ts";
import { jsonOutput } from "../json.ts";
import { brand, printHint, printInfo, printSuccess } from "../logging/color.ts";
import { getProviderSpec } from "../providers/registry.ts";
import { scaffoldAgentplateDir } from "../scaffold.ts";
import { setSecret } from "../secrets.ts";
import type { AgentplateConfig } from "../types.ts";
import { runSetupWizard } from "../wizard/setup.ts";
import { requireInit } from "./shared.ts";

type PlainObject = Record<string, unknown>;

function isPlainObject(value: unknown): value is PlainObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Copy into `target` every change between `before` and `after` (leaf values, arrays
 * as whole values, and keys `after` dropped). Unchanged values are left alone, so a
 * value that came only from config.local.yaml is never written to `target`.
 */
function applyChanges(target: PlainObject, before: PlainObject, after: PlainObject): void {
	for (const key of Object.keys(before)) {
		if (!(key in after)) delete target[key];
	}
	for (const [key, next] of Object.entries(after)) {
		const prev = before[key];
		if (isPlainObject(next) && isPlainObject(prev)) {
			const existing = target[key];
			const sub = isPlainObject(existing) ? existing : {};
			applyChanges(sub, prev, next);
			// Don't materialize an empty object for a subtree the user didn't touch.
			if (isPlainObject(existing) || Object.keys(sub).length > 0) target[key] = sub;
		} else if (JSON.stringify(next) !== JSON.stringify(prev)) {
			target[key] = structuredClone(next);
		}
	}
}

/**
 * Build the config to write to the committed config.yaml after the wizard ran.
 *
 * The wizard is shown the fully merged config (so its defaults match what is in
 * effect), but only the changes the user made are applied on top of the committed
 * layer (defaults <- config.yaml). Overrides from the gitignored config.local.yaml and
 * the absolute `project.root` therefore never leak into the tracked file.
 *
 * @param committed defaults <- config.yaml (see {@link loadCommittedConfig})
 * @param shown     the merged config the wizard started from
 * @param result    the wizard's resulting config
 */
export function buildPersistedConfig(
	committed: AgentplateConfig,
	shown: AgentplateConfig,
	result: AgentplateConfig,
): AgentplateConfig {
	const out = structuredClone(committed) as unknown as PlainObject;
	applyChanges(out, shown as unknown as PlainObject, result as unknown as PlainObject);
	const persisted = out as unknown as AgentplateConfig;
	persisted.project = { ...persisted.project, root: "" };
	// The committed active provider must be fully defined in config.yaml itself, or a
	// fresh clone (no config.local.yaml) fails validation. If the user made a provider
	// active whose entry lives only in config.local.yaml (so the diff above wrote none,
	// or only the changed fields), commit the entry the wizard confirmed in full.
	const active = persisted.activeProvider;
	const chosen = result.providers[active];
	const written = persisted.providers[active];
	if (chosen && !written?.type) {
		persisted.providers = { ...persisted.providers, [active]: structuredClone(chosen) };
	}
	return persisted;
}

/**
 * Persist a wizard result for `root`: rewrite config.yaml with the base layer only
 * (see {@link buildPersistedConfig}) and refresh the supporting files. Shared by
 * `agentplate setup` and `agentplate model`.
 */
export function persistWizardConfig(
	root: string,
	shown: AgentplateConfig,
	result: AgentplateConfig,
): AgentplateConfig {
	const committed = isInitialized(root) ? loadCommittedConfig(root) : shown;
	const persisted = buildPersistedConfig(committed, shown, result);
	scaffoldAgentplateDir(root, persisted);
	return persisted;
}

export function createModelCommand(): Command {
	return new Command("model")
		.description("Change the active AI provider and model")
		.option("--json", "print the current provider/model and exit")
		.action(async (_opts: { json?: boolean }, command: Command) => {
			const useJson = command.optsWithGlobals().json === true;
			const root = requireInit();
			const config = loadConfig(root);

			// `--json` is a read-only query of the current selection.
			if (useJson) {
				const active = config.providers[config.activeProvider];
				jsonOutput({
					activeProvider: config.activeProvider,
					model: active?.model ?? null,
					runtime: config.runtime.default,
				});
				return;
			}

			if (!process.stdin.isTTY) {
				const active = config.providers[config.activeProvider];
				const spec = getProviderSpec(config.activeProvider);
				printInfo(`Active provider: ${spec?.label ?? config.activeProvider}`);
				printInfo(`Model:           ${active?.model ?? "(unset)"}`);
				printInfo(`Runtime:         ${config.runtime.default}`);
				printHint("Run in a terminal to change these interactively.");
				return;
			}

			const result = await runSetupWizard(config);
			persistWizardConfig(root, config, result.config);
			if (result.secret) {
				setSecret(root, result.secret.key, result.secret.value);
			}
			printSuccess(`${brand("Agentplate")} provider updated to ${result.config.activeProvider}.`);
		});
}
