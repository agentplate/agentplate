/**
 * `agentplate serve` command tests. The action blocks forever (it keeps the
 * server alive), so these cover the pure pieces: option parsing for the
 * repeatable `--allow-origin` flag and the non-loopback bind warning.
 */

import { describe, expect, test } from "bun:test";
import { isLoopbackHost } from "../serve/server.ts";
import { createServeCommand, remoteBindWarning } from "./serve.ts";

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
	test("names the host and spells out the unauthenticated-agent-spawn risk", () => {
		const w = remoteBindWarning("0.0.0.0");
		expect(w).toContain("0.0.0.0");
		expect(w).toContain("NOT a loopback");
		expect(w).toContain("no authentication");
		expect(w).toContain("spawn agents");
	});
});
