import { describe, expect, test } from "bun:test";
import {
	AgentplateError,
	ConfigError,
	isAgentplateError,
	NotFoundError,
	SubprocessError,
	ValidationError,
} from "./errors.ts";

describe("errors", () => {
	test("AgentplateError carries code and exitCode", () => {
		const err = new AgentplateError("boom");
		expect(err.code).toBe("AGENTPLATE_ERROR");
		expect(err.exitCode).toBe(1);
		expect(err.message).toBe("boom");
		expect(err.name).toBe("AgentplateError");
	});

	test("subclasses set stable codes and exit codes", () => {
		expect(new ConfigError("x").code).toBe("CONFIG_ERROR");
		expect(new ValidationError("x").code).toBe("VALIDATION_ERROR");
		expect(new ValidationError("x").exitCode).toBe(2);
		expect(new NotFoundError("x").exitCode).toBe(4);
	});

	test("subclass names reflect the class", () => {
		expect(new ConfigError("x").name).toBe("ConfigError");
	});

	test("SubprocessError preserves the child exit code", () => {
		const err = new SubprocessError("git failed", 128);
		expect(err.subprocessExitCode).toBe(128);
		expect(err.code).toBe("SUBPROCESS_ERROR");
	});

	test("isAgentplateError narrows correctly", () => {
		expect(isAgentplateError(new ConfigError("x"))).toBe(true);
		expect(isAgentplateError(new Error("plain"))).toBe(false);
		expect(isAgentplateError("nope")).toBe(false);
	});
});
