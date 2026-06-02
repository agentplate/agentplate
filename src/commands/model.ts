/**
 * `agentplate model` — switch the active provider/model after initial setup.
 *
 * Reuses the same wizard as `agentplate setup` (à la Hermes' `hermes model`), so
 * provider/model/runtime changes go through one consistent flow.
 */

import { Command } from "commander";
import { findProjectRoot, isInitialized, loadConfig } from "../config.ts";
import { ValidationError } from "../errors.ts";
import { jsonOutput } from "../json.ts";
import { brand, printHint, printInfo, printSuccess } from "../logging/color.ts";
import { getProviderSpec } from "../providers/registry.ts";
import { scaffoldAgentplateDir } from "../scaffold.ts";
import { setSecret } from "../secrets.ts";
import { runSetupWizard } from "../wizard/setup.ts";

export function createModelCommand(): Command {
	return new Command("model")
		.description("Change the active AI provider and model")
		.option("--json", "print the current provider/model and exit")
		.action(async (_opts: { json?: boolean }, command: Command) => {
			const useJson = command.optsWithGlobals().json === true;
			const root = findProjectRoot();
			if (!isInitialized(root)) {
				throw new ValidationError("Not initialized. Run `agentplate setup` first.");
			}
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
			scaffoldAgentplateDir(root, result.config);
			if (result.secret) {
				setSecret(root, result.secret.key, result.secret.value);
			}
			printSuccess(`${brand("Agentplate")} provider updated to ${result.config.activeProvider}.`);
		});
}
