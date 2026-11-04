import { describe, expect, test } from "bun:test";
import { containsSecret, sanitize } from "./sanitizer.ts";

describe("sanitizer", () => {
	test("redacts Anthropic-style keys", () => {
		const out = sanitize("key is sk-ant-abcdef0123456789ABCDEF done");
		expect(out).not.toContain("abcdef0123456789");
		expect(out).toContain("[REDACTED]");
	});

	test("redacts KEY=value assignments but keeps the key prefix", () => {
		const out = sanitize("ANTHROPIC_API_KEY=supersecretvalue123");
		expect(out).toContain("ANTHROPIC_API_KEY=");
		expect(out).not.toContain("supersecretvalue123");
	});

	test("redacts bearer tokens", () => {
		const out = sanitize("Authorization: Bearer abc.def.ghi");
		expect(out).not.toContain("abc.def.ghi");
	});

	test("redacts PEM private key blocks", () => {
		const pem = "-----BEGIN PRIVATE KEY-----\nMIIBVgIBADANBg\n-----END PRIVATE KEY-----";
		expect(sanitize(pem)).toBe("[REDACTED]");
	});

	test("leaves clean text untouched", () => {
		const clean = "just a normal log line with no secrets";
		expect(sanitize(clean)).toBe(clean);
		expect(containsSecret(clean)).toBe(false);
	});

	test("containsSecret detects secrets", () => {
		expect(containsSecret("token: ghp_0123456789abcdefghij0123")).toBe(true);
	});
});

describe("sanitizer — modern provider / platform key formats", () => {
	// Fake, structurally-valid samples of each format (never real credentials).
	// Prefixes are concatenated so secret scanners (e.g. GitHub push protection)
	// do not flag these fixtures as leaked keys.
	const samples: Record<string, string> = {
		"Anthropic sk-ant-api03-": ["sk-ant", "api03-AbCdEf0123456789_xyz-AbCdEf0123456789AA"].join(
			"-",
		),
		"OpenAI sk-proj-": ["sk-proj", "AbCdEf0123456789_xyz-AbCdEf0123456789T3Blbk" + "FJ"].join("-"),
		"OpenAI sk-svcacct-": ["sk-svcacct", "AbCdEf0123456789_xyzAbCdEf01234"].join("-"),
		"OpenAI sk-admin-": ["sk-admin", "AbCdEf0123456789_xyzAbCdEf01234"].join("-"),
		"OpenRouter sk-or-v1-": "sk-or-v1-0123456789abcdef0123456789abcdef0123456789abcdef01234567",
		"GitHub fine-grained github_pat_":
			"github_pat_11ABCDEFG0123456789abc_0123456789abcdefghijABCDEFGHIJ0123456789abcdefghijABCDEFGHI",
		"GitHub classic ghp_": "ghp_0123456789abcdefghijABCDEFGHIJ0123",
		"GitHub OAuth gho_": "gho_0123456789abcdefghijABCDEFGHIJ0123",
		"GitHub user-to-server ghu_": "ghu_0123456789abcdefghijABCDEFGHIJ0123",
		"GitHub server-to-server ghs_": "ghs_0123456789abcdefghijABCDEFGHIJ0123",
		"GitHub refresh ghr_": "ghr_0123456789abcdefghijABCDEFGHIJ0123",
		"AWS long-term AKIA": "AKIAABCDEFGHIJ012345",
		"AWS STS ASIA": "ASIAABCDEFGHIJ012345",
		"Google AIza": "AIzaSyA-0123456789_abcdefghijABCDEFGHIJ",
	};

	for (const [label, secret] of Object.entries(samples)) {
		test(`redacts a bare ${label} key in free text`, () => {
			const out = sanitize(`docker push failed: token ${secret} rejected`);
			expect(out).not.toContain(secret);
			expect(out).toBe("docker push failed: token [REDACTED] rejected");
			expect(containsSecret(secret)).toBe(true);
		});
	}

	test("a whole key is redacted, not just a prefix of it", () => {
		const out = sanitize(`k=${samples["OpenAI sk-proj-"]}`);
		expect(out).not.toContain("T3BlbkFJ");
		expect(out).not.toContain("_xyz");
	});
});

describe("sanitizer — JSON-quoted secrets", () => {
	test("redacts a quoted env-style secret field and keeps the JSON valid", () => {
		const json = JSON.stringify({ GHCR_TOKEN: "tok-0123456789abcdef", image: "app" });
		const out = sanitize(json);
		expect(out).not.toContain("tok-0123456789abcdef");
		expect(JSON.parse(out)).toEqual({ GHCR_TOKEN: "[REDACTED]", image: "app" });
	});

	test("redacts a quoted field with whitespace around the colon", () => {
		const out = sanitize('{ "OPENAI_API_KEY" : "not-a-prefixed-value-123" }');
		expect(out).toBe('{ "OPENAI_API_KEY" : "[REDACTED]" }');
	});

	test("redacts a secret field inside an already JSON-encoded string", () => {
		// e.g. a tool_use input echoed through stream-json: the inner quotes are escaped.
		const inner = JSON.stringify({ REGISTRY_PASSWORD: "hunter2-but-longer" });
		const outer = JSON.stringify({ type: "tool_use", input: inner });
		const out = sanitize(outer);
		expect(out).not.toContain("hunter2-but-longer");
		expect(JSON.parse(JSON.parse(out).input)).toEqual({ REGISTRY_PASSWORD: "[REDACTED]" });
	});

	test("redacts a JSON authorization header with a bearer token", () => {
		for (const text of [
			'{"authorization":"Bearer abc.def.ghi"}',
			'{"Authorization": "Bearer abc.def.ghi"}',
			JSON.stringify({ headers: JSON.stringify({ Authorization: "Bearer abc.def.ghi" }) }),
		]) {
			const out = sanitize(text);
			expect(out).not.toContain("abc.def.ghi");
			expect(out).toContain("[REDACTED]");
		}
		expect(JSON.parse(sanitize('{"authorization":"Bearer abc.def.ghi"}'))).toEqual({
			authorization: "Bearer [REDACTED]",
		});
	});

	test("does not over-redact ordinary camelCase JSON config fields", () => {
		// The JSON rule is case-sensitive and env-style only: no new false positives.
		const json = JSON.stringify({
			maxTokens: 4096,
			primaryKey: true,
			sortKeys: false,
			tokenizer: "cl100k_base",
			keywords: ["a", "b"],
		});
		expect(sanitize(json)).toBe(json);
	});

	test("an empty secret field is left alone and a redacted one is stable", () => {
		const empty = '{"GHCR_TOKEN": ""}';
		expect(sanitize(empty)).toBe(empty);
		const once = sanitize('{"GHCR_TOKEN": "abc123"}');
		expect(sanitize(once)).toBe(once);
		expect(containsSecret(once)).toBe(false);
	});
});
