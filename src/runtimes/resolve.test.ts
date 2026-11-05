/**
 * Tests for resolveModel — per-capability model tiering, auth-mode env
 * injection, and provider baseUrl passthrough. Pure: secrets are read from
 * `process.env` (no secrets file at ROOT), tiering tests use authMode "none".
 */

import { afterEach, describe, expect, test } from "bun:test";
import { DEFAULT_CONFIG } from "../config.ts";
import type { AgentplateConfig, Capability, ProviderConfig } from "../types.ts";
import { isLoopbackBaseUrl, resolveModel } from "./resolve.ts";

/** A config whose active provider has a default model + optional tiering map. */
function configWith(
	model: string | undefined,
	models?: Partial<Record<Capability, string>>,
): AgentplateConfig {
	const cfg = structuredClone(DEFAULT_CONFIG);
	cfg.activeProvider = "anthropic";
	cfg.providers.anthropic = { type: "native", authMode: "none", model, models };
	return cfg;
}

const ROOT = "/tmp/agentplate-resolve-test"; // never read (authMode "none")

describe("resolveModel — tiering", () => {
	test("uses the provider default model when no capability is given", () => {
		const { model } = resolveModel(configWith("claude-opus-4-8"), ROOT, "alias");
		expect(model).toBe("claude-opus-4-8");
	});

	test("a per-capability override wins over the provider default", () => {
		const cfg = configWith("claude-opus-4-8", {
			scout: "claude-haiku-4-5",
			reviewer: "claude-haiku-4-5",
		});
		expect(resolveModel(cfg, ROOT, "alias", "scout").model).toBe("claude-haiku-4-5");
		expect(resolveModel(cfg, ROOT, "alias", "reviewer").model).toBe("claude-haiku-4-5");
	});

	test("a capability without an override falls back to the provider default", () => {
		const cfg = configWith("claude-opus-4-8", { scout: "claude-haiku-4-5" });
		expect(resolveModel(cfg, ROOT, "alias", "builder").model).toBe("claude-opus-4-8");
	});

	test("falls back to the manifest alias when the provider has no model", () => {
		expect(resolveModel(configWith(undefined), ROOT, "manifest-alias", "builder").model).toBe(
			"manifest-alias",
		);
	});
});

/** A config whose active provider is exactly the given provider config. */
function configWithProvider(provider: ProviderConfig): AgentplateConfig {
	const cfg = structuredClone(DEFAULT_CONFIG);
	cfg.activeProvider = "anthropic";
	cfg.providers.anthropic = provider;
	return cfg;
}

const TOKEN_ENV = "AGENTPLATE_RESOLVE_TEST_TOKEN";

describe("resolveModel — auth mode + baseUrl", () => {
	afterEach(() => {
		delete process.env[TOKEN_ENV];
	});

	test("passes a gateway provider's baseUrl through to the resolved model", () => {
		const cfg = configWithProvider({
			type: "gateway",
			authMode: "none",
			baseUrl: "http://localhost:11434",
			model: "llama3",
		});
		const resolved = resolveModel(cfg, ROOT, "alias");
		expect(resolved.baseUrl).toBe("http://localhost:11434");
		expect(resolved.model).toBe("llama3");
	});

	test("omits baseUrl when the provider has none", () => {
		const cfg = configWithProvider({ type: "native", authMode: "none", model: "claude-opus-4-8" });
		expect(resolveModel(cfg, ROOT, "alias").baseUrl).toBeUndefined();
	});

	test('authMode "none" injects no env even when authTokenEnv is set', () => {
		process.env[TOKEN_ENV] = "should-not-be-injected";
		const cfg = configWithProvider({
			type: "gateway",
			authMode: "none",
			authTokenEnv: TOKEN_ENV,
			model: "llama3",
		});
		expect(resolveModel(cfg, ROOT, "alias").env).toEqual({});
	});

	test('authMode "api-key" injects the resolved secret under authTokenEnv', () => {
		process.env[TOKEN_ENV] = "sk-test-value";
		const cfg = configWithProvider({
			type: "native",
			authMode: "api-key",
			authTokenEnv: TOKEN_ENV,
			model: "claude-opus-4-8",
		});
		expect(resolveModel(cfg, ROOT, "alias").env).toEqual({ [TOKEN_ENV]: "sk-test-value" });
	});

	test("the effective authMode is carried on the resolved model", () => {
		for (const authMode of ["none", "api-key", "env", "subscription"] as const) {
			const cfg = configWithProvider({ type: "gateway", authMode, model: "m" });
			expect(resolveModel(cfg, ROOT, "alias").authMode).toBe(authMode);
		}
	});

	test("legacy configs without authMode resolve to api-key (token env) or none", () => {
		const withToken = configWithProvider({ type: "native", authTokenEnv: TOKEN_ENV, model: "m" });
		expect(resolveModel(withToken, ROOT, "alias").authMode).toBe("api-key");
		const keyless = configWithProvider({ type: "native", model: "m" });
		expect(resolveModel(keyless, ROOT, "alias").authMode).toBe("none");
	});
});

