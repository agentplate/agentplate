/**
 * `agentplate spec` command tests.
 *
 * Real temp `.agentplate/` tree (no mocks): a real `config.yaml` so
 * `isInitialized` passes, real filesystem reads/writes. The action functions
 * resolve the project root via `findProjectRoot()`, which honors
 * `setProjectRootOverride`, so each test points Agentplate at its own temp root
 * and drives the exported `run*` functions directly. `resolveSpecBody` takes an
 * injected stdin reader so the `--stdin` path needs no real pipe.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	AGENTPLATE_DIR,
	CONFIG_FILE,
	DEFAULT_CONFIG,
	serializeConfig,
	setProjectRootOverride,
} from "../config.ts";
import { NotFoundError, ValidationError } from "../errors.ts";
import { specPath } from "../paths.ts";
import { resolveSpecBody, runList, runShow, runWrite } from "./spec.ts";

let root: string;

function initRoot(): string {
	const dir = mkdtempSync(join(tmpdir(), "agentplate-spec-cmd-"));
	mkdirSync(join(dir, AGENTPLATE_DIR), { recursive: true });
	writeFileSync(join(dir, AGENTPLATE_DIR, CONFIG_FILE), serializeConfig(DEFAULT_CONFIG), "utf8");
	return dir;
}

/** Capture everything written to stdout while `fn` runs (awaits async `fn`). */
async function captureStdout(fn: () => void | Promise<void>): Promise<string> {
	const original = process.stdout.write.bind(process.stdout);
	let out = "";
	process.stdout.write = (chunk: string | Uint8Array): boolean => {
		out += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
		return true;
	};
	try {
		await fn();
	} finally {
		process.stdout.write = original;
	}
	return out;
}

/** Run `fn`, capture its stdout, and parse the single JSON envelope it prints. */
async function captureJson(fn: () => void | Promise<void>): Promise<{ data: unknown }> {
	return JSON.parse((await captureStdout(fn)).trim());
}

beforeEach(() => {
	root = initRoot();
	setProjectRootOverride(root);
});

afterEach(() => {
	setProjectRootOverride(null);
	rmSync(root, { recursive: true, force: true });
});

describe("resolveSpecBody", () => {
	test("throws when no body source is given", async () => {
		await expect(resolveSpecBody({})).rejects.toBeInstanceOf(ValidationError);
	});

	test("throws when more than one source is given", async () => {
		await expect(resolveSpecBody({ body: "x", stdin: true })).rejects.toBeInstanceOf(
			ValidationError,
		);
	});

	test("returns the inline --body", async () => {
		expect(await resolveSpecBody({ body: "Goal: ship it" })).toBe("Goal: ship it");
	});

	test("reads --stdin via the injected reader", async () => {
		expect(await resolveSpecBody({ stdin: true }, async () => "from stdin")).toBe("from stdin");
	});

	test("reads --file from disk", async () => {
		const f = join(root, "contract.md");
		writeFileSync(f, "Goal: from file", "utf8");
		expect(await resolveSpecBody({ file: f })).toBe("Goal: from file");
	});

	test("throws when --file does not exist", async () => {
		await expect(resolveSpecBody({ file: join(root, "nope.md") })).rejects.toBeInstanceOf(
			ValidationError,
		);
	});

	test("refuses a blank body", async () => {
		await expect(resolveSpecBody({ body: "   \n  " })).rejects.toBeInstanceOf(ValidationError);
	});
});

describe("spec write", () => {
	test("writes the spec to the canonical path with a trailing newline", async () => {
		await runWrite("task-a", { body: "Goal: A" }, false);
		const path = specPath(root, "task-a");
		expect(existsSync(path)).toBe(true);
		expect(readFileSync(path, "utf8")).toBe("Goal: A\n");
	});

	test("reports created then updated, and overwrites content", async () => {
		const created = await captureJson(() => runWrite("task-b", { body: "v1" }, true));
		expect((created.data as { action: string }).action).toBe("created");
		const updated = await captureJson(() => runWrite("task-b", { body: "v2" }, true));
		expect((updated.data as { action: string }).action).toBe("updated");
		expect(readFileSync(specPath(root, "task-b"), "utf8")).toBe("v2\n");
	});

	test("refuses an empty body (never writes a blank contract)", async () => {
		await expect(runWrite("task-c", { body: "  " }, false)).rejects.toBeInstanceOf(ValidationError);
		expect(existsSync(specPath(root, "task-c"))).toBe(false);
	});
});

describe("spec show / list", () => {
	test("show throws NotFoundError when the spec is absent", () => {
		expect(() => runShow("ghost", false)).toThrow(NotFoundError);
	});

	test("show prints the stored body", async () => {
		await runWrite("task-d", { body: "Goal: D" }, false);
		expect(await captureStdout(() => runShow("task-d", false))).toContain("Goal: D");
	});

	test("list returns every task id that has a spec (json, sorted)", async () => {
		await runWrite("beta", { body: "b" }, false);
		await runWrite("alpha", { body: "a" }, false);
		const out = await captureJson(() => runList(true));
		const ids = (out.data as Array<{ taskId: string }>).map((r) => r.taskId);
		expect(ids).toEqual(["alpha", "beta"]);
	});
});
