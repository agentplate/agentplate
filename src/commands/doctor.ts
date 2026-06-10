/**
 * `agentplate doctor` — health checks for the Agentplate setup.
 *
 * Checks are grouped into categories. Phase 0/1 ship `core` (toolchain + repo +
 * initialization) and `providers` (active provider + credential presence, by env
 * var name only — values are never read into the report). Later phases register
 * more categories (databases, deploy, …).
 */

import { Command } from "commander";
import { findProjectRoot, isInitialized, loadConfig } from "../config.ts";
import { jsonOutput } from "../json.ts";
import { brand, printError, printHint, printInfo, printSuccess } from "../logging/color.ts";
import { getProviderSpec } from "../providers/registry.ts";
import { hasSecret } from "../secrets.ts";
import { commandOnPath, resolveArgv } from "../utils/detect.ts";

interface DoctorCheck {
	category: string;
	name: string;
	ok: boolean;
	detail: string;
}

async function commandOutput(cmd: string, args: string[]): Promise<string | null> {
	try {
		const proc = Bun.spawn(resolveArgv([cmd, ...args]), { stdout: "pipe", stderr: "pipe" });
		const code = await proc.exited;
		if (code !== 0) return null;
		return (await new Response(proc.stdout).text()).trim();
	} catch {
		return null;
	}
}

/** True when the URL's host is loopback (localhost / 127.0.0.1 / [::1]). */
function isLoopbackHost(url: string): boolean {
	try {
		const { hostname } = new URL(url);
		return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
	} catch {
		return false;
	}
}

/**
 * Probe a provider base URL for reachability. ANY HTTP response (any status)
 * counts as reachable — we only care that something is listening.
 */
async function probeBaseUrl(url: string): Promise<DoctorCheck> {
	try {
		const response = await fetch(url, { signal: AbortSignal.timeout(2000) });
		return {
			category: "providers",
			name: "endpoint",
			ok: true,
			detail: `${url} reachable (HTTP ${response.status})`,
		};
	} catch {
		const hint = isLoopbackHost(url)
			? "is the server running? (local Ollama: `ollama serve`)"
			: "is the server running?";
		return {
			category: "providers",
			name: "endpoint",
			ok: false,
			detail: `${url} unreachable — ${hint}`,
		};
	}
}

async function coreChecks(root: string): Promise<DoctorCheck[]> {
	const checks: DoctorCheck[] = [];
	checks.push({ category: "core", name: "bun", ok: true, detail: `v${Bun.version}` });

	const gitVersion = await commandOutput("git", ["--version"]);
	checks.push({
		category: "core",
		name: "git",
		ok: gitVersion !== null,
		detail: gitVersion ?? "not found on PATH",
	});

	const isRepo = (await commandOutput("git", ["rev-parse", "--is-inside-work-tree"])) === "true";
	checks.push({
		category: "core",
		name: "git repository",
		ok: isRepo,
		detail: isRepo ? root : "not inside a git repository",
	});

	const initialized = isInitialized(root);
	checks.push({
		category: "core",
		name: "agentplate initialized",
		ok: initialized,
		detail: initialized ? `${root}/.agentplate` : "run `agentplate setup` to get started",
	});
	return checks;
}

