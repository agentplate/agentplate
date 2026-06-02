import { describe, expect, test } from "bun:test";
import { commandOnPath, resolveArgv } from "./detect.ts";

describe("commandOnPath", () => {
	test("finds a binary that is on PATH (cross-platform via Bun.which)", async () => {
		// `node` ships with the Bun/CI toolchain on every OS we run on.
		expect(await commandOnPath("node")).toBe(true);
	});

	test("returns false for a definitely-absent command", async () => {
		expect(await commandOnPath("definitely-not-a-real-cli-xyz")).toBe(false);
	});
});

describe("resolveArgv", () => {
	test("returns the argv unchanged on POSIX (the proven path)", () => {
		// On macOS/Linux (where this suite runs) the argv is passed through verbatim.
		if (process.platform !== "win32") {
			const argv = ["gemini", "--model", "x", "--prompt", "hi"];
			expect(resolveArgv(argv)).toEqual(argv);
		}
	});

	test("handles an empty argv without throwing", () => {
		expect(resolveArgv([])).toEqual([]);
	});

	test("on Windows, resolves argv[0] to a real path and keeps the rest", () => {
		// The win32 branch can only run on Windows; here we just assert the contract
		// holds for the args tail regardless of OS (argv[0] is resolved or left as-is).
		const out = resolveArgv(["gemini", "--prompt", "hi"]);
		expect(out.slice(1)).toEqual(["--prompt", "hi"]);
		expect(out.length).toBe(3);
	});
});
