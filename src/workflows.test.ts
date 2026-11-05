import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import yaml from "js-yaml";

// Guards for the repo's own CI/CD pipeline (.github/workflows). These files are not
// executed by `bun test`, so a regression in them (an unpinned action, a write-scoped
// token handed to dependency code, a UI that is never type-checked) would otherwise
// only surface on GitHub — usually at publish time. Like version.test.ts, this reads
// the REAL files and fails the gates on drift.

const ROOT = join(import.meta.dir, "..");

interface Step {
	name?: string;
	uses?: string;
	run?: string;
	if?: string;
	with?: Record<string, unknown>;
	env?: Record<string, unknown>;
	"working-directory"?: string;
}

interface Job {
	if?: string;
	needs?: string | string[];
	permissions?: Record<string, string> | string;
	defaults?: { run?: { "working-directory"?: string } };
	steps?: Step[];
}

interface Workflow {
	permissions?: Record<string, string> | string;
	jobs: Record<string, Job>;
}

async function loadWorkflow(name: string): Promise<Workflow> {
	const text = await Bun.file(join(ROOT, ".github", "workflows", name)).text();
	return yaml.load(text) as Workflow;
}

async function loadPackageScripts(dir: string): Promise<Record<string, string>> {
	const pkg = (await Bun.file(join(ROOT, dir, "package.json")).json()) as {
		scripts?: Record<string, string>;
	};
	return pkg.scripts ?? {};
}

function jobSteps(job: Job): Step[] {
	return job.steps ?? [];
}

function allSteps(wf: Workflow): Step[] {
	return Object.values(wf.jobs).flatMap(jobSteps);
}

/** The directory a `run:` step executes in, resolving job-level defaults. */
function stepCwd(job: Job, step: Step): string {
	return step["working-directory"] ?? job.defaults?.run?.["working-directory"] ?? ".";
}

/** Every `run:` script executed inside ui/ (the separate web-UI package). */
function uiRunScripts(wf: Workflow): string[] {
	return Object.values(wf.jobs).flatMap((job) =>
		jobSteps(job)
			.filter((s) => typeof s.run === "string" && stepCwd(job, s) === "ui")
			.map((s) => s.run ?? ""),
	);
}

/** Permissions that grant anything beyond read access. */
function writeScopes(perms: Job["permissions"]): string[] {
	if (perms === undefined) return [];
	if (typeof perms === "string") return perms === "read-all" ? [] : [perms];
	return Object.entries(perms)
		.filter(([, level]) => level !== "read" && level !== "none")
		.map(([scope]) => scope);
}

const SHA_PINNED = /^[\w.-]+\/[\w.-]+(?:\/[\w./-]+)?@[0-9a-f]{40}$/;

describe.each(["ci.yml", "publish.yml"])("%s (common hardening)", (file) => {
	test("pins every action to a full commit SHA", async () => {
		const wf = await loadWorkflow(file);
		const unpinned = allSteps(wf)
			.map((s) => s.uses)
			.filter((u): u is string => typeof u === "string")
			.filter((u) => !u.startsWith("./") && !SHA_PINNED.test(u));
		expect(unpinned).toEqual([]);
	});

	test("does not persist checkout credentials into .git", async () => {
		const wf = await loadWorkflow(file);
		const checkouts = allSteps(wf).filter((s) => s.uses?.startsWith("actions/checkout@"));
		expect(checkouts.length).toBeGreaterThan(0);
		for (const step of checkouts) {
			expect(step.with?.["persist-credentials"]).toBe(false);
		}
	});

	test("does not float the Bun toolchain on `latest`", async () => {
		const wf = await loadWorkflow(file);
		for (const step of allSteps(wf).filter((s) => s.uses?.startsWith("oven-sh/setup-bun@"))) {
			const version = String(step.with?.["bun-version"] ?? "");
			expect(version).toMatch(/^\d+\.\d+\.\d+$/);
		}
	});

	test("declares an explicit, non-write default token permission", async () => {
		const wf = await loadWorkflow(file);
		expect(wf.permissions).toBeDefined();
		expect(writeScopes(wf.permissions)).toEqual([]);
	});
});

describe("ci.yml", () => {
	test("never grants a write-scoped token", async () => {
		const wf = await loadWorkflow("ci.yml");
		for (const job of Object.values(wf.jobs)) {
			expect(writeScopes(job.permissions)).toEqual([]);
		}
	});

	test("installs ui deps from the lockfile, type-checks and builds the UI", async () => {
		const uiRuns = uiRunScripts(await loadWorkflow("ci.yml"));
		expect(uiRuns.some((r) => r.includes("bun install --frozen-lockfile"))).toBe(true);
		expect(uiRuns.some((r) => r.includes("bun run typecheck"))).toBe(true);
		expect(uiRuns.some((r) => r.includes("bun run build"))).toBe(true);
	});
});

