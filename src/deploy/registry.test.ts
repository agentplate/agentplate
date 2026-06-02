import { describe, expect, test } from "bun:test";
import { DEFAULT_CONFIG } from "../config.ts";
import { ValidationError } from "../errors.ts";
import type { AgentplateConfig } from "../types.ts";
import { getAllDeployTargets, getDeployTarget, getDeployTargetNames } from "./registry.ts";
import { DockerGhaTarget } from "./targets/docker-gha.ts";

// Clone DEFAULT_CONFIG and set deploy.default, so tests never mutate the
// shared default object.
function configWithDefault(target: string): AgentplateConfig {
	const config: AgentplateConfig = structuredClone(DEFAULT_CONFIG);
	config.deploy = { ...config.deploy, default: target };
	return config;
}

describe("getDeployTargetNames", () => {
	test("lists the registered targets in registration order", () => {
		expect(getDeployTargetNames()).toEqual(["docker-gha"]);
	});
});

describe("getAllDeployTargets", () => {
	test("returns one fresh instance per registered target", () => {
		const all = getAllDeployTargets();
		expect(all).toHaveLength(1);
		expect(all[0]).toBeInstanceOf(DockerGhaTarget);
	});

	test("returns distinct instances across calls (no shared mutable state)", () => {
		const first = getAllDeployTargets()[0];
		const second = getAllDeployTargets()[0];
		expect(first).not.toBe(second);
	});
});

describe("getDeployTarget", () => {
	test("resolves docker-gha by explicit name", () => {
		const target = getDeployTarget("docker-gha");
		expect(target).toBeInstanceOf(DockerGhaTarget);
		expect(target.id).toBe("docker-gha");
	});

	test("returns a fresh instance on each call", () => {
		expect(getDeployTarget("docker-gha")).not.toBe(getDeployTarget("docker-gha"));
	});

	test("resolves from config.deploy.default when no name is given", () => {
		const target = getDeployTarget(undefined, configWithDefault("docker-gha"));
		expect(target).toBeInstanceOf(DockerGhaTarget);
		expect(target.id).toBe("docker-gha");
	});

	test("an explicit name takes precedence over config.deploy.default", () => {
		// Default is an unknown target, but the explicit valid name wins, so this
		// must resolve rather than throw.
		const target = getDeployTarget("docker-gha", configWithDefault("vercel"));
		expect(target).toBeInstanceOf(DockerGhaTarget);
	});

	test("throws ValidationError listing names when no name and no default are set", () => {
		// DEFAULT_CONFIG.deploy.default is "" → treated as unset.
		expect(() => getDeployTarget(undefined, structuredClone(DEFAULT_CONFIG))).toThrow(
			ValidationError,
		);
		try {
			getDeployTarget(undefined, structuredClone(DEFAULT_CONFIG));
			throw new Error("expected getDeployTarget to throw");
		} catch (error) {
			expect(error).toBeInstanceOf(ValidationError);
			expect((error as ValidationError).message).toContain("docker-gha");
		}
	});

	test("throws ValidationError when called with no name and no config at all", () => {
		expect(() => getDeployTarget()).toThrow(ValidationError);
	});

	test("throws ValidationError listing names on an unknown explicit name", () => {
		expect(() => getDeployTarget("nope")).toThrow(ValidationError);
		try {
			getDeployTarget("nope");
			throw new Error("expected getDeployTarget to throw");
		} catch (error) {
			expect(error).toBeInstanceOf(ValidationError);
			expect((error as ValidationError).message).toContain("nope");
			expect((error as ValidationError).message).toContain("docker-gha");
		}
	});

	test("throws ValidationError on an unknown config default with no explicit name", () => {
		expect(() => getDeployTarget(undefined, configWithDefault("bogus-target"))).toThrow(
			ValidationError,
		);
		try {
			getDeployTarget(undefined, configWithDefault("bogus-target"));
			throw new Error("expected getDeployTarget to throw");
		} catch (error) {
			expect((error as ValidationError).message).toContain("bogus-target");
		}
	});
});
