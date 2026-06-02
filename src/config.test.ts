import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	DEFAULT_CONFIG,
	isInitialized,
	loadConfig,
	serializeConfig,
	setProjectRootOverride,
	validateConfig,
} from "./config.ts";

let root: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "agentplate-cfg-"));
	mkdirSync(join(root, ".agentplate"), { recursive: true });
});

afterEach(() => {
	setProjectRootOverride(null);
	rmSync(root, { recursive: true, force: true });
});

function writeConfig(dir: string, file: string, contents: string): void {
	writeFileSync(join(dir, ".agentplate", file), contents, "utf8");
}

describe("loadConfig", () => {
	test("returns defaults when only an empty config.yaml exists", () => {
		writeConfig(root, "config.yaml", "");
		const cfg = loadConfig(root);
		expect(cfg.runtime.default).toBe(DEFAULT_CONFIG.runtime.default);
		expect(cfg.project.root).toBe(root);
		expect(cfg.agents.maxDepth).toBe(2);
	});

	test("merges config.yaml over defaults", () => {
		writeConfig(root, "config.yaml", "project:\n  name: my-app\nruntime:\n  default: codex\n");
		const cfg = loadConfig(root);
		expect(cfg.project.name).toBe("my-app");
		expect(cfg.runtime.default).toBe("codex");
		// Untouched defaults remain.
		expect(cfg.merge.aiResolveEnabled).toBe(true);
	});

	test("config.local.yaml overrides config.yaml", () => {
		writeConfig(root, "config.yaml", "runtime:\n  default: claude\n");
		writeConfig(root, "config.local.yaml", "runtime:\n  default: gemini\n");
		const cfg = loadConfig(root);
		expect(cfg.runtime.default).toBe("gemini");
	});

	test("throws ConfigError on invalid YAML", () => {
		writeConfig(root, "config.yaml", "project:\n  name: [unclosed\n");
		expect(() => loadConfig(root)).toThrow();
	});
});

describe("validateConfig", () => {
	test("rejects negative maxDepth", () => {
		const cfg = structuredClone(DEFAULT_CONFIG);
		cfg.agents.maxDepth = -1;
		expect(() => validateConfig(cfg)).toThrow();
	});

	test("rejects maxConcurrent below 1", () => {
		const cfg = structuredClone(DEFAULT_CONFIG);
		cfg.agents.maxConcurrent = 0;
		expect(() => validateConfig(cfg)).toThrow();
	});

	test("accepts the defaults", () => {
		expect(() => validateConfig(structuredClone(DEFAULT_CONFIG))).not.toThrow();
	});
});

describe("isInitialized / serializeConfig", () => {
	test("isInitialized reflects presence of config.yaml", () => {
		expect(isInitialized(root)).toBe(false);
		writeConfig(root, "config.yaml", "");
		expect(isInitialized(root)).toBe(true);
	});

	test("serializeConfig round-trips through loadConfig", () => {
		const yamlText = serializeConfig(DEFAULT_CONFIG);
		writeConfig(root, "config.yaml", yamlText);
		const cfg = loadConfig(root);
		expect(cfg.runtime.default).toBe(DEFAULT_CONFIG.runtime.default);
	});
});
