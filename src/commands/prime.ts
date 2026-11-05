/**
 * `agentplate prime` — load orchestration context (SessionStart hook target).
 *
 * Emits a concise snapshot of the project: provider/runtime, the current run,
 * and active sessions — so a fresh Claude Code session starts oriented.
 */

import { Command } from "commander";
import { loadConfig } from "../config.ts";
import { jsonOutput } from "../json.ts";
import { brand, muted, printInfo } from "../logging/color.ts";
import { sessionsDbPath } from "../paths.ts";
import { createSessionStore } from "../sessions/store.ts";
import { requireInit } from "./shared.ts";

export function createPrimeCommand(): Command {
	return new Command("prime")
		.description("Load orchestration context")
		.option("--json", "output JSON")
		.action((_opts: { json?: boolean }, command: Command) => {
			const useJson = command.optsWithGlobals().json === true;
			const root = requireInit();
			const config = loadConfig(root);
			const store = createSessionStore(sessionsDbPath(root));
			try {
				const runs = store.listRuns(1);
				const currentRun = runs[0] ?? null;
				const active = currentRun
					? store.listSessions({ runId: currentRun.id }).filter((s) => s.state === "working")
					: [];
				const provider = config.providers[config.activeProvider];

				if (useJson) {
					jsonOutput({
						project: config.project.name,
						runtime: config.runtime.default,
						provider: config.activeProvider,
						model: provider?.model ?? null,
						currentRun,
						activeAgents: active.map((s) => s.agentName),
					});
					return;
				}
				printInfo(brand(`Agentplate — ${config.project.name}`));
				printInfo(
					`runtime: ${config.runtime.default}  provider: ${config.activeProvider}  model: ${provider?.model ?? "(unset)"}`,
				);
				printInfo(
					currentRun ? `run: ${currentRun.id} (${currentRun.status})` : muted("no active run"),
				);
				printInfo(
					`active agents: ${active.length ? active.map((s) => s.agentName).join(", ") : muted("none")}`,
				);
			} finally {
				store.close();
			}
		});
}
