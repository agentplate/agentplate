import { describe, expect, test } from "bun:test";
import {
	getProviderSpec,
	listProviders,
	MIN_CONTEXT_TOKENS,
	meetsContextFloor,
	PROVIDERS,
} from "./registry.ts";

describe("provider registry", () => {
	test("getProviderSpec finds known providers", () => {
		expect(getProviderSpec("anthropic")?.label).toBe("Anthropic");
		expect(getProviderSpec("openrouter")?.kind).toBe("gateway");
	});

	test("getProviderSpec returns undefined for unknown", () => {
		expect(getProviderSpec("nope")).toBeUndefined();
	});

	test("catalog includes the expected providers", () => {
		const ids = listProviders().map((p) => p.id);
		expect(ids).toContain("anthropic");
		expect(ids).toContain("openai");
		expect(ids).toContain("ollama");
		expect(ids).toContain("custom");
		expect(ids).toContain("opencode-zen");
	});

	test("CLI-login providers offer subscription via their runtime", () => {
		// Each maps to a coding-agent CLI whose own login (OAuth/keys) is reused.
		const cases: Array<[string, string]> = [
			["anthropic", "claude"],
			["openai", "codex"],
			["google", "gemini"],
			["opencode-zen", "opencode"],
		];
		for (const [id, runtime] of cases) {
			const spec = getProviderSpec(id);
			expect(spec?.supportsSubscription).toBe(true);
			expect(spec?.subscriptionRuntime).toBe(runtime);
		}
	});

	test("every provider declares an auth env var", () => {
		for (const spec of PROVIDERS) {
			expect(spec.authEnvVar.length).toBeGreaterThan(0);
		}
	});

	test("custom provider requires a base URL and has no preset models", () => {
		const custom = getProviderSpec("custom");
		expect(custom?.requiresBaseUrl).toBe(true);
		expect(custom?.models.length).toBe(0);
	});

	test("ollama is keyless", () => {
		expect(getProviderSpec("ollama")?.keyless).toBe(true);
	});

	test("ollama base URL is the server root (no /v1 — runtimes append API paths)", () => {
		const ollama = getProviderSpec("ollama");
		expect(ollama?.defaultBaseUrl).toBe("http://localhost:11434");
		expect(ollama?.defaultBaseUrl?.endsWith("/v1")).toBe(false);
	});

	test("ollama leads with a tool-capable coding model", () => {
		const models = getProviderSpec("ollama")?.models ?? [];
		expect(models[0]?.id).toBe("qwen3-coder:30b");
		expect(models[0]?.contextWindow).toBe(262_144);
		const ids = models.map((m) => m.id);
		expect(ids).toContain("qwen2.5-coder:32b");
		expect(ids).toContain("llama3.3:70b");
	});

	test("meetsContextFloor enforces the minimum", () => {
		expect(meetsContextFloor({ id: "a", label: "A", contextWindow: MIN_CONTEXT_TOKENS })).toBe(
			true,
		);
		expect(meetsContextFloor({ id: "b", label: "B", contextWindow: 8000 })).toBe(false);
	});

	test("all preset models meet the context floor", () => {
		for (const spec of PROVIDERS) {
			for (const model of spec.models) {
				expect(model.contextWindow).toBeGreaterThanOrEqual(MIN_CONTEXT_TOKENS);
			}
		}
	});
});
