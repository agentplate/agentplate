import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG, serializeConfig, setProjectRootOverride } from "../config.ts";
import { setSecret } from "../secrets.ts";
import { createDoctorCommand } from "./doctor.ts";

let root: string;

/** Run a doctor subcommand and capture its JSON stdout (unwrapping the envelope). */
async function runDoctorJson(args: string[]): Promise<{ ok: boolean; checks: Check[] }> {
	const original = process.stdout.write.bind(process.stdout);
	let buffer = "";
	process.stdout.write = ((chunk: unknown): boolean => {
		buffer += typeof chunk === "string" ? chunk : String(chunk);
		return true;
	}) as typeof process.stdout.write;
	try {
		const program = createDoctorCommand();
		program.exitOverride();
		await program.parseAsync(["node", "doctor", ...args, "--json"]);
	} finally {
		process.stdout.write = original;
	}
	// jsonOutput wraps payloads as { ok: true, data: <payload> }.
	const envelope = JSON.parse(buffer) as { ok: boolean; data: { ok: boolean; checks: Check[] } };
	return envelope.data;
}

interface Check {
	category: string;
	name: string;
	ok: boolean;
	detail: string;
}

function initProject(deployTarget?: string, providerBaseUrl?: string): void {
	mkdirSync(join(root, ".agentplate"), { recursive: true });
	const config = structuredClone(DEFAULT_CONFIG);
	config.project.name = "doctor-test";
	config.project.root = root;
	if (providerBaseUrl) {
		const provider = config.providers[config.activeProvider];
		if (provider) provider.baseUrl = providerBaseUrl;
	}
	if (deployTarget) {
		config.deploy.default = deployTarget;
		config.deploy.targets[deployTarget] = {
			settings: { registry: "ghcr.io/acme" },
			secretEnv: { GHCR_TOKEN: { fromEnv: "GHCR_TOKEN" } },
			environments: ["preview", "production"],
		};
	}
	writeFileSync(join(root, ".agentplate", "config.yaml"), serializeConfig(config), "utf8");
}

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "agentplate-doctor-"));
	setProjectRootOverride(root);
});

afterEach(() => {
	setProjectRootOverride(null);
	rmSync(root, { recursive: true, force: true });
	delete process.env.GHCR_TOKEN;
});

describe("doctor providers category", () => {
	test("reports missing credentials before a key is set", async () => {
		initProject();
		const result = await runDoctorJson(["--category", "providers"]);
		const creds = result.checks.find((c) => c.name === "credentials");
		expect(creds?.ok).toBe(false);
	});

	test("flips to ok once the provider key is present", async () => {
		initProject();
		setSecret(root, "ANTHROPIC_API_KEY", "sk-ant-doctor-test-value");
		const result = await runDoctorJson(["--category", "providers"]);
		const creds = result.checks.find((c) => c.name === "credentials");
		expect(creds?.ok).toBe(true);
	});
});

describe("doctor provider endpoint check", () => {
	test("endpoint is ok when the base URL responds (any HTTP status)", async () => {
		const server = Bun.serve({
			port: 0,
			fetch: () => new Response("not found", { status: 404 }),
		});
		try {
			initProject(undefined, `http://127.0.0.1:${server.port}`);
			const result = await runDoctorJson(["--category", "providers"]);
			const endpoint = result.checks.find((c) => c.name === "endpoint");
			expect(endpoint).toBeDefined();
			expect(endpoint?.ok).toBe(true);
			expect(endpoint?.detail).toContain("reachable (HTTP 404)");
		} finally {
			server.stop(true);
		}
	});

	test("endpoint fails when nothing is listening on the base URL", async () => {
		initProject(undefined, "http://127.0.0.1:1");
		const result = await runDoctorJson(["--category", "providers"]);
		const endpoint = result.checks.find((c) => c.name === "endpoint");
		expect(endpoint).toBeDefined();
		expect(endpoint?.ok).toBe(false);
		expect(endpoint?.detail).toContain("unreachable");
		expect(endpoint?.detail).toContain("ollama serve");
	});

	test("unreachable non-loopback endpoint omits the ollama hint", async () => {
		// `.invalid` never resolves (RFC 2606), so the probe fails fast.
		initProject(undefined, "http://agentplate-doctor.invalid:1");
		const result = await runDoctorJson(["--category", "providers"]);
		const endpoint = result.checks.find((c) => c.name === "endpoint");
		expect(endpoint).toBeDefined();
		expect(endpoint?.ok).toBe(false);
		expect(endpoint?.detail).toContain("is the server running?");
		expect(endpoint?.detail).not.toContain("ollama serve");
	});

	test("no endpoint check is emitted when the provider has no baseUrl", async () => {
		initProject();
		const result = await runDoctorJson(["--category", "providers"]);
		expect(result.checks.find((c) => c.name === "endpoint")).toBeUndefined();
	});
});

describe("doctor plaintext transport warning", () => {
	test("warns (ok: true) when the baseUrl is http to a non-loopback host", async () => {
		initProject(undefined, "http://agentplate-doctor.invalid:1");
		const result = await runDoctorJson(["--category", "providers"]);
		const transport = result.checks.find((c) => c.name === "transport");
		expect(transport).toBeDefined();
		expect(transport?.ok).toBe(true);
		expect(transport?.detail).toContain("warning:");
		expect(transport?.detail).toContain("unencrypted");
	});

	test("no transport warning for a loopback http baseUrl", async () => {
		initProject(undefined, "http://127.0.0.1:1");
		const result = await runDoctorJson(["--category", "providers"]);
		expect(result.checks.find((c) => c.name === "transport")).toBeUndefined();
	});

	test("no transport warning for an https baseUrl", async () => {
		initProject(undefined, "https://agentplate-doctor.invalid:1");
		const result = await runDoctorJson(["--category", "providers"]);
		expect(result.checks.find((c) => c.name === "transport")).toBeUndefined();
	});
});

describe("doctor deploy category", () => {
	test("reports a configured target with missing secrets", async () => {
		initProject("docker-gha");
		const result = await runDoctorJson(["--category", "deploy"]);
		const target = result.checks.find((c) => c.name === "target docker-gha");
		expect(target).toBeDefined();
		expect(target?.ok).toBe(false);
		expect(target?.detail).toContain("GHCR_TOKEN");
	});

	test("target is ok once its secret is present", async () => {
		initProject("docker-gha");
		setSecret(root, "GHCR_TOKEN", "ghp_doctor_test_token_value_1234");
		const result = await runDoctorJson(["--category", "deploy"]);
		const target = result.checks.find((c) => c.name === "target docker-gha");
		expect(target?.ok).toBe(true);
	});

	test("default target check reflects config", async () => {
		initProject("docker-gha");
		const result = await runDoctorJson(["--category", "deploy"]);
		const def = result.checks.find((c) => c.name === "default target");
		expect(def?.detail).toBe("docker-gha");
	});
});
