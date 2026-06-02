import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AGENTPLATE_DIR } from "../config.ts";
import { setSecret } from "../secrets.ts";
import type { DeployTargetConfig } from "../types.ts";
import { createDeploySecretStore, missingSecretKeys, resolveTargetSecretEnv } from "./secrets.ts";

let root: string;
/** Env vars to restore after tests that exercise the process.env fallback. */
const SAVED_ENV: Record<string, string | undefined> = {};

function saveEnv(key: string): void {
	if (!(key in SAVED_ENV)) SAVED_ENV[key] = process.env[key];
}

/** Build a minimal DeployTargetConfig with the given secret bindings. */
function targetConfig(secretEnv: DeployTargetConfig["secretEnv"]): DeployTargetConfig {
	return { settings: {}, secretEnv, environments: ["production"] };
}

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "agentplate-deploy-secrets-"));
	// setSecret writes <root>/.agentplate/secrets.local.yaml; the dir must exist.
	mkdirSync(join(root, AGENTPLATE_DIR), { recursive: true });
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
	for (const [key, value] of Object.entries(SAVED_ENV)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
		delete SAVED_ENV[key];
	}
});

describe("createDeploySecretStore", () => {
	test("get/has resolve a value from the file store", () => {
		setSecret(root, "FLY_API_TOKEN", "tok-abc");
		const store = createDeploySecretStore(root);
		expect(store.get("FLY_API_TOKEN")).toBe("tok-abc");
		expect(store.has("FLY_API_TOKEN")).toBe(true);
	});

	test("get returns undefined and has is false for an unknown key", () => {
		const store = createDeploySecretStore(root);
		expect(store.get("NOPE")).toBeUndefined();
		expect(store.has("NOPE")).toBe(false);
	});

	test("falls back to process.env when the file store lacks the key", () => {
		saveEnv("DEPLOY_ENV_ONLY");
		process.env.DEPLOY_ENV_ONLY = "from-env";
		const store = createDeploySecretStore(root);
		expect(store.get("DEPLOY_ENV_ONLY")).toBe("from-env");
		expect(store.has("DEPLOY_ENV_ONLY")).toBe(true);
	});
});

describe("resolveTargetSecretEnv", () => {
	test("maps logical keys to values via fromEnv bindings", () => {
		setSecret(root, "FLY_API_TOKEN", "tok-abc");
		setSecret(root, "REGISTRY_PASSWORD", "pw-123");
		const cfg = targetConfig({
			apiToken: { fromEnv: "FLY_API_TOKEN" },
			registryPassword: { fromEnv: "REGISTRY_PASSWORD" },
		});
		expect(resolveTargetSecretEnv(root, cfg)).toEqual({
			apiToken: "tok-abc",
			registryPassword: "pw-123",
		});
	});

	test("omits bindings whose env var is absent", () => {
		setSecret(root, "PRESENT", "yes");
		const cfg = targetConfig({
			present: { fromEnv: "PRESENT" },
			absent: { fromEnv: "MISSING_ONE" },
		});
		const resolved = resolveTargetSecretEnv(root, cfg);
		expect(resolved).toEqual({ present: "yes" });
		expect("absent" in resolved).toBe(false);
	});

	test("returns an empty map when there are no bindings", () => {
		expect(resolveTargetSecretEnv(root, targetConfig({}))).toEqual({});
	});

	test("resolves a binding from process.env via the union store", () => {
		saveEnv("CI_DEPLOY_TOKEN");
		process.env.CI_DEPLOY_TOKEN = "ci-tok";
		const cfg = targetConfig({ token: { fromEnv: "CI_DEPLOY_TOKEN" } });
		expect(resolveTargetSecretEnv(root, cfg)).toEqual({ token: "ci-tok" });
	});

	test("logical key differs from env-var name (mapping, not pass-through)", () => {
		setSecret(root, "AWS_SECRET_ACCESS_KEY", "secret-val");
		const cfg = targetConfig({ secretKey: { fromEnv: "AWS_SECRET_ACCESS_KEY" } });
		const resolved = resolveTargetSecretEnv(root, cfg);
		expect(resolved.secretKey).toBe("secret-val");
		expect("AWS_SECRET_ACCESS_KEY" in resolved).toBe(false);
	});
});

describe("missingSecretKeys", () => {
	test("reports absent env-var names only", () => {
		setSecret(root, "HAVE_THIS", "v");
		const missing = missingSecretKeys(root, ["HAVE_THIS", "MISSING_A", "MISSING_B"]);
		expect(missing).toEqual(["MISSING_A", "MISSING_B"]);
	});

	test("returns an empty array when every required key is present", () => {
		setSecret(root, "A", "1");
		setSecret(root, "B", "2");
		expect(missingSecretKeys(root, ["A", "B"])).toEqual([]);
	});

	test("counts a process.env-provided key as present", () => {
		saveEnv("ENV_PROVIDED");
		process.env.ENV_PROVIDED = "x";
		setSecret(root, "FILE_PROVIDED", "y");
		expect(missingSecretKeys(root, ["FILE_PROVIDED", "ENV_PROVIDED"])).toEqual([]);
	});

	test("returns an empty array for an empty required list", () => {
		expect(missingSecretKeys(root, [])).toEqual([]);
	});
});
