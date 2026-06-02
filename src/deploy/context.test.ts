import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AGENTPLATE_DIR, DEFAULT_CONFIG } from "../config.ts";
import { SECRETS_FILE } from "../secrets.ts";
import type { AgentplateConfig, DeployConfig } from "../types.ts";
import { buildDeployContext } from "./context.ts";
import type {
	AppProfile,
	DeployContext,
	DeployResult,
	DeploySecretStore,
	DeployTarget,
	DetectResult,
	GeneratedConfig,
	VerifyResult,
} from "./types.ts";

// A minimal, neutral app profile — context never inspects its contents, it just
// carries it through, so the exact shape only needs to satisfy the type.
function profile(): AppProfile {
	return {
		language: "bun",
		framework: null,
		kind: "service",
		buildCommand: null,
		startCommand: "bun start",
		port: 3000,
		packageManager: "bun.lock",
		runtimeEnvKeys: [],
	};
}

// Test-local DeployTarget implementing the interface directly (the canonical
// Agentplate test style — no module mocks). `buildSecretEnv` is parameterized so a
// single fake can model both "needs a secret" and "needs none". Every other
// method is a stub that throws if ever called: buildDeployContext must touch
// only `id` and `buildSecretEnv`.
function fakeTarget(
	id: string,
	build: (store: DeploySecretStore) => Record<string, string>,
): DeployTarget {
	const unreached = (m: string) => (): never => {
		throw new Error(`fakeTarget.${m} should not be called by buildDeployContext`);
	};
	return {
		id,
		stability: "stable",
		label: "Fake",
		description: "test target",
		caps: {
			canRollback: true,
			irreversible: false,
			environments: ["staging"],
			requiresCredentials: false,
		},
		detect: unreached("detect") as () => Promise<DetectResult>,
		generateConfig: unreached("generateConfig") as () => Promise<GeneratedConfig>,
		deploy: unreached("deploy") as () => Promise<DeployResult>,
		verify: unreached("verify") as () => Promise<VerifyResult>,
		rollback: unreached("rollback") as () => Promise<DeployResult>,
		buildSecretEnv: build,
	};
}

// Clone DEFAULT_CONFIG and layer in deploy settings for one target id.
function configWith(root: string, deploy: Partial<DeployConfig>): AgentplateConfig {
	const base: AgentplateConfig = structuredClone(DEFAULT_CONFIG);
	base.project.root = root;
	base.deploy = { ...base.deploy, ...deploy };
	return base;
}

