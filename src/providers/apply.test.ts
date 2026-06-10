import { describe, expect, test } from "bun:test";
import { DEFAULT_CONFIG } from "../config.ts";
import { applyProviderSelection, buildProviderConfig } from "./apply.ts";
import { getProviderSpec } from "./registry.ts";

const anthropic = getProviderSpec("anthropic");
const openrouter = getProviderSpec("openrouter");
const custom = getProviderSpec("custom");
const ollama = getProviderSpec("ollama");

describe("buildProviderConfig", () => {
	test("api-key auth stores the token env var", () => {
		if (!anthropic) throw new Error("anthropic spec missing");
		const cfg = buildProviderConfig(anthropic, "claude-sonnet-4-6", "api-key");
		expect(cfg.type).toBe("native");
		expect(cfg.authMode).toBe("api-key");
		expect(cfg.authTokenEnv).toBe("ANTHROPIC_API_KEY");
		expect(cfg.model).toBe("claude-sonnet-4-6");
		expect(cfg.baseUrl).toBeUndefined();
	});

	test("subscription auth stores NO token env var (delegated to CLI login)", () => {
		if (!anthropic) throw new Error("anthropic spec missing");
		const cfg = buildProviderConfig(anthropic, "claude-opus-4-8", "subscription");
		expect(cfg.authMode).toBe("subscription");
		expect(cfg.authTokenEnv).toBeUndefined();
	});

	test("env auth keeps the token env var (read from environment at run time)", () => {
		if (!anthropic) throw new Error("anthropic spec missing");
		const cfg = buildProviderConfig(anthropic, "claude-opus-4-8", "env");
		expect(cfg.authMode).toBe("env");
		expect(cfg.authTokenEnv).toBe("ANTHROPIC_API_KEY");
	});

	test("gateway provider gets its default baseUrl", () => {
		if (!openrouter) throw new Error("openrouter spec missing");
		const cfg = buildProviderConfig(openrouter, "openai/gpt-4o", "api-key");
		expect(cfg.type).toBe("gateway");
		expect(cfg.baseUrl).toBe("https://openrouter.ai/api/v1");
	});

	test("keyless ollama with authMode none stores the baseUrl and no token env var", () => {
		if (!ollama) throw new Error("ollama spec missing");
		const cfg = buildProviderConfig(ollama, "qwen3-coder:30b", "none");
		expect(cfg.type).toBe("gateway");
		expect(cfg.authMode).toBe("none");
		expect(cfg.authTokenEnv).toBeUndefined();
		expect(cfg.baseUrl).toBe("http://localhost:11434");
	});

	test("custom baseUrl overrides the default", () => {
		if (!custom) throw new Error("custom spec missing");
		const cfg = buildProviderConfig(custom, "my-model", "api-key", "https://my.endpoint/v1");
		expect(cfg.baseUrl).toBe("https://my.endpoint/v1");
	});
});

describe("applyProviderSelection", () => {
	test("registers the provider, marks it active, sets the runtime", () => {
		if (!openrouter) throw new Error("openrouter spec missing");
		const next = applyProviderSelection(DEFAULT_CONFIG, {
			providerId: "openrouter",
			spec: openrouter,
			model: "anthropic/claude-sonnet-4-6",
			authMode: "api-key",
			runtime: "codex",
		});
		expect(next.activeProvider).toBe("openrouter");
		expect(next.providers.openrouter?.model).toBe("anthropic/claude-sonnet-4-6");
		expect(next.providers.openrouter?.authMode).toBe("api-key");
		expect(next.runtime.default).toBe("codex");
	});

	test("subscription selection records authMode without a token env var", () => {
		if (!anthropic) throw new Error("anthropic spec missing");
		const next = applyProviderSelection(DEFAULT_CONFIG, {
			providerId: "anthropic",
			spec: anthropic,
			model: "claude-opus-4-8",
			authMode: "subscription",
			runtime: "claude",
		});
		expect(next.providers.anthropic?.authMode).toBe("subscription");
		expect(next.providers.anthropic?.authTokenEnv).toBeUndefined();
	});

	test("does not mutate the input config", () => {
		if (!anthropic) throw new Error("anthropic spec missing");
		const before = structuredClone(DEFAULT_CONFIG);
		applyProviderSelection(DEFAULT_CONFIG, {
			providerId: "anthropic",
			spec: anthropic,
			model: "claude-opus-4-8",
			authMode: "api-key",
			runtime: "claude",
		});
		expect(DEFAULT_CONFIG).toEqual(before);
	});
});
