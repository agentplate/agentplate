/**
 * `agentplate serve` command tests. The action blocks forever (it keeps the
 * server alive), so these cover the pure pieces: option parsing for the
 * repeatable `--allow-origin` flag and the non-loopback bind warning.
 */

import { describe, expect, test } from "bun:test";
import { isLoopbackHost } from "../serve/server.ts";
import { createServeCommand, remoteBindWarning, tokenUrl } from "./serve.ts";

describe("serve options", () => {
	test("--allow-origin is repeatable and defaults to none", () => {
		const none = createServeCommand();
		none.parseOptions([]);
		expect(none.opts().allowOrigin).toEqual([]);

		const cmd = createServeCommand();
		cmd.parseOptions([
			"--allow-origin",
			"http://localhost:5173",
			"--allow-origin",
			"http://127.0.0.1:5173",
		]);
		expect(cmd.opts().allowOrigin).toEqual(["http://localhost:5173", "http://127.0.0.1:5173"]);
	});

	test("the default bind host is loopback (no warning)", () => {
		const cmd = createServeCommand();
		cmd.parseOptions([]);
		expect(isLoopbackHost(cmd.opts().host as string)).toBe(true);
	});
});

describe("remoteBindWarning", () => {
	test("names the host and spells out the token + agent-spawn risk", () => {
		const w = remoteBindWarning("0.0.0.0");
		expect(w).toContain("0.0.0.0");
		expect(w).toContain("NOT a loopback");
		expect(w).toContain("bearer token");
		expect(w).toContain("plain HTTP");
		expect(w).toContain("spawn agents");
	});
});

describe("tokenUrl", () => {
	test("appends an encoded ?token= only when a token is required", () => {
		expect(tokenUrl("http://127.0.0.1:7551", null)).toBe("http://127.0.0.1:7551");
		expect(tokenUrl("http://0.0.0.0:7551", "a b&c")).toBe("http://0.0.0.0:7551/?token=a%20b%26c");
	});
});