async function providerChecks(root: string): Promise<DoctorCheck[]> {
	if (!isInitialized(root)) {
		return [
			{
				category: "providers",
				name: "provider",
				ok: false,
				detail: "not initialized — run `agentplate setup`",
			},
		];
	}
	const config = loadConfig(root);
	const providerId = config.activeProvider;
	const providerConfig = config.providers[providerId];
	const spec = getProviderSpec(providerId);
	const checks: DoctorCheck[] = [];

	checks.push({
		category: "providers",
		name: "active provider",
		ok: providerConfig !== undefined,
		detail: providerConfig
			? `${spec?.label ?? providerId} (model: ${providerConfig.model ?? "unset"})`
			: `"${providerId}" is not configured`,
	});

	// Auth-mode-aware credentials check. Legacy configs (no authMode) are treated
	// as api-key when a token env var is present, else none.
	const authMode =
		providerConfig?.authMode ??
		(spec?.keyless ? "none" : providerConfig?.authTokenEnv ? "api-key" : "none");
	const envVar = providerConfig?.authTokenEnv ?? spec?.authEnvVar;

	if (authMode === "none") {
		checks.push({
			category: "providers",
			name: "credentials",
			ok: true,
			detail: "no credentials required (local provider)",
		});
	} else if (authMode === "subscription") {
		const cli = spec?.subscriptionRuntime ?? config.runtime.default;
		const installed = await commandOnPath(cli);
		checks.push({
			category: "providers",
			name: "credentials",
			ok: installed,
			detail: installed
				? `subscription via \`${cli}\` (ensure it is logged in)`
				: `subscription auth needs \`${cli}\` on PATH — install/login first`,
		});
	} else if (envVar) {
		const present = hasSecret(root, envVar);
		checks.push({
			category: "providers",
			name: "credentials",
			ok: present,
			detail: present
				? `${envVar} is set`
				: `${envVar} not found (add it via \`agentplate setup\` or the environment)`,
		});
	}

	if (providerConfig?.baseUrl) {
		const baseUrl = providerConfig.baseUrl;
		// Plain http to a non-loopback host sends credentials unencrypted. Surfaced
		// as a warning (ok: true + "warning:" prefix) since DoctorCheck has no warn
		// tier and the setup may still be intentional (e.g. a trusted LAN).
		if (baseUrl.startsWith("http://") && !isLoopbackHost(baseUrl)) {
			checks.push({
				category: "providers",
				name: "transport",
				ok: true,
				detail: `warning: ${baseUrl} uses plain http to a non-local host — credentials travel unencrypted; prefer https`,
			});
		}
		checks.push(await probeBaseUrl(baseUrl));
	}
	return checks;
}

/**
 * Deploy checks: report each configured deploy target and whether its required
 * secrets are present (by env-var NAME only — values are never read here).
 */
function deployChecks(root: string): DoctorCheck[] {
	if (!isInitialized(root)) return [];
	const config = loadConfig(root);
	const checks: DoctorCheck[] = [];
	const defaultTarget = config.deploy.default;
	checks.push({
		category: "deploy",
		name: "default target",
		ok: true,
		detail: defaultTarget || "(none — set with `agentplate target configure`)",
	});
	for (const [name, targetConfig] of Object.entries(config.deploy.targets)) {
		const required = Object.values(targetConfig.secretEnv).map((b) => b.fromEnv);
		const missing = required.filter((envVar) => !hasSecret(root, envVar));
		checks.push({
			category: "deploy",
			name: `target ${name}`,
			ok: missing.length === 0,
			detail:
				missing.length === 0
					? `secrets present (${required.join(", ") || "none required"})`
					: `missing secrets: ${missing.join(", ")}`,
		});
	}
	return checks;
}

export function createDoctorCommand(): Command {
	return new Command("doctor")
		.description("Run health checks on the Agentplate setup")
		.option("--category <name>", "run a single category: core | providers | deploy")
		.option("--json", "output JSON")
		.action(async (opts: { category?: string; json?: boolean }, command: Command) => {
			const useJson = command.optsWithGlobals().json === true;
			const root = findProjectRoot();
			const category = opts.category;

			const checks: DoctorCheck[] = [];
			if (!category || category === "core") checks.push(...(await coreChecks(root)));
			if (!category || category === "providers") checks.push(...(await providerChecks(root)));
			if (!category || category === "deploy") checks.push(...deployChecks(root));

			if (category && checks.length === 0) {
				printError(`Unknown category "${category}". Try: core, providers, deploy`);
				process.exitCode = 2;
				return;
			}

			const allOk = checks.every((c) => c.ok);

			if (useJson) {
				jsonOutput({ ok: allOk, checks });
				return;
			}

			printInfo(brand("agentplate doctor"));
			let currentCategory = "";
			for (const check of checks) {
				if (check.category !== currentCategory) {
					currentCategory = check.category;
					printInfo(`\n${currentCategory}`);
				}
				if (check.ok) {
					printSuccess(`${check.name}: ${check.detail}`);
				} else {
					printError(`${check.name}: ${check.detail}`);
				}
			}
			if (!allOk) {
				printHint("\nSome checks failed. Address the items above and re-run `agentplate doctor`.");
				process.exitCode = 1;
			}
		});
}
