import { describe, expect, test } from "bun:test";
import { ConfigError } from "./errors.ts";
import { jsonFailure, jsonSuccess } from "./json.ts";

describe("json envelopes", () => {
	test("jsonSuccess wraps data", () => {
		expect(jsonSuccess({ a: 1 })).toEqual({ ok: true, data: { a: 1 } });
	});

	test("jsonFailure preserves AgentplateError code", () => {
		const env = jsonFailure(new ConfigError("bad config"));
		expect(env.ok).toBe(false);
		expect(env.error.code).toBe("CONFIG_ERROR");
		expect(env.error.message).toBe("bad config");
	});

	test("jsonFailure handles plain errors", () => {
		const env = jsonFailure(new Error("oops"));
		expect(env.error.code).toBe("UNKNOWN_ERROR");
		expect(env.error.message).toBe("oops");
	});

	test("jsonFailure handles non-error throwables", () => {
		const env = jsonFailure("string thrown");
		expect(env.error.code).toBe("UNKNOWN_ERROR");
		expect(env.error.message).toBe("string thrown");
	});
});
