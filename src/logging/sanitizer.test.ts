import { describe, expect, test } from "bun:test";
import { PROVIDERS } from "../providers/registry.ts";
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

describe("sanitizer — assignment rules do not over-redact ordinary code", () => {
	test("camelCase / config identifiers with non-secret values are left untouched", () => {
		for (const text of [
			"id: { primaryKey: true }",
			"sortKeys: false",
			"tokenizer: cl100k",
			"const tokenizer = new Tokenizer();",
			"maxTokens: 4096",
			"const apiKey = config.apiKey;",
			"apiKey: string;",
			"password: string,",
			"password: z.string().min(8),",
			"secret = os.environ['X']",
			"const key = 'value';",
			"keyboard: true",
			'sortKey: "createdAt"',
			"type K = keyof T;",
			"const API_KEY = process.env.API_KEY;",
			`GHCR_TOKEN: ${"$"}{{ secrets.GHCR_TOKEN }}`,
			"ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY",
			"MAX_TOKENS=4096",
			"if (token === expected) return;",
		]) {
			expect(sanitize(text)).toBe(text);
		}
	});

	test("secret-looking values in code / config assignments are still redacted", () => {
		const cases: Array<[string, string]> = [
			["password: hunter2", "password: [REDACTED]"],
			['password = "correct horse battery staple"', 'password = "[REDACTED]"'],
			['"apiKey": "abc123def456ghi789"', '"apiKey": "[REDACTED]"'],
			["api_key = 'Zx9fQ2LmP0aB7tYc'", "api_key = '[REDACTED]'"],
			["clientSecret: Zx9fQ2LmP0aB7tYcWq81", "clientSecret: [REDACTED]"],
			["x-api-key: 0f8e9d7c6b5a4f3e2d1c", "x-api-key: [REDACTED]"],
			["export API_KEY='quoted value here'", "export API_KEY='[REDACTED]'"],
			["GHCR_TOKEN=abc", "GHCR_TOKEN=[REDACTED]"],
			["{ DB_PASSWORD: hunter2, port: 5432 }", "{ DB_PASSWORD: [REDACTED], port: 5432 }"],
		];
		for (const [input, expected] of cases) expect(sanitize(input)).toBe(expected);
	});

	test("CLI-flag and .npmrc secrets are redacted", () => {
		// High-entropy letters+digits value, built by concatenation for push protection.
		const v = ["Zx9fQ2Lm", "P0aB7tYc", "Wq8"].join("");
		const cases: Array<[string, string]> = [
			[`docker login --password=${v}`, "docker login --password=[REDACTED]"],
			[`vercel deploy --token=${v}`, "vercel deploy --token=[REDACTED]"],
			[`cli --api-key=${v}`, "cli --api-key=[REDACTED]"],
			[`cli --client-secret=${v}`, "cli --client-secret=[REDACTED]"],
			[`//registry.npmjs.org/:_authToken=${v}`, "//registry.npmjs.org/:_authToken=[REDACTED]"],
			[`_authToken=${v}`, "_authToken=[REDACTED]"],
		];
		for (const [input, expected] of cases) expect(sanitize(input)).toBe(expected);
	});
});

describe("sanitizer — escaped quotes inside JSON secret values", () => {
	test("an escaped quote does not end the value early (the rest is not leaked)", () => {
		const out = sanitize('{"GHCR_TOKEN": "ab\\"cd-rest", "image": "app"}');
		expect(out).not.toContain("cd-rest");
		expect(JSON.parse(out)).toEqual({ GHCR_TOKEN: "[REDACTED]", image: "app" });
	});

	test("the same inside an already JSON-encoded string", () => {
		const inner = JSON.stringify({ GHCR_TOKEN: 'ab"cd\\-rest', image: "app" });
		const outer = JSON.stringify({ input: inner });
		const out = sanitize(outer);
		expect(out).not.toContain("cd");
		expect(JSON.parse(JSON.parse(out).input)).toEqual({ GHCR_TOKEN: "[REDACTED]", image: "app" });
	});
});

describe("sanitizer — every catalog provider's key is scrubbed", () => {
	// Fake samples of each provider's documented key format, prefixes split so
	// secret scanners do not flag the fixtures. Providers with no fixed format
	// (Ollama, custom) are covered by the assignment forms and knownSecrets.
	const bareKeys: Record<string, string> = {
		ANTHROPIC_API_KEY: ["sk-ant", "api03", "AbCdEf0123456789_xyz-AbCdEf0123456789AA"].join("-"),
		OPENAI_API_KEY: ["sk-proj", "AbCdEf0123456789_xyz-AbCdEf0123456789"].join("-"),
		OPENROUTER_API_KEY: ["sk-or-v1", "0123456789abcdef0123456789abcdef0123456789abcdef"].join("-"),
		OPENCODE_API_KEY: ["sk", "AbCdEf0123456789AbCdEf0123456789"].join("-"),
		DEEPSEEK_API_KEY: ["sk", "0123456789abcdef0123456789abcdef"].join("-"),
		GEMINI_API_KEY: ["AIza", "SyA-0123456789_abcdefghijABCDEFGHIJ"].join(""),
	};
	const opaque = ["opaque", "0123456789", "abcdefABCDEF"].join("-");

	for (const provider of PROVIDERS) {
		const name = provider.authEnvVar;
		const value = bareKeys[name] ?? opaque;

		test(`${provider.id}: ${name} assignments are redacted in every common form`, () => {
			for (const text of [
				`${name}=${value}`,
				`export ${name}="${value}"`,
				`${name}: ${value}`,
				JSON.stringify({ [name]: value }),
				JSON.stringify({ input: JSON.stringify({ [name]: value }) }),
			]) {
				expect(sanitize(text)).not.toContain(value);
			}
		});

		test(`${provider.id}: a bare key in free text is redacted`, () => {
			const text = `curl failed with key ${value} in a JSON fixture {"apiKey": "${value}"}`;
			const out = bareKeys[name] === undefined ? sanitize(text, [value]) : sanitize(text);
			expect(out).not.toContain(value);
		});
	}

	test("Google OAuth (Gemini CLI login) and Slack tokens are redacted", () => {
		const oauth = ["ya29", "a0AfH6SMBx0123456789abcdefghij"].join(".");
		const slack = ["xoxb", "123456789012", "abcdefghijKLMNOP"].join("-");
		expect(sanitize(`token ${oauth} and ${slack}`)).toBe("token [REDACTED] and [REDACTED]");
	});

	test("knownSecrets redacts literal values, ignoring too-short placeholders", () => {
		expect(sanitize("key is ollama", ["ollama"])).toBe("key is ollama");
		expect(sanitize("a opaque-value-42 b", ["opaque-value-42"])).toBe("a [REDACTED] b");
		expect(containsSecret("a opaque-value-42 b", ["opaque-value-42"])).toBe(true);
	});
});
