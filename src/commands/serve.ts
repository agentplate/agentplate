/**
 * `agentplate serve` — HTTP + WebSocket surface for the web UI.
 *
 * Serves the REST API, a live WebSocket snapshot feed, and the built SPA from
 * `ui/dist`. All data is read from the same SQLite stores the CLI uses.
 */

import { join } from "node:path";
import { Command } from "commander";
import { findProjectRoot, isInitialized } from "../config.ts";
import { ValidationError } from "../errors.ts";
import { jsonOutput } from "../json.ts";
import { brand, printHint, printInfo, printSuccess } from "../logging/color.ts";
import { packageRootDir } from "../paths.ts";
import { startServer } from "../serve/server.ts";

export function createServeCommand(): Command {
	return new Command("serve")
		.description("Serve the web UI (HTTP + WebSocket) over the project's state")
		.option("--port <n>", "port", "7551")
		.option("--host <addr>", "bind host", "127.0.0.1")
		.option("--ui-dir <path>", "directory of the built SPA (default: bundled ui/dist)")
		.option("--json", "output JSON (prints the URL and exits non-blocking info)")
		.action(
			async (
				opts: { port: string; host: string; uiDir?: string; json?: boolean },
				command: Command,
			) => {
				const useJson = command.optsWithGlobals().json === true;
				const root = findProjectRoot();
				if (!isInitialized(root)) {
					throw new ValidationError("Not initialized. Run `agentplate setup` first.");
				}
				const uiDir = opts.uiDir ?? join(packageRootDir(), "ui", "dist");
				const handle = startServer({
					root,
					port: Number(opts.port),
					host: opts.host,
					uiDir,
				});

				if (useJson) {
					jsonOutput({ url: handle.url, healthz: `${handle.url}/healthz`, uiDir });
				} else {
					printSuccess(`${brand("agentplate serve")} → ${handle.url}`);
					printInfo(`  REST:    ${handle.url}/api/overview`);
					printInfo(`  health:  ${handle.url}/healthz`);
					printHint("  Press Ctrl+C to stop.");
				}

				// Keep the process alive until interrupted.
				const shutdown = () => {
					handle.stop();
					process.exit(0);
				};
				process.on("SIGINT", shutdown);
				process.on("SIGTERM", shutdown);
				await new Promise<never>(() => {});
			},
		);
}
