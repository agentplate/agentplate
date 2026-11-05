import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG, serializeConfig, setProjectRootOverride } from "../config.ts";
import { createShipCommand, runShip } from "./ship.ts";

let root: string;

/** Stand up a minimal initialized project with a Node app and docker-gha default. */
function initProject(): void {
	mkdirSync(join(root, ".agentplate"), { recursive: true });
	const config = structuredClone(DEFAULT_CONFIG);
	config.project.name = "ship-test";
	config.project.root = root;
	config.deploy.default = "docker-gha";
	config.deploy.gates = { preview: "auto", production: "confirm", staging: "auto" };
	writeFileSync(join(root, ".agentplate", "config.yaml"), serializeConfig(config), "utf8");
	writeFileSync(
		join(root, "package.json"),
		JSON.stringify(
			{ name: "demo", scripts: { build: "echo build", start: "echo start" } },
			null,
			2,
		),
		"utf8",
	);
}

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "agentplate-ship-"));
	setProjectRootOverride(root);
	initProject();
});

afterEach(() => {
	setProjectRootOverride(null);
	rmSync(root, { recursive: true, force: true });
});

describe("createShipCommand", () => {
	test("builds without throwing and exposes options", () => {
		const cmd = createShipCommand();
		expect(cmd.name()).toBe("ship");
		const flags = cmd.options.map((o) => o.long);
		expect(flags).toContain("--target");
		expect(flags).toContain("--dry-run");
		expect(flags).toContain("--no-build");
	});
});

describe("runShip (dry-run)", () => {
	test("plans a deploy without mutation and without writing artifacts", async () => {
		const result = await runShip(root, "a tiny web app", {
			target: "docker-gha",
			env: "preview",
			dryRun: true,
			yes: false,
			build: true,
		});
		expect(result.target).toBe("docker-gha");
		expect(result.dryRun).toBe(true);
		// Build stages are listed but were not run; deploy planned, verify skipped.
		const names = result.stages.map((s) => s.name);
		expect(names).toContain("architect");
		expect(names).toContain("deploy");
		const deployStage = result.stages.find((s) => s.name === "deploy");
		expect(deployStage?.status).toBe("ok");
		// A dry-run records a dryRun audit row, never a success deploy.
		expect(result.deploy?.dryRun).toBe(true);
		// docker-gha generateConfig planned a Dockerfile, but a dry run writes nothing.
		expect(result.deploy?.artifacts.some((a) => a.path === "Dockerfile")).toBe(true);
		expect(existsSync(join(root, "Dockerfile"))).toBe(false);
		expect(existsSync(join(root, ".github", "workflows", "deploy.yml"))).toBe(false);
		// No real deployment URL in dry-run.
		expect(result.urls).toEqual([]);
	});

	test("never reports build stages it did not run as ok", async () => {
		const result = await runShip(root, "a URL shortener", {
			target: "docker-gha",
			env: "preview",
			dryRun: true,
			yes: false,
			build: true,
		});
		// ship spawns no architect/builder/devops agent, so each is honestly skipped.
		for (const name of ["architect", "builder", "devops"]) {
			const stage = result.stages.find((s) => s.name === name);
			expect(stage?.status).toBe("skipped");
			expect(stage?.detail).toContain("agentplate sling");
		}
		// Only the deploy stage (which really ran, as a plan) is ok.
		const ok = result.stages.filter((s) => s.status === "ok").map((s) => s.name);
		expect(ok).toEqual(["deploy"]);
	});

	test("--json reports the build stages as skipped", async () => {
		let out = "";
		const original = process.stdout.write.bind(process.stdout);
		process.stdout.write = (chunk: string | Uint8Array): boolean => {
			out += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
			return true;
		};
		try {
			await createShipCommand().parseAsync(
				["a URL shortener", "--target", "docker-gha", "--dry-run", "--json"],
				{ from: "user" },
			);
		} finally {
			process.stdout.write = original;
		}
		const envelope = JSON.parse(out) as {
			data: { stages: Array<{ name: string; status: string }> };
		};
		const statuses = Object.fromEntries(envelope.data.stages.map((s) => [s.name, s.status]));
		expect(statuses).toMatchObject({
			architect: "skipped",
			builder: "skipped",
			devops: "skipped",
			deploy: "ok",
		});
	});

	test("--no-build skips build stages", async () => {
		const result = await runShip(root, "current tree", {
			target: "docker-gha",
			env: "preview",
			dryRun: true,
			yes: false,
			build: false,
		});
		const names = result.stages.map((s) => s.name);
		expect(names).toContain("build");
		expect(names).not.toContain("architect");
	});
});

describe("runShip (gate)", () => {
	test("production gate refuses a real deploy without --yes", async () => {
		const result = await runShip(root, "prod app", {
			target: "docker-gha",
			env: "production",
			dryRun: false,
			yes: false,
			build: false,
		});
		expect(result.deploy?.refused).toBe(true);
		expect(result.deploy?.gateDecision).toBe("denied");
		const deployStage = result.stages.find((s) => s.name === "deploy");
		expect(deployStage?.status).toBe("refused");
	});
});
