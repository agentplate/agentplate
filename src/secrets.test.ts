import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getSecret, hasSecret, loadSecrets, secretsPath, setSecret } from "./secrets.ts";

let root: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "agentplate-sec-"));
	mkdirSync(join(root, ".agentplate"), { recursive: true });
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
	delete process.env.AGENTPLATE_TEST_KEY;
});

describe("secrets store", () => {
	test("loadSecrets is empty when no file exists", () => {
		expect(loadSecrets(root)).toEqual({});
	});

	test("setSecret then loadSecrets round-trips", () => {
		setSecret(root, "ANTHROPIC_API_KEY", "sk-test-value");
		expect(loadSecrets(root).ANTHROPIC_API_KEY).toBe("sk-test-value");
	});

	test("secrets file is written with 0600 permissions", () => {
		setSecret(root, "TOKEN", "abc");
		const mode = statSync(secretsPath(root)).mode & 0o777;
		expect(mode).toBe(0o600);
	});

	test("getSecret prefers the file over the environment", () => {
		process.env.AGENTPLATE_TEST_KEY = "from-env";
		setSecret(root, "AGENTPLATE_TEST_KEY", "from-file");
		expect(getSecret(root, "AGENTPLATE_TEST_KEY")).toBe("from-file");
	});

	test("getSecret falls back to the environment", () => {
		process.env.AGENTPLATE_TEST_KEY = "from-env";
		expect(getSecret(root, "AGENTPLATE_TEST_KEY")).toBe("from-env");
	});

	test("hasSecret reflects availability", () => {
		expect(hasSecret(root, "MISSING")).toBe(false);
		setSecret(root, "PRESENT", "x");
		expect(hasSecret(root, "PRESENT")).toBe(true);
	});
});
