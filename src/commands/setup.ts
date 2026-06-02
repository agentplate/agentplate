/**
 * `agentplate setup` — interactive onboarding.
 *
 * Ensures `.agentplate/` exists, then runs the provider/runtime/model wizard and
 * persists the resulting config and (optionally) an API key into the gitignored
 * secrets store.
 */

import { Command } from "commander";
import { findProjectRoot, isInitialized, loadConfig } from "../config.ts";
import { ValidationError } from "../errors.ts";
import { brand, printHint, printSuccess } from "../logging/color.ts";
import { ensureAgentplateDirs, scaffoldAgentplateDir } from "../scaffold.ts";
import { setSecret } from "../secrets.ts";
import { runSetupWizard } from "../wizard/setup.ts";
import { buildInitialConfig } from "./init.ts";

export function createSetupCommand(): Command {
	return new Command("setup")
		.description("Interactive setup — choose an AI provider, add your API key, pick a runtime")
		.option("--name <name>", "set the project name (default: auto-detect)")
		.action(async (opts: { name?: string }) => {
			if (!process.stdin.isTTY) {
				throw new ValidationError(
					"`agentplate setup` is interactive and needs a terminal. Use `agentplate init` for non-interactive scaffolding.",
				);
			}

			const root = findProjectRoot();
			ensureAgentplateDirs(root);

			const currentConfig = isInitialized(root)
				? loadConfig(root)
				: await buildInitialConfig(root, opts.name);

			const result = await runSetupWizard(currentConfig);

			// Write config (+ supporting files), then the secret (after .gitignore exists).
			scaffoldAgentplateDir(root, result.config);
			if (result.secret) {
				setSecret(root, result.secret.key, result.secret.value);
			}

			printSuccess(`${brand("Agentplate")} is configured.`);
			printHint("Verify with `agentplate doctor`. Your API key (if entered) is in");
			printHint("  .agentplate/secrets.local.yaml  (gitignored — never committed).");
		});
}