describe("buildDeployContext", () => {
	let root: string;

	beforeEach(async () => {
		root = await mkdtemp(join(tmpdir(), "agentplate-ctx-"));
		// Ensure .agentplate exists so the secret store can read the file there.
		await mkdir(join(root, AGENTPLATE_DIR), { recursive: true });
	});

	afterEach(async () => {
		await rm(root, { recursive: true, force: true });
	});

	function baseArgs(
		target: DeployTarget,
		config: AgentplateConfig,
	): Parameters<typeof buildDeployContext>[0] {
		return {
			root,
			worktreePath: join(root, "wt"),
			target,
			environment: "staging",
			profile: profile(),
			dryRun: false,
			runId: "run-123",
			agentName: "deployer-1",
			config,
		};
	}

	test("populates settings, environment, dryRun, and identity fields", () => {
		const target = fakeTarget("docker-gha", () => ({}));
		const config = configWith(root, {
			default: "docker-gha",
			targets: {
				"docker-gha": {
					settings: { region: "us-east-1", replicas: 2, public: true },
					secretEnv: {},
					environments: ["staging", "production"],
				},
			},
		});

		const ctx: DeployContext = buildDeployContext({
			...baseArgs(target, config),
			environment: "production",
			dryRun: true,
		});

		expect(ctx.target).toBe("docker-gha");
		expect(ctx.environment).toBe("production");
		expect(ctx.dryRun).toBe(true);
		expect(ctx.projectRoot).toBe(root);
		expect(ctx.worktreePath).toBe(join(root, "wt"));
		expect(ctx.runId).toBe("run-123");
		expect(ctx.agentName).toBe("deployer-1");
		// Non-secret settings come straight from config for this target id.
		expect(ctx.settings).toEqual({ region: "us-east-1", replicas: 2, public: true });
	});

	test("settings default to an empty object when the target has no config entry", () => {
		const target = fakeTarget("docker-gha", () => ({}));
		// config.deploy.targets is empty → no entry for "docker-gha".
		const config = configWith(root, { default: "docker-gha", targets: {} });

		const ctx = buildDeployContext(baseArgs(target, config));

		expect(ctx.settings).toEqual({});
		expect(ctx.target).toBe("docker-gha");
	});

	test("keys settings by the target's own id, not the config default", () => {
		const target = fakeTarget("docker-gha", () => ({}));
		// A different target ("vercel") is the config default and has settings, but
		// the passed target is "docker-gha" → its (absent) settings win → {}.
		const config = configWith(root, {
			default: "vercel",
			targets: {
				vercel: { settings: { region: "iad1" }, secretEnv: {}, environments: ["production"] },
			},
		});

		const ctx = buildDeployContext(baseArgs(target, config));

		expect(ctx.settings).toEqual({});
	});

	test("secretEnv is empty when the target requests no secrets", () => {
		const target = fakeTarget("docker-gha", () => ({}));
		const config = configWith(root, { default: "docker-gha", targets: {} });

		const ctx = buildDeployContext(baseArgs(target, config));

		expect(ctx.secretEnv).toEqual({});
	});

	test("secretEnv is empty when a requested secret is absent from file and env", () => {
		// Target asks for REGISTRY_TOKEN, but neither the secrets file nor env has
		// it → store.has is false → the target maps nothing.
		const KEY = "AGENTPLATE_TEST_ABSENT_TOKEN_XYZ";
		delete process.env[KEY];
		const target = fakeTarget("docker-gha", (store) => {
			const env: Record<string, string> = {};
			if (store.has(KEY)) env[KEY] = store.get(KEY) ?? "";
			return env;
		});
		const config = configWith(root, { default: "docker-gha", targets: {} });

		const ctx = buildDeployContext(baseArgs(target, config));

		expect(ctx.secretEnv).toEqual({});
	});

	test("secretEnv resolves a value the target asks for from the secrets file", async () => {
		// Write a real gitignored secrets file; the store reads file-then-env.
		const KEY = "REGISTRY_TOKEN";
		await writeFile(join(root, AGENTPLATE_DIR, SECRETS_FILE), `${KEY}: tok-from-file\n`);
		const target = fakeTarget("docker-gha", (store) => {
			const v = store.get(KEY);
			const env: Record<string, string> = {};
			if (v !== undefined) env[KEY] = v;
			return env;
		});
		const config = configWith(root, { default: "docker-gha", targets: {} });

		const ctx = buildDeployContext(baseArgs(target, config));

		expect(ctx.secretEnv).toEqual({ REGISTRY_TOKEN: "tok-from-file" });
	});

	test("secretEnv resolves a value from process.env when no file entry exists", () => {
		const KEY = "AGENTPLATE_TEST_ENV_ONLY_TOKEN";
		process.env[KEY] = "tok-from-env";
		try {
			const target = fakeTarget("docker-gha", (store) => {
				const v = store.get(KEY);
				const env: Record<string, string> = {};
				if (v !== undefined) env[KEY] = v;
				return env;
			});
			const config = configWith(root, { default: "docker-gha", targets: {} });

			const ctx = buildDeployContext(baseArgs(target, config));

			expect(ctx.secretEnv).toEqual({ [KEY]: "tok-from-env" });
		} finally {
			delete process.env[KEY];
		}
	});

	test("profile is carried through unchanged", () => {
		const p = profile();
		const target = fakeTarget("docker-gha", () => ({}));
		const config = configWith(root, { default: "docker-gha", targets: {} });

		const ctx = buildDeployContext({ ...baseArgs(target, config), profile: p });

		expect(ctx.profile).toBe(p);
	});

	test("runId may be null", () => {
		const target = fakeTarget("docker-gha", () => ({}));
		const config = configWith(root, { default: "docker-gha", targets: {} });

		const ctx = buildDeployContext({ ...baseArgs(target, config), runId: null });

		expect(ctx.runId).toBeNull();
	});
});
