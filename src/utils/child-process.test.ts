/**
 * Tests for the agent-facing child-process helpers: the allowlisted env (deploy
 * secrets never reach agents) and the kill timer (SIGTERM → SIGKILL, whole
 * process group). Real subprocesses; nothing is mocked.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentChildEnv, armKillTimer, ENV_PASSTHROUGH_VAR } from "./child-process.ts";

// Fixtures shaped like real credentials are assembled at runtime.
const GHCR = ["ghp", "deploytokenfixture0123456789abcdef"].join("_");
const AWS_SECRET = ["wJalrXUtnFEMI", "K7MDENG", "bPxRfiCYFIXTURE"].join("/");

describe("agentChildEnv", () => {
	const parent: Record<string, string | undefined> = {
		PATH: "/usr/bin:/bin",
		HOME: "/home/dev",
		LANG: "C.UTF-8",
		LC_ALL: "C.UTF-8",
		TMPDIR: "/tmp",
		XDG_CONFIG_HOME: "/home/dev/.config",
		https_proxy: "http://proxy:3128",
		GIT_AUTHOR_NAME: "Dev",
		SSH_AUTH_SOCK: "/run/ssh.sock",
		// Must never reach an agent:
		GHCR_TOKEN: GHCR,
		CI_DEPLOY_TOKEN: "deploy-secret",
		AWS_SECRET_ACCESS_KEY: AWS_SECRET,
		ACTIONS_ID_TOKEN_REQUEST_TOKEN: "oidc-secret",
		GITHUB_TOKEN: "gh-job-token",
		// Would aim the worktree's git at another repository:
		GIT_DIR: "/elsewhere/.git",
		GIT_WORK_TREE: "/elsewhere",
		UNSET_VALUE: undefined,
	};

	test("inherits the process basics and drops deploy/CI secrets", () => {
		const env = agentChildEnv({}, { parent });
		expect(env).toEqual({
			PATH: "/usr/bin:/bin",
			HOME: "/home/dev",
			LANG: "C.UTF-8",
			LC_ALL: "C.UTF-8",
			TMPDIR: "/tmp",
			XDG_CONFIG_HOME: "/home/dev/.config",
			https_proxy: "http://proxy:3128",
			GIT_AUTHOR_NAME: "Dev",
			SSH_AUTH_SOCK: "/run/ssh.sock",
		});
	});

	test("overrides (the resolved provider env) always win, including an explicit ''", () => {
		const env = agentChildEnv(
			{ OPENROUTER_API_KEY: "or-key", HOME: "/override", ANTHROPIC_API_KEY: "" },
			{ parent: { ...parent, ANTHROPIC_API_KEY: "shell-key" }, passthrough: ["ANTHROPIC_*"] },
		);
		expect(env.OPENROUTER_API_KEY).toBe("or-key");
		expect(env.HOME).toBe("/override");
		expect(env.ANTHROPIC_API_KEY).toBe("");
	});

	test("a runtime's passthrough adds its own namespace (exact names + PREFIX_*)", () => {
		const env = agentChildEnv(
			{},
			{
				parent: { ...parent, CLAUDE_CONFIG_DIR: "/c", IS_SANDBOX: "1", CLAUDEX: "no" },
				passthrough: ["CLAUDE_*", "IS_SANDBOX"],
			},
		);
		expect(env.CLAUDE_CONFIG_DIR).toBe("/c");
		expect(env.IS_SANDBOX).toBe("1");
		expect(env.CLAUDEX).toBeUndefined(); // the prefix includes the underscore
		expect(env.GHCR_TOKEN).toBeUndefined();
	});

	test(`the operator can widen the allowlist via ${ENV_PASSTHROUGH_VAR}`, () => {
		const withList = agentChildEnv(
			{},
			{ parent: { ...parent, [ENV_PASSTHROUGH_VAR]: "AWS_SECRET_ACCESS_KEY, CI_*" } },
		);
		expect(withList.AWS_SECRET_ACCESS_KEY).toBe(AWS_SECRET);
		expect(withList.CI_DEPLOY_TOKEN).toBe("deploy-secret");
		expect(withList.GHCR_TOKEN).toBeUndefined();

		// A lone `*` restores the old inherit-everything behavior on purpose.
		const everything = agentChildEnv({}, { parent: { ...parent, [ENV_PASSTHROUGH_VAR]: "*" } });
		expect(everything.GHCR_TOKEN).toBe(GHCR);
	});

	test(`${ENV_PASSTHROUGH_VAR} survives nesting (operator → lead → builder)`, () => {
		// A lead runs `agentplate sling` inside its own turn, so the builder's env
		// is agentChildEnv applied to the lead's already-filtered env.
		const operator = { ...parent, [ENV_PASSTHROUGH_VAR]: "AWS_*" };
		const lead = agentChildEnv({}, { parent: operator });
		expect(lead[ENV_PASSTHROUGH_VAR]).toBe("AWS_*");
		expect(lead.AWS_SECRET_ACCESS_KEY).toBe(AWS_SECRET);

		const builder = agentChildEnv({}, { parent: lead });
		expect(builder[ENV_PASSTHROUGH_VAR]).toBe("AWS_*");
		expect(builder.AWS_SECRET_ACCESS_KEY).toBe(AWS_SECRET);
		expect(builder.PATH).toBe("/usr/bin:/bin");
		// Nesting widens nothing: what the lead lacked, the builder lacks too.
		expect(builder.GHCR_TOKEN).toBeUndefined();
		expect(builder.CI_DEPLOY_TOKEN).toBeUndefined();
	});

	test("defaults to filtering the real process.env", () => {
		const saved = process.env.GHCR_TOKEN;
		process.env.GHCR_TOKEN = GHCR;
		try {
			const env = agentChildEnv({ EXTRA: "1" });
			expect(env.GHCR_TOKEN).toBeUndefined();
			expect(env.PATH).toBe(process.env.PATH as string);
			expect(env.EXTRA).toBe("1");
		} finally {
			if (saved === undefined) delete process.env.GHCR_TOKEN;
			else process.env.GHCR_TOKEN = saved;
		}
	});
});

describe("armKillTimer", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "agentplate-killtimer-"));
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	test("SIGTERMs a child that outlives the cap and reports timedOut", async () => {
		const proc = Bun.spawn(["sleep", "10"], { stdout: "ignore", stderr: "ignore" });
		const started = performance.now();
		const timer = armKillTimer(proc, 150);
		const code = await proc.exited;
		timer.clear();
		expect(timer.timedOut).toBe(true);
		expect(code).not.toBe(0);
		expect(performance.now() - started).toBeLessThan(3000);
	});

	test("escalates to SIGKILL when the child ignores SIGTERM", async () => {
		// An ignored signal disposition survives exec, so `sleep` ignores TERM too.
		const proc = Bun.spawn(["bash", "-c", "trap '' TERM; sleep 10"], {
			stdout: "ignore",
			stderr: "ignore",
		});
		const started = performance.now();
		const timer = armKillTimer(proc, 100, { graceMs: 200 });
		await proc.exited;
		timer.clear();
		expect(timer.timedOut).toBe(true);
		expect(proc.signalCode).toBe("SIGKILL");
		expect(performance.now() - started).toBeLessThan(3000);
	});

	test("group mode kills grandchildren too (a gate's test runner under the shell)", async () => {
		const marker = join(dir, "grandchild-survived");
		// The backgrounded grandchild would create the marker after 1s.
		const proc = Bun.spawn(["bash", "-c", `(sleep 1 && touch '${marker}') & wait`], {
			stdout: "ignore",
			stderr: "ignore",
			detached: true,
		});
		const timer = armKillTimer(proc, 150, { group: true, graceMs: 200 });
		await proc.exited;
		timer.clear();
		expect(timer.timedOut).toBe(true);
		await Bun.sleep(1500);
		expect(existsSync(marker)).toBe(false);
	});

	test("arms nothing for a missing or non-positive limit, and clear() disarms", async () => {
		for (const limit of [undefined, 0, -5]) {
			const proc = Bun.spawn(["true"]);
			const timer = armKillTimer(proc, limit);
			expect(await proc.exited).toBe(0);
			timer.clear();
			expect(timer.timedOut).toBe(false);
		}
		const proc = Bun.spawn(["sleep", "0.3"]);
		const timer = armKillTimer(proc, 100);
		timer.clear(); // disarmed before it fires
		expect(await proc.exited).toBe(0);
		expect(timer.timedOut).toBe(false);
	});
});
