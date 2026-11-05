/**
 * install.sh tests: run the real script with real git against a temp source repo.
 * Only `bun` is stubbed (on PATH) — a real `bun install` / `bun link` would touch
 * the network and the user's global link registry.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const INSTALL_SH = join(import.meta.dir, "..", "install.sh");

let base: string;
let repo: string;
let dest: string;
let stubDir: string;
let bunLog: string;

async function gitOk(cwd: string, args: string[]): Promise<void> {
	const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
	const [, err, code] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	if (code !== 0) throw new Error(`git ${args.join(" ")} failed: ${err}`);
}

async function release(version: string): Promise<void> {
	writeFileSync(join(repo, "VERSION"), `${version}\n`);
	await gitOk(repo, ["add", "VERSION"]);
	await gitOk(repo, ["commit", "-q", "-m", `release ${version}`]);
	await gitOk(repo, ["tag", version]);
}

async function runInstaller(
	env: Record<string, string> = {},
): Promise<{ code: number; out: string; err: string }> {
	const gitDir = dirname(Bun.which("git") ?? "/usr/bin/git");
	const proc = Bun.spawn(["bash", INSTALL_SH], {
		cwd: base,
		env: {
			HOME: base,
			PATH: `${stubDir}:${gitDir}:/usr/bin:/bin`,
			AGENTPLATE_REPO: repo,
			AGENTPLATE_DIR: dest,
			BUN_LOG: bunLog,
			...env,
		},
		stdout: "pipe",
		stderr: "pipe",
	});
	const [out, err, code] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	return { code, out, err };
}

function installedVersion(): string {
	return readFileSync(join(dest, "VERSION"), "utf8").trim();
}

beforeEach(async () => {
	base = realpathSync(mkdtempSync(join(tmpdir(), "ap-install-")));
	repo = join(base, "src-repo");
	dest = join(base, "dest");
	stubDir = join(base, "stub");
	bunLog = join(base, "bun.log");
	mkdirSync(repo);
	mkdirSync(stubDir);
	writeFileSync(
		join(stubDir, "bun"),
		[
			"#!/bin/sh",
			'echo "$*" >> "$BUN_LOG"',
			'if [ "$1" = link ] && [ "$STUB_LINK_FAIL" = 1 ]; then echo "link boom" >&2; exit 1; fi',
			"exit 0",
		].join("\n"),
	);
	chmodSync(join(stubDir, "bun"), 0o755);

	await gitOk(repo, ["init", "-q"]);
	await gitOk(repo, ["config", "user.email", "test@agentplate.dev"]);
	await gitOk(repo, ["config", "user.name", "Agentplate Test"]);
	await release("v1.2.0");
	await release("v1.10.0");
	await release("v1.9.9");
	await release("v2.0.0-rc.1"); // prerelease: never picked as "latest"
	writeFileSync(join(repo, "VERSION"), "main-head\n");
	await gitOk(repo, ["commit", "-q", "-am", "unreleased work on main"]);
});

afterEach(() => {
	rmSync(base, { recursive: true, force: true });
});

describe("install.sh", () => {
	test("installs the latest stable release tag, not main HEAD", async () => {
		const { code, out } = await runInstaller();
		expect(code).toBe(0);
		expect(installedVersion()).toBe("v1.10.0");
		expect(out).toContain("v1.10.0 installed");
	});

	test("AGENTPLATE_VERSION pins a specific release (with or without the v)", async () => {
		expect((await runInstaller({ AGENTPLATE_VERSION: "1.2.0" })).code).toBe(0);
		expect(installedVersion()).toBe("v1.2.0");
		// Re-running updates the existing checkout to another pinned release.
		expect((await runInstaller({ AGENTPLATE_VERSION: "v1.9.9" })).code).toBe(0);
		expect(installedVersion()).toBe("v1.9.9");
	});

	test("installs dependencies with --frozen-lockfile", async () => {
		await runInstaller();
		const log = readFileSync(bunLog, "utf8");
		expect(log).toContain("install --frozen-lockfile");
		expect(log).toContain("link");
	});

	test("fails loudly when bun link fails (no success banner)", async () => {
		const { code, out, err } = await runInstaller({ STUB_LINK_FAIL: "1" });
		expect(code).not.toBe(0);
		expect(err).toContain("bun link failed");
		expect(out).not.toContain("installed");
	});

	test("fails when the requested release does not exist", async () => {
		const { code } = await runInstaller({ AGENTPLATE_VERSION: "9.9.9" });
		expect(code).not.toBe(0);
		expect(existsSync(join(dest, "VERSION"))).toBe(false);
	});
});
