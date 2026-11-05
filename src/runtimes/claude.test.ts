/**
 * Credential routing for the claude runtime's endpoint override: a shell-exported
 * ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN must never reach a non-Anthropic
 * `ANTHROPIC_BASE_URL` unless the provider explicitly resolved that env var
 * itself, and a gateway provider's own key is presented as the bearer.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../config.ts";
import { setSecret } from "../secrets.ts";
import type { AgentplateConfig, ProviderConfig } from "../types.ts";
import { agentChildEnv } from "../utils/child-process.ts";
import { ClaudeRuntime, isAnthropicBaseUrl } from "./claude.ts";
import { resolveModel } from "./resolve.ts";

const runtime = new ClaudeRuntime();
const SHELL_KEY = "sk-ant-shell-exported-key-0123456789";
// Built by concatenation so the fixture never looks like a real token at rest.
const SHELL_TOKEN = ["sk-ant-oat01", "shell", "exported", "token", "0123456789"].join("-");

/** The child env every spawn site builds: the allowlisted parent env + runtime env. */
function childEnv(
	runtimeEnv: Record<string, string>,
	parent: Record<string, string | undefined> = {
		ANTHROPIC_API_KEY: SHELL_KEY,
		ANTHROPIC_AUTH_TOKEN: SHELL_TOKEN,
		PATH: "/usr/bin",
	},
): Record<string, string | undefined> {
	return agentChildEnv(runtimeEnv, { passthrough: runtime.envPassthrough, parent });
}

describe("isAnthropicBaseUrl", () => {
	test("accepts anthropic.com and its subdomains", () => {
		expect(isAnthropicBaseUrl("https://api.anthropic.com")).toBe(true);
		expect(isAnthropicBaseUrl("https://api.anthropic.com/v1")).toBe(true);
		expect(isAnthropicBaseUrl("https://anthropic.com")).toBe(true);
		expect(isAnthropicBaseUrl("https://API.Anthropic.COM")).toBe(true);
	});

	test("rejects third-party, lookalike, loopback and unparseable URLs", () => {
		expect(isAnthropicBaseUrl("https://openrouter.ai/api/v1")).toBe(false);
		expect(isAnthropicBaseUrl("https://attacker.example/v1")).toBe(false);
		expect(isAnthropicBaseUrl("https://api.anthropic.com.attacker.example")).toBe(false);
		expect(isAnthropicBaseUrl("https://evilanthropic.com")).toBe(false);
		expect(isAnthropicBaseUrl("https://user@attacker.example/?h=api.anthropic.com")).toBe(false);
		expect(isAnthropicBaseUrl("http://localhost:4000")).toBe(false);
		expect(isAnthropicBaseUrl("not a url")).toBe(false);
	});
});

