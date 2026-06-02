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
	test("plans a deploy without mutation and writes artifacts", async () => {
		const result = await runShip(root, "a tiny web app", {
			target: "docker-gha",
			env: "preview",
			dryRun: true,
			yes: false,
			build: true,
		});
		expect(result.target).toBe("docker-gha");
		expect(result.dryRun).toBe(true);
		// Build stages ran (architect/builder/devops), deploy planned, verify skipped.
		const names = result.stages.map((s) => s.name);
		expect(names).toContain("architect");
		expect(names).toContain("deploy");
		const deployStage = result.stages.find((s) => s.name === "deploy");
		expect(deployStage?.status).toBe("ok");
		// A dry-run records a dryRun audit row, never a success deploy.
		expect(result.deploy?.dryRun).toBe(true);
		// docker-gha generateConfig wrote a Dockerfile to the project root.
		expect(existsSync(join(root, "Dockerfile"))).toBe(true);
		expect(existsSync(join(root, ".github", "workflows", "deploy.yml"))).toBe(true);
		// No real deployment URL in dry-run.
		expect(result.urls).toEqual([]);
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
