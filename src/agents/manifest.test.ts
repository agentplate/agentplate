/**
 * Tests for the agent manifest.
 *
 * Uses a real temp directory and the real JSON round-trip on disk — no mocks,
 * per the project testing philosophy. Each test that touches the filesystem
 * gets its own project root so files are fully isolated.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigError, NotFoundError } from "../errors.ts";
import type { Capability } from "../types.ts";
import {
	buildDefaultManifest,
	getDefinition,
	loadManifest,
	MANIFEST_VERSION,
	writeManifest,
} from "./manifest.ts";

/** The six orchestration-core capabilities the default manifest must define. */
const CORE_CAPABILITIES: readonly Capability[] = [
	"scout",
	"builder",
	"reviewer",
	"lead",
	"merger",
	"coordinator",
];

/** The four delivery-pipeline capabilities (Phase 4) added to the manifest. */
const PIPELINE_CAPABILITIES: readonly Capability[] = [
	"architect",
	"devops",
	"deployer",
	"verifier",
];

/** Every capability the default manifest must define (core + pipeline = ten). */
const ALL_CAPABILITIES: readonly Capability[] = [...CORE_CAPABILITIES, ...PIPELINE_CAPABILITIES];

describe("buildDefaultManifest", () => {
	test("defines exactly the ten capabilities (six core + four pipeline)", () => {
		const manifest = buildDefaultManifest();
		const keys = Object.keys(manifest.agents).sort();
		expect(keys.length).toBe(10);
		expect(keys).toEqual([...ALL_CAPABILITIES].sort());
	});

	test("stamps the current manifest version", () => {
		expect(buildDefaultManifest().version).toBe(MANIFEST_VERSION);
	});

	test("every definition declares the capability it is keyed under", () => {
		const manifest = buildDefaultManifest();
		for (const cap of ALL_CAPABILITIES) {
			const def = manifest.agents[cap];
			expect(def).toBeDefined();
			expect(def?.capabilities).toEqual([cap]);
		}
	});

	test("only lead and coordinator can spawn children", () => {
		const manifest = buildDefaultManifest();
		expect(manifest.agents.lead?.canSpawn).toBe(true);
		expect(manifest.agents.coordinator?.canSpawn).toBe(true);
		expect(manifest.agents.scout?.canSpawn).toBe(false);
		expect(manifest.agents.builder?.canSpawn).toBe(false);
		expect(manifest.agents.reviewer?.canSpawn).toBe(false);
		expect(manifest.agents.merger?.canSpawn).toBe(false);
	});

	test("the four pipeline roles are all leaves (canSpawn=false)", () => {
		const manifest = buildDefaultManifest();
		for (const cap of PIPELINE_CAPABILITIES) {
			expect(manifest.agents[cap]?.canSpawn).toBe(false);
		}
	});

	test("pipeline roles use their <capability>.md base file", () => {
		const manifest = buildDefaultManifest();
		expect(manifest.agents.architect?.file).toBe("architect.md");
		expect(manifest.agents.devops?.file).toBe("devops.md");
		expect(manifest.agents.deployer?.file).toBe("deployer.md");
		expect(manifest.agents.verifier?.file).toBe("verifier.md");
	});

	test("pipeline roles carry the specified model tiers", () => {
		const manifest = buildDefaultManifest();
		// architect/deployer reason about high-stakes plans/deploys → opus.
		expect(manifest.agents.architect?.model).toBe("opus");
		expect(manifest.agents.deployer?.model).toBe("opus");
		// devops/verifier are mechanical/probing → a cheaper tier (sonnet or haiku).
		expect(["sonnet", "haiku"]).toContain(manifest.agents.devops?.model ?? "");
		expect(["sonnet", "haiku"]).toContain(manifest.agents.verifier?.model ?? "");
	});

	test("architect and verifier are read-only (no Edit/Write); devops and deployer are write-capable", () => {
		const manifest = buildDefaultManifest();
		for (const cap of ["architect", "verifier"] as const) {
			const tools = manifest.agents[cap]?.tools ?? [];
			expect(tools).toContain("Read");
			expect(tools).not.toContain("Edit");
			expect(tools).not.toContain("Write");
		}
		for (const cap of ["devops", "deployer"] as const) {
			const tools = manifest.agents[cap]?.tools ?? [];
			expect(tools).toContain("Edit");
			expect(tools).toContain("Write");
		}
	});

	test("assigns the specified model tiers", () => {
		const manifest = buildDefaultManifest();
		expect(manifest.agents.scout?.model).toBe("sonnet");
		expect(manifest.agents.builder?.model).toBe("sonnet");
		expect(manifest.agents.reviewer?.model).toBe("haiku");
		expect(manifest.agents.lead?.model).toBe("opus");
		expect(manifest.agents.merger?.model).toBe("opus");
		expect(manifest.agents.coordinator?.model).toBe("opus");
	});

	test("read-only roles lack Edit and Write", () => {
		const manifest = buildDefaultManifest();
		for (const cap of ["scout", "reviewer"] as const) {
			const tools = manifest.agents[cap]?.tools ?? [];
			expect(tools).toContain("Read");
			expect(tools).toContain("Bash");
			expect(tools).not.toContain("Edit");
			expect(tools).not.toContain("Write");
		}
	});

	test("write-capable roles include Edit and Write", () => {
		const manifest = buildDefaultManifest();
		for (const cap of ["builder", "lead", "merger", "coordinator"] as const) {
			const tools = manifest.agents[cap]?.tools ?? [];
			expect(tools).toContain("Edit");
			expect(tools).toContain("Write");
		}
	});

	test("merger includes Bash and Edit", () => {
		const manifest = buildDefaultManifest();
		const tools = manifest.agents.merger?.tools ?? [];
		expect(tools).toContain("Bash");
		expect(tools).toContain("Edit");
	});

	test("each definition has a <capability>.md file and non-empty constraints", () => {
		const manifest = buildDefaultManifest();
		for (const cap of ALL_CAPABILITIES) {
			const def = manifest.agents[cap];
			expect(def?.file).toBe(`${cap}.md`);
			expect(def?.constraints.length ?? 0).toBeGreaterThan(0);
		}
	});

	test("capabilityIndex maps each capability to a list containing itself", () => {
		const manifest = buildDefaultManifest();
		for (const cap of ALL_CAPABILITIES) {
			expect(manifest.capabilityIndex[cap]).toEqual([cap]);
		}
	});

	test("returns a fresh object each call (no shared mutable state)", () => {
		const a = buildDefaultManifest();
		const b = buildDefaultManifest();
		expect(a).not.toBe(b);
		expect(a.agents).not.toBe(b.agents);
		// Mutating one must not affect the other.
		a.agents.scout?.tools.push("Injected");
		expect(b.agents.scout?.tools).not.toContain("Injected");
	});
});

