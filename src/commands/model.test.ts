/**
 * `ap setup` / `ap model` persistence: only the committed layer (defaults ←
 * config.yaml) plus the wizard's changes reach config.yaml — never values from the
 * gitignored config.local.yaml or the absolute project root. Real temp dirs.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import yaml from "js-yaml";
import {
	AGENTPLATE_DIR,
	CONFIG_FILE,
	CONFIG_LOCAL_FILE,
	DEFAULT_CONFIG,
	loadCommittedConfig,
	loadConfig,
	serializeConfig,
} from "../config.ts";
import { applyProviderSelection } from "../providers/apply.ts";
import { getProviderSpec } from "../providers/registry.ts";
import type { AgentplateConfig } from "../types.ts";
import { buildPersistedConfig, persistWizardConfig } from "./model.ts";

const PRIVATE_URL = `https://alice:${"hunter"}2@gw.internal/v1`;

let root: string;

function readCommitted(): Record<string, unknown> {
	return yaml.load(readFileSync(join(root, AGENTPLATE_DIR, CONFIG_FILE), "utf8")) as Record<
		string,
		unknown
	>;
}

/** Stand-in for the interactive wizard: switch the anthropic model. */
function wizardSwitchModel(current: AgentplateConfig, model: string): AgentplateConfig {
	const spec = getProviderSpec("anthropic");
	if (!spec) throw new Error("anthropic spec missing");
	return applyProviderSelection(current, {
		providerId: "anthropic",
		spec,
		model,
		authMode: "api-key",
		runtime: current.runtime.default,
	});
}

beforeEach(() => {
	root = realpathSync(mkdtempSync(join(tmpdir(), "ap-model-")));
	mkdirSync(join(root, AGENTPLATE_DIR), { recursive: true });
	const committed = structuredClone(DEFAULT_CONFIG);
	committed.project.name = "demo";
	writeFileSync(join(root, AGENTPLATE_DIR, CONFIG_FILE), serializeConfig(committed), "utf8");
	writeFileSync(
		join(root, AGENTPLATE_DIR, CONFIG_LOCAL_FILE),
		yaml.dump({
			providers: { custom: { type: "gateway", baseUrl: PRIVATE_URL, model: "x" } },
			agents: { maxConcurrent: 3 },
		}),
		"utf8",
	);
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

describe("persistWizardConfig", () => {
	test("never copies config.local.yaml overrides or project.root into config.yaml", () => {
		const shown = loadConfig(root);
		// Sanity: the merged view the wizard sees does include the local layer.
		expect(shown.providers.custom?.baseUrl).toBe(PRIVATE_URL);
		expect(shown.project.root).toBe(root);

		persistWizardConfig(root, shown, wizardSwitchModel(shown, "claude-sonnet-x"));

		const raw = readFileSync(join(root, AGENTPLATE_DIR, CONFIG_FILE), "utf8");
		expect(raw).not.toContain("gw.internal");
		expect(raw).not.toContain(root);
		const committed = readCommitted() as {
			providers: Record<string, { model?: string }>;
			agents: { maxConcurrent: number };
			project: { name: string; root?: string };
		};
		expect(committed.providers.custom).toBeUndefined();
		expect(committed.agents.maxConcurrent).toBe(DEFAULT_CONFIG.agents.maxConcurrent);
		expect(committed.project.root ?? "").toBe("");
		expect(committed.project.name).toBe("demo");
		// The user's actual change is persisted…
		expect(committed.providers.anthropic?.model).toBe("claude-sonnet-x");
		// …and the effective (merged) config still carries the local overrides.
		const after = loadConfig(root);
		expect(after.providers.anthropic?.model).toBe("claude-sonnet-x");
		expect(after.providers.custom?.baseUrl).toBe(PRIVATE_URL);
		expect(after.agents.maxConcurrent).toBe(3);
	});

	test("an override the user changes in the wizard is written to config.yaml", () => {
		const shown = loadConfig(root);
		const result = structuredClone(shown);
		result.agents.maxConcurrent = 7;
		const persisted = buildPersistedConfig(loadCommittedConfig(root), shown, result);
		expect(persisted.agents.maxConcurrent).toBe(7);
		expect(persisted.providers.custom).toBeUndefined();
	});

	test("keys the wizard dropped are removed (e.g. authTokenEnv on subscription auth)", () => {
		const shown = loadConfig(root);
		const spec = getProviderSpec("anthropic");
		if (!spec) throw new Error("anthropic spec missing");
		const result = applyProviderSelection(shown, {
			providerId: "anthropic",
			spec,
			model: "m",
			authMode: "subscription",
			runtime: "claude",
		});
		const persisted = buildPersistedConfig(loadCommittedConfig(root), shown, result);
		expect(persisted.providers.anthropic?.authTokenEnv).toBeUndefined();
		expect(persisted.providers.anthropic?.authMode).toBe("subscription");
	});

	test("first-time setup (no config.yaml yet) writes no absolute root", () => {
		rmSync(join(root, AGENTPLATE_DIR, CONFIG_FILE));
		const initial = structuredClone(DEFAULT_CONFIG);
		initial.project.root = root;
		persistWizardConfig(root, initial, wizardSwitchModel(initial, "m1"));
		const raw = readFileSync(join(root, AGENTPLATE_DIR, CONFIG_FILE), "utf8");
		expect(raw).not.toContain(root);
		expect(loadConfig(root).providers.anthropic?.model).toBe("m1");
	});
});