describe("ClaudeRuntime.buildEnv — shell ANTHROPIC_API_KEY vs. non-Anthropic baseUrl", () => {
	test("api-key gateway whose credential is another env var: shell key is withheld", () => {
		// OpenRouter-style: the provider's own key is OPENROUTER_API_KEY, which the
		// claude CLI never reads — the shell Anthropic key must not go to openrouter.ai.
		const env = runtime.buildEnv({
			model: "qwen/qwen3-coder:free",
			env: { OPENROUTER_API_KEY: "or-key" },
			baseUrl: "https://openrouter.ai/api/v1",
			authMode: "api-key",
		});
		const child = childEnv(env);
		expect(child.ANTHROPIC_API_KEY).toBe("");
		expect(child.ANTHROPIC_AUTH_TOKEN).toBe("");
		expect(child.ANTHROPIC_BASE_URL).toBe("https://openrouter.ai/api");
		expect(child.OPENROUTER_API_KEY).toBe("or-key");
		expect(child.PATH).toBe("/usr/bin");
	});

	test("gateway credential (authTokenEnv) is presented as ANTHROPIC_AUTH_TOKEN", () => {
		// OpenRouter's Claude Code recipe: base URL + its key as the bearer + an
		// explicitly empty ANTHROPIC_API_KEY. Without the mapping the CLI sends no
		// gateway credential at all (it never reads OPENROUTER_API_KEY).
		const env = runtime.buildEnv({
			model: "qwen/qwen3-coder:free",
			env: { OPENROUTER_API_KEY: "or-key" },
			authTokenEnv: "OPENROUTER_API_KEY",
			baseUrl: "https://openrouter.ai/api/v1",
			authMode: "api-key",
		});
		const child = childEnv(env);
		expect(child.ANTHROPIC_AUTH_TOKEN).toBe("or-key");
		expect(child.ANTHROPIC_API_KEY).toBe("");
		expect(child.ANTHROPIC_BASE_URL).toBe("https://openrouter.ai/api");
	});

	test("the gateway mapping never sends a provider key to Anthropic or without a baseUrl", () => {
		const anthropic = runtime.buildEnv({
			model: "m",
			env: { OTHER_KEY: "k" },
			authTokenEnv: "OTHER_KEY",
			baseUrl: "https://api.anthropic.com",
			authMode: "api-key",
		});
		expect(anthropic.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
		const noBaseUrl = runtime.buildEnv({
			model: "m",
			env: { OTHER_KEY: "k" },
			authTokenEnv: "OTHER_KEY",
			authMode: "api-key",
		});
		expect(noBaseUrl).toEqual({ OTHER_KEY: "k" });
	});

	test("subscription mode + non-Anthropic baseUrl: shell key AND shell bearer are withheld", () => {
		const env = runtime.buildEnv({
			model: "m",
			baseUrl: "https://attacker.example/v1",
			authMode: "subscription",
		});
		const child = childEnv(env);
		expect(child.ANTHROPIC_API_KEY).toBe("");
		// Pinned to "" (unset to the CLI), never a dummy bearer — the CLI's own
		// login still carries auth — and never the shell-exported token.
		expect(child.ANTHROPIC_AUTH_TOKEN).toBe("");
	});

	test("a provider that set ANTHROPIC_AUTH_TOKEN itself gets it forwarded", () => {
		const env = runtime.buildEnv({
			model: "m",
			env: { ANTHROPIC_AUTH_TOKEN: "gw-configured-token" },
			authTokenEnv: "ANTHROPIC_AUTH_TOKEN",
			baseUrl: "https://gw.example.com",
			authMode: "env",
		});
		const child = childEnv(env);
		expect(child.ANTHROPIC_AUTH_TOKEN).toBe("gw-configured-token");
		expect(child.ANTHROPIC_API_KEY).toBe("");
	});

	test("env mode with an unresolved credential: shell key is withheld", () => {
		const env = runtime.buildEnv({
			model: "m",
			env: {},
			baseUrl: "https://gw.example.com",
			authMode: "env",
		});
		expect(childEnv(env).ANTHROPIC_API_KEY).toBe("");
	});

	test("a provider that explicitly resolved ANTHROPIC_API_KEY gets it forwarded", () => {
		const env = runtime.buildEnv({
			model: "m",
			env: { ANTHROPIC_API_KEY: "sk-ant-configured-for-this-gateway" },
			baseUrl: "https://gw.example.com",
			authMode: "api-key",
		});
		expect(childEnv(env).ANTHROPIC_API_KEY).toBe("sk-ant-configured-for-this-gateway");
	});

	test("an Anthropic baseUrl leaves the shell key alone", () => {
		const env = runtime.buildEnv({
			model: "m",
			baseUrl: "https://api.anthropic.com",
			authMode: "subscription",
		});
		expect(env).toEqual({ ANTHROPIC_BASE_URL: "https://api.anthropic.com" });
		expect(childEnv(env).ANTHROPIC_API_KEY).toBe(SHELL_KEY);
		expect(childEnv(env).ANTHROPIC_AUTH_TOKEN).toBe(SHELL_TOKEN);
	});

	test("no baseUrl leaves the shell key alone (legacy behavior)", () => {
		expect(
			childEnv(runtime.buildEnv({ model: "m", authMode: "subscription" })).ANTHROPIC_API_KEY,
		).toBe(SHELL_KEY);
	});
});

describe("resolveModel → ClaudeRuntime.buildEnv → spawned child", () => {
	let root: string;
	let savedKey: string | undefined;
	let savedToken: string | undefined;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "agentplate-claude-env-"));
		mkdirSync(join(root, ".agentplate"), { recursive: true });
		savedKey = process.env.ANTHROPIC_API_KEY;
		savedToken = process.env.ANTHROPIC_AUTH_TOKEN;
		process.env.ANTHROPIC_API_KEY = SHELL_KEY;
		process.env.ANTHROPIC_AUTH_TOKEN = SHELL_TOKEN;
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
		if (savedKey === undefined) delete process.env.ANTHROPIC_API_KEY;
		else process.env.ANTHROPIC_API_KEY = savedKey;
		if (savedToken === undefined) delete process.env.ANTHROPIC_AUTH_TOKEN;
		else process.env.ANTHROPIC_AUTH_TOKEN = savedToken;
	});

	function configWith(provider: ProviderConfig): AgentplateConfig {
		const cfg = structuredClone(DEFAULT_CONFIG);
		cfg.activeProvider = "x";
		cfg.providers.x = provider;
		return cfg;
	}

	/** Spawn a real child exactly like turn-runner does and read one env var. */
	async function childVar(runtimeEnv: Record<string, string>, name: string): Promise<string> {
		const proc = Bun.spawn(
			[process.execPath, "-e", `process.stdout.write(process.env.${name} ?? '<unset>')`],
			{
				env: agentChildEnv(runtimeEnv, { passthrough: runtime.envPassthrough }),
				stdout: "pipe",
				stderr: "pipe",
			},
		);
		const out = await new Response(proc.stdout).text();
		expect(await proc.exited).toBe(0);
		return out;
	}
	const childApiKey = (env: Record<string, string>) => childVar(env, "ANTHROPIC_API_KEY");
	const childAuthToken = (env: Record<string, string>) => childVar(env, "ANTHROPIC_AUTH_TOKEN");

	test("a committed gateway config (subscription) cannot exfiltrate the shell key", async () => {
		const cfg = configWith({
			type: "gateway",
			authMode: "subscription",
			model: "m",
			baseUrl: "https://attacker.example/v1",
		});
		const resolved = resolveModel(cfg, root, "alias", undefined, () => {});
		expect(await childApiKey(runtime.buildEnv(resolved))).toBe("");
		expect(await childAuthToken(runtime.buildEnv(resolved))).toBe("");
	});

	test("an api-key gateway with its own credential sends that, not the shell key", async () => {
		setSecret(root, "OPENROUTER_API_KEY", "or-file-key");
		const cfg = configWith({
			type: "gateway",
			authMode: "api-key",
			authTokenEnv: "OPENROUTER_API_KEY",
			model: "m",
			baseUrl: "https://openrouter.ai/api/v1",
		});
		const resolved = resolveModel(cfg, root, "alias", undefined, () => {});
		expect(resolved.authTokenEnv).toBe("OPENROUTER_API_KEY");
		expect(await childApiKey(runtime.buildEnv(resolved))).toBe("");
		// The OpenRouter key authenticates as the bearer; the shell token never does.
		expect(await childAuthToken(runtime.buildEnv(resolved))).toBe("or-file-key");
	});

	test("a gateway configured with authTokenEnv ANTHROPIC_API_KEY still receives it", async () => {
		const cfg = configWith({
			type: "gateway",
			authMode: "env",
			authTokenEnv: "ANTHROPIC_API_KEY",
			model: "m",
			baseUrl: "https://gw.example.com",
		});
		const resolved = resolveModel(cfg, root, "alias", undefined, () => {});
		expect(await childApiKey(runtime.buildEnv(resolved))).toBe(SHELL_KEY);
	});
});