describe("getDefinition", () => {
	test("returns the definition for a present capability", () => {
		const manifest = buildDefaultManifest();
		const def = getDefinition(manifest, "builder");
		expect(def.file).toBe("builder.md");
		expect(def.canSpawn).toBe(false);
	});

	test("throws NotFoundError for an absent capability", () => {
		// All ten Capability members are defined by default, so delete one first
		// to exercise the lookup-miss branch without fabricating an off-union value.
		const manifest = buildDefaultManifest();
		delete manifest.agents.architect;
		expect(() => getDefinition(manifest, "architect")).toThrow(NotFoundError);
	});
});

describe("writeManifest + loadManifest", () => {
	let root: string;
	let path: string;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "agentplate-manifest-"));
		path = join(root, "agent-manifest.json");
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	test("round-trips the default manifest unchanged", () => {
		const original = buildDefaultManifest();
		writeManifest(path, original);
		const loaded = loadManifest(path);
		expect(loaded).toEqual(original);
	});

	test("writes pretty 2-space JSON with a trailing newline", () => {
		writeManifest(path, buildDefaultManifest());
		const raw = readFileSync(path, "utf8");
		expect(raw.endsWith("\n")).toBe(true);
		// 2-space indent: the top-level "version" key sits two spaces in.
		expect(raw).toContain('\n  "version"');
	});

	test("loadManifest throws NotFoundError when the file is absent", () => {
		expect(() => loadManifest(join(root, "nope.json"))).toThrow(NotFoundError);
	});

	test("loadManifest throws ConfigError on invalid JSON", () => {
		writeFileSync(path, "{ not valid json ");
		expect(() => loadManifest(path)).toThrow(ConfigError);
	});

	test("loadManifest throws ConfigError on a non-object JSON value", () => {
		writeFileSync(path, "[]");
		expect(() => loadManifest(path)).toThrow(ConfigError);
	});

	test("loadManifest throws ConfigError when version is missing", () => {
		writeFileSync(path, JSON.stringify({ agents: {}, capabilityIndex: {} }));
		expect(() => loadManifest(path)).toThrow(ConfigError);
	});

	test("loadManifest throws ConfigError when agents is missing", () => {
		writeFileSync(path, JSON.stringify({ version: "1", capabilityIndex: {} }));
		expect(() => loadManifest(path)).toThrow(ConfigError);
	});

	test("loadManifest throws ConfigError when capabilityIndex is missing", () => {
		writeFileSync(path, JSON.stringify({ version: "1", agents: {} }));
		expect(() => loadManifest(path)).toThrow(ConfigError);
	});

	test("a definition loaded from disk is queryable via getDefinition", () => {
		writeManifest(path, buildDefaultManifest());
		const loaded = loadManifest(path);
		const lead = getDefinition(loaded, "lead");
		expect(lead.canSpawn).toBe(true);
		expect(lead.model).toBe("opus");
	});
});
