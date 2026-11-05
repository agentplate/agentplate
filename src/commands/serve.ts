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
import { accent, brand, printHint, printInfo, printSuccess } from "../logging/color.ts";
import { packageRootDir } from "../paths.ts";
import { isLoopbackHost, startServer } from "../serve/server.ts";

/**
 * The warning printed (to stderr, never suppressed) when binding off loopback:
 * the API can spawn agents that run with bypassed permissions, so anyone holding
 * the per-launch token who can reach the port can run code as this user — and
 * the traffic (token included) is plain HTTP.
 */
export function remoteBindWarning(host: string): string {
	return [
		`${accent("!")} WARNING: binding to ${host}, which is NOT a loopback address.`,
		"  The API now requires the per-launch bearer token printed below, but it is sent",
		"  over plain HTTP. Anyone who obtains it and can reach this port can read all",
		"  agent state AND spawn agents that run commands on this machine.",
		"  Only do this on a network you fully trust; prefer the default 127.0.0.1.",
	].join("\n");
}

/** The browser URL that hands the SPA its token (it keeps it in sessionStorage). */
export function tokenUrl(url: string, token: string | null): string {
	return token === null ? url : `${url}/?token=${encodeURIComponent(token)}`;
}

export function createServeCommand(): Command {
	return new Command("serve")
		.description("Serve the web UI (HTTP + WebSocket) over the project's state")
		.option("--port <n>", "port", "7551")
		.option(
			"--host <addr>",
			"bind host (non-loopback requires a per-launch bearer token)",
			"127.0.0.1",
		)
		.option("--ui-dir <path>", "directory of the built SPA (default: bundled ui/dist)")
		.option(
			"--allow-origin <origin>",
			"extra trusted browser origin for writes + /ws, repeatable (e.g. http://localhost:5173 for the Vite dev server)",
			(value: string, previous: string[]) => [...previous, value],
			[] as string[],
		)
		.option("--json", "output JSON (prints the URL and exits non-blocking info)")
		.action(
			async (
				opts: {
					port: string;
					host: string;
					uiDir?: string;
					allowOrigin: string[];
					json?: boolean;
				},
				command: Command,
			) => {
				const useJson = command.optsWithGlobals().json === true;
				const root = findProjectRoot();
				if (!isInitialized(root)) {
					throw new ValidationError("Not initialized. Run `agentplate setup` first.");
				}
				const uiDir = opts.uiDir ?? join(packageRootDir(), "ui", "dist");
				if (!isLoopbackHost(opts.host)) process.stderr.write(`${remoteBindWarning(opts.host)}\n`);
				const handle = startServer({
					root,
					port: Number(opts.port),
					host: opts.host,
					uiDir,
					allowedOrigins: opts.allowOrigin,
				});

				if (useJson) {
					jsonOutput({
						url: handle.url,
						healthz: `${handle.url}/healthz`,
						uiDir,
						token: handle.token,
						open: tokenUrl(handle.url, handle.token),
					});
				} else {
					printSuccess(`${brand("agentplate serve")} → ${tokenUrl(handle.url, handle.token)}`);
					printInfo(`  REST:    ${handle.url}/api/overview`);
					printInfo(`  health:  ${handle.url}/healthz`);
					if (handle.token !== null) {
						printInfo(`  token:   ${handle.token}  (send as "Authorization: Bearer <token>")`);
					}
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
