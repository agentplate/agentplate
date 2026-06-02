/**
 * `agentplate log <event>` — record an agent lifecycle/tool event (hook target).
 *
 * Called by runtime hooks (e.g. PreToolUse/PostToolUse/Stop) to feed the event
 * store that powers `agentplate status` and observability. Kept minimal in the
 * basic core; session-end quality-gate scoring layers on in a later phase.
 */

import { Command } from "commander";
import { findProjectRoot, isInitialized } from "../config.ts";
import { ValidationError } from "../errors.ts";
import { createEventStore } from "../events/store.ts";
import { jsonOutput } from "../json.ts";
import { eventsDbPath } from "../paths.ts";

export function createLogCommand(): Command {
	return new Command("log")
		.description("Record an agent event (hook target)")
		.argument("<event>", "event type, e.g. tool-start | tool-end | session-end")
		.option("--agent <name>", "agent name", "unknown")
		.option("--tool <name>", "tool name (for tool events)")
		.option("--detail <json>", "JSON detail blob")
		.option("--run <id>", "run id")
		.option("--json", "output JSON")
		.action(
			(
				event: string,
				opts: { agent: string; tool?: string; detail?: string; run?: string; json?: boolean },
				command: Command,
			) => {
				const useJson = command.optsWithGlobals().json === true;
				const root = findProjectRoot();
				if (!isInitialized(root)) {
					throw new ValidationError("Not initialized. Run `agentplate setup` first.");
				}
				const events = createEventStore(eventsDbPath(root));
				try {
					const record = events.record({
						agentName: opts.agent,
						runId: opts.run ?? null,
						type: event,
						tool: opts.tool ?? null,
						detail: opts.detail ?? null,
					});
					if (useJson) jsonOutput(record);
				} finally {
					events.close();
				}
			},
		);
}
