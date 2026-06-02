import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { VERSION } from "./version.ts";

// The CLI version is intentionally a plain constant (so it survives bundling and
// needs no filesystem access at runtime), but that makes it easy to bump
// package.json and forget version.ts — which silently ships a wrong --version.
// This guard reads the REAL package.json and fails the gates on any drift.
describe("VERSION", () => {
	test("matches the version in package.json", async () => {
		const pkgPath = join(import.meta.dir, "..", "package.json");
		const pkg = (await Bun.file(pkgPath).json()) as { version: string };
		expect(VERSION).toBe(pkg.version);
	});

	test("is a valid semver string", () => {
		expect(VERSION).toMatch(/^\d+\.\d+\.\d+(?:-[\w.]+)?$/);
	});
});