describe("ui/package.json", () => {
	test("has a typecheck script (vite build only transpiles)", async () => {
		const scripts = await loadPackageScripts("ui");
		expect(scripts.typecheck).toContain("tsc --noEmit");
	});
});

describe("package.json build:ui", () => {
	test("installs ui deps with --frozen-lockfile", async () => {
		const scripts = await loadPackageScripts(".");
		expect(scripts["build:ui"]).toContain("bun install --frozen-lockfile");
	});
});

describe("publish.yml", () => {
	const isPublishStep = (s: Step) => /\bnpm publish\b/.test(s.run ?? "");

	async function publishJob(): Promise<[string, Job]> {
		const wf = await loadWorkflow("publish.yml");
		const entry = Object.entries(wf.jobs).find(([, job]) => jobSteps(job).some(isPublishStep));
		if (!entry) throw new Error("publish.yml has no `npm publish` step");
		return entry;
	}

	test("every job is restricted to the main branch (workflow_dispatch from any ref is not enough)", async () => {
		const wf = await loadWorkflow("publish.yml");
		const guarded = (name: string, seen: Set<string> = new Set()): boolean => {
			const job = wf.jobs[name];
			if (!job || seen.has(name)) return false;
			seen.add(name);
			if (job.if?.includes("github.ref == 'refs/heads/main'")) return true;
			// A job that needs a main-guarded job is skipped whenever that job is skipped.
			const needs = job.needs === undefined ? [] : [job.needs].flat();
			return needs.some((n) => guarded(n, seen));
		};
		for (const name of Object.keys(wf.jobs)) {
			expect({ job: name, guarded: guarded(name) }).toEqual({ job: name, guarded: true });
		}
	});

	test("publishes with --ignore-scripts so no lifecycle script sees the npm token", async () => {
		const [, job] = await publishJob();
		const step = jobSteps(job).find(isPublishStep);
		expect(step?.run).toMatch(/npm publish[^\n]*--ignore-scripts/);
	});

	test("the token-bearing job runs no dependency code (no bun, no install, no build)", async () => {
		const [, job] = await publishJob();
		for (const step of jobSteps(job)) {
			expect(step.uses ?? "").not.toMatch(/^oven-sh\/setup-bun@/);
			expect(step.run ?? "").not.toMatch(/\bbun\b|\bnpm (?:ci|install|run)\b|\bnpx\b/);
		}
	});

	test("only the publish job holds write / id-token permissions", async () => {
		const wf = await loadWorkflow("publish.yml");
		const [publishName] = await publishJob();
		for (const [name, job] of Object.entries(wf.jobs)) {
			expect(job.permissions).toBeDefined();
			if (name !== publishName)
				expect({ name, write: writeScopes(job.permissions) }).toEqual({ name, write: [] });
		}
	});

	test("jobs that run dependency code never reference secrets", async () => {
		const wf = await loadWorkflow("publish.yml");
		for (const [name, job] of Object.entries(wf.jobs)) {
			const runsDeps = jobSteps(job).some((s) => /\bbun (?:install|test|run)\b/.test(s.run ?? ""));
			if (!runsDeps) continue;
			expect({ name, secrets: JSON.stringify(job).includes("secrets.") }).toEqual({
				name,
				secrets: false,
			});
		}
	});

	test("the UI is type-checked and built from the lockfile before publishing", async () => {
		const uiRuns = uiRunScripts(await loadWorkflow("publish.yml"));
		expect(uiRuns.some((r) => r.includes("bun install --frozen-lockfile"))).toBe(true);
		expect(uiRuns.some((r) => r.includes("bun run typecheck"))).toBe(true);
		expect(uiRuns.some((r) => r.includes("bun run build"))).toBe(true);
	});

	test("checks whether this exact version exists, not just the `latest` dist-tag", async () => {
		const wf = await loadWorkflow("publish.yml");
		const runs = allSteps(wf).map((s) => s.run ?? "");
		expect(runs.some((r) => r.includes('npm view "$NAME@$LOCAL" version'))).toBe(true);
		expect(runs.some((r) => /npm view "\$NAME" version/.test(r))).toBe(false);
	});

	test("creates the GitHub Release only after npm publish actually ran", async () => {
		const [, job] = await publishJob();
		const steps = jobSteps(job);
		const publish = steps.find(isPublishStep);
		const release = steps.find((s) => (s.run ?? "").includes("gh release create"));
		expect(publish?.run).toContain("published=true");
		expect(release?.if).toContain("outputs.published == 'true'");
	});
});
