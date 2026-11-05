import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigError } from "./errors.ts";
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

	test("setSecret tightens a pre-existing world-readable secrets file to 0600", () => {
		// writeFileSync's `mode` only applies on creation — a hand-made 0644 file
		// must not keep its loose mode once an API key is written into it.
		writeFileSync(secretsPath(root), "GHCR_TOKEN: hand-written\n", { mode: 0o644 });
		chmodSync(secretsPath(root), 0o644);
		expect(statSync(secretsPath(root)).mode & 0o777).toBe(0o644);

		setSecret(root, "ANTHROPIC_API_KEY", "sk-test-value");

		expect(statSync(secretsPath(root)).mode & 0o777).toBe(0o600);
		expect(loadSecrets(root)).toEqual({
			GHCR_TOKEN: "hand-written",
			ANTHROPIC_API_KEY: "sk-test-value",
		});
	});

	test("every setSecret re-asserts 0600 even if the mode was loosened in between", () => {
		setSecret(root, "A", "1");
		chmodSync(secretsPath(root), 0o666);
		setSecret(root, "B", "2");
		expect(statSync(secretsPath(root)).mode & 0o777).toBe(0o600);
	});
});

describe("secrets store — hand-written YAML values", () => {
	test("number- and boolean-looking values are kept verbatim as strings", () => {
		writeFileSync(
			secretsPath(root),
			"GHCR_TOKEN: 0x1234abcd\nPIN: 0123456789\nFLAG: true\nEXP: 1e10\nDAY: 2024-01-01\n",
		);
		expect(loadSecrets(root)).toEqual({
			GHCR_TOKEN: "0x1234abcd",
			PIN: "0123456789",
			FLAG: "true",
			EXP: "1e10",
			DAY: "2024-01-01",
		});
		expect(getSecret(root, "PIN")).toBe("0123456789");
	});

	test("setSecret does not erase hand-written entries (numeric-looking or empty)", () => {
		writeFileSync(secretsPath(root), "GHCR_TOKEN: 0x1234abcd\nPIN: 123456\nPLACEHOLDER:\n");
		setSecret(root, "ANTHROPIC_API_KEY", "sk-test-value");

		const text = readFileSync(secretsPath(root), "utf8");
		expect(text).toContain("PLACEHOLDER:");
		expect(loadSecrets(root)).toEqual({
			GHCR_TOKEN: "0x1234abcd",
			PIN: "123456",
			ANTHROPIC_API_KEY: "sk-test-value",
		});
	});

	test("an empty / null value counts as absent and falls back to the environment", () => {
		process.env.AGENTPLATE_TEST_KEY = "from-env";
		writeFileSync(secretsPath(root), "AGENTPLATE_TEST_KEY:\nOTHER: ~\n");
		expect(loadSecrets(root)).toEqual({});
		expect(getSecret(root, "AGENTPLATE_TEST_KEY")).toBe("from-env");
	});

	test("a nested mapping or list value is skipped with a warning; other lookups still work", () => {
		const writes: string[] = [];
		const spy = spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
			writes.push(String(chunk));
			return true;
		});
		try {
			writeFileSync(secretsPath(root), "GOOD: ok\nBAD:\n  nested: value\nLIST:\n  - a\n  - b\n");
			expect(loadSecrets(root)).toEqual({ GOOD: "ok" });
			expect(getSecret(root, "GOOD")).toBe("ok");
			expect(hasSecret(root, "GOOD")).toBe(true);
			expect(getSecret(root, "BAD")).toBeUndefined();
			expect(hasSecret(root, "LIST")).toBe(false);
		} finally {
			spy.mockRestore();
		}
		const warnings = writes.join("");
		expect(warnings).toContain("BAD");
		expect(warnings).toMatch(/LIST.*list/);
		// Each bad entry warns once, not on every lookup.
		expect(warnings.split("Secret BAD").length - 1).toBe(1);
	});

	test("a nested entry does not hide the environment fallback for its name", () => {
		process.env.AGENTPLATE_TEST_KEY = "from-env";
		const spy = spyOn(process.stderr, "write").mockImplementation(() => true);
		try {
			writeFileSync(secretsPath(root), "AGENTPLATE_TEST_KEY:\n  nested: value\n");
			expect(getSecret(root, "AGENTPLATE_TEST_KEY")).toBe("from-env");
		} finally {
			spy.mockRestore();
		}
	});

	test("setSecret refuses to rewrite a file holding an invalid entry (no data loss)", () => {
		const original = "GOOD: ok\nBAD:\n  nested: value\n";
		writeFileSync(secretsPath(root), original);
		expect(() => setSecret(root, "NEW", "v")).toThrow(ConfigError);
		expect(readFileSync(secretsPath(root), "utf8")).toBe(original);
	});
});
