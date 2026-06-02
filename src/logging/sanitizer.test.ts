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
