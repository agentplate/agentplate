/**
 * Tests for resolveModel — focused on per-capability model tiering. Auth-mode is
 * set to "none" so no secret is read; we assert which model id is chosen.
 */

import { describe, expect, test } from "bun:test";
import { DEFAULT_CONFIG } from "../config.ts";
import type { AgentplateConfig, Capability } from "../types.ts";
import { resolveModel } from "./resolve.ts";

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