describe("resolveModel — non-loopback credential warning", () => {
	afterEach(() => {
		delete process.env[TOKEN_ENV];
	});

	test("warns when a real secret is routed to a non-loopback baseUrl", () => {
		process.env[TOKEN_ENV] = "sk-test-value";
		const cfg = configWithProvider({
			type: "gateway",
			authMode: "api-key",
			authTokenEnv: TOKEN_ENV,
			baseUrl: "https://gw.example.com/v1",
			model: "m",
		});
		const warnings: string[] = [];
		resolveModel(cfg, ROOT, "alias", undefined, (msg) => warnings.push(msg));
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain(TOKEN_ENV);
		expect(warnings[0]).toContain("https://gw.example.com/v1");
		// The credential NAME is logged, never the value.
		expect(warnings[0]).not.toContain("sk-test-value");
	});

	test("does NOT warn for a loopback baseUrl or a keyless provider", () => {
		process.env[TOKEN_ENV] = "sk-test-value";
		const warnings: string[] = [];
		const collect = (msg: string) => warnings.push(msg);
		const loopback = configWithProvider({
			type: "gateway",
			authMode: "api-key",
			authTokenEnv: TOKEN_ENV,
			baseUrl: "http://localhost:11434/v1",
			model: "m",
		});
		resolveModel(loopback, ROOT, "alias", undefined, collect);
		const keyless = configWithProvider({
			type: "gateway",
			authMode: "none",
			baseUrl: "https://gw.example.com",
			model: "m",
		});
		resolveModel(keyless, ROOT, "alias", undefined, collect);
		expect(warnings).toEqual([]);
	});

	test("warns in subscription mode: the CLI's own login goes to the endpoint", () => {
		const cfg = configWithProvider({
			type: "gateway",
			authMode: "subscription",
			baseUrl: "https://attacker.example/v1",
			model: "m",
		});
		const warnings: string[] = [];
		resolveModel(cfg, ROOT, "alias", undefined, (msg) => warnings.push(msg));
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain("will be sent to non-local endpoint https://attacker.example/v1");
	});

	test("warns when the secret is unset: the runtime falls back to its own login", () => {
		const cfg = configWithProvider({
			type: "gateway",
			authMode: "api-key",
			authTokenEnv: TOKEN_ENV, // deliberately not set anywhere
			baseUrl: "https://gw.example.com",
			model: "m",
		});
		const warnings: string[] = [];
		const resolved = resolveModel(cfg, ROOT, "alias", undefined, (msg) => warnings.push(msg));
		expect(resolved.env).toEqual({});
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain(`${TOKEN_ENV} is unset`);
		expect(warnings[0]).toContain("non-local endpoint https://gw.example.com");
	});

	test("no warning for a login going to its own vendor (catalog default endpoints)", () => {
		const warnings: string[] = [];
		const collect = (msg: string) => warnings.push(msg);
		// `codex login` → OpenAI, Claude login → Anthropic, loopback → this machine.
		for (const baseUrl of [
			"https://api.openai.com/v1",
			"https://api.anthropic.com",
			"http://localhost:4000",
		]) {
			const cfg = configWithProvider({
				type: "gateway",
				authMode: "subscription",
				baseUrl,
				model: "m",
			});
			resolveModel(cfg, ROOT, "alias", undefined, collect);
		}
		expect(warnings).toEqual([]);
	});

	test("authTokenEnv is carried on the resolved model only when the credential resolved", () => {
		const cfg = configWithProvider({
			type: "gateway",
			authMode: "env",
			authTokenEnv: TOKEN_ENV,
			model: "m",
		});
		expect(resolveModel(cfg, ROOT, "alias").authTokenEnv).toBeUndefined();
		process.env[TOKEN_ENV] = "tok";
		expect(resolveModel(cfg, ROOT, "alias").authTokenEnv).toBe(TOKEN_ENV);
	});

	test("isLoopbackBaseUrl recognizes loopback hosts and fails safe on junk", () => {
		expect(isLoopbackBaseUrl("http://localhost:11434/v1")).toBe(true);
		expect(isLoopbackBaseUrl("http://127.0.0.1:8080")).toBe(true);
		expect(isLoopbackBaseUrl("http://[::1]:8080")).toBe(true);
		expect(isLoopbackBaseUrl("https://gw.example.com")).toBe(false);
		expect(isLoopbackBaseUrl("http://localhost.evil.com")).toBe(false);
		expect(isLoopbackBaseUrl("not a url")).toBe(false); // unparseable → warn
	});
});
