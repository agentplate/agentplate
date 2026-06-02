/**
 * `agentplate init` — non-interactive scaffold.
 *
 * Creates `.agentplate/` with a sensible auto-detected config and exits. For an
 * interactive provider/runtime walkthrough, use `agentplate setup` instead.
 */

import { Command } from "commander";
import { DEFAULT_CONFIG, findProjectRoot, isInitialized } from "../config.ts";
import { jsonOutput } from "../json.ts";
import { brand, printHint, printInfo, printSuccess, printWarning } from "../logging/color.ts";
import { scaffoldAgentplateDir } from "../scaffold.ts";
import type { AgentplateConfig } from "../types.ts";
import { detectCanonicalBranch, detectDefaultRuntime, detectProjectName } from "../utils/detect.ts";

export interface InitOptions {
	yes?: boolean;
	name?: string;
	json?: boolean;
}

/** Build an auto-detected config for a fresh project (no secrets touched). */
export async function buildInitialConfig(
	root: string,
	nameOverride?: string,
): Promise<AgentplateConfig> {
	const [name, canonicalBranch, runtime] = await Promise.all([
		nameOverride ? Promise.resolve(nameOverride) : detectProjectName(root),
		detectCanonicalBranch(root),
		detectDefaultRuntime(),
	]);
	const config = structuredClone(DEFAULT_CONFIG);
	config.project.name = name;
	config.project.root = root;
	config.project.canonicalBranch = canonicalBranch;
	config.runtime.default = runtime;
	return config;
}

export async function runInit(opts: InitOptions): Promise<AgentplateConfig> {
	const root = findProjectRoot();
	const already = isInitialized(root);
	if (already && !opts.yes && !opts.json) {
		printWarning(`Agentplate is already initialized at ${root}/.agentplate`);
		printHint("Re-running will refresh config.yaml. Pass --yes to silence this notice.");
	}
	const config = await buildInitialConfig(root, opts.name);
	scaffoldAgentplateDir(root, config);
	return config;
}

export function createInitCommand(): Command {
	return new Command("init")
		.description("Initialize .agentplate/ with an auto-detected config (non-interactive)")
		.option("-y, --yes", "skip the already-initialized notice")
		.option("--name <name>", "set the project name (default: auto-detect)")
		.option("--json", "output JSON")
		.action(async (opts: InitOptions, command: Command) => {
			const useJson = command.optsWithGlobals().json === true;
			const config = await runInit({ ...opts, json: useJson });
			if (useJson) {
				jsonOutput({ initialized: true, root: config.project.root, config });
				return;
			}
			printSuccess(`Initialized ${brand("Agentplate")} at ${config.project.root}/.agentplate`);
			printInfo(`  project:  ${config.project.name}`);
			printInfo(`  branch:   ${config.project.canonicalBranch}`);
			printInfo(`  runtime:  ${config.runtime.default}`);
			printHint("\nNext: run `agentplate setup` to choose your AI provider and add your API key.");
		});
}
