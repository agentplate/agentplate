import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "./sqlite.ts";

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "agentplate-db-"));
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe("openDatabase", () => {
	test("opens a fresh DB with WAL", () => {
		const path = join(dir, "fresh.db");
		const db = openDatabase(path);
		const mode = db.query("PRAGMA journal_mode").get() as { journal_mode: string };
		expect(mode.journal_mode.toLowerCase()).toBe("wal");
		db.close();
	});

	test("guard leaves a compatible DB untouched", () => {
		const path = join(dir, "ok.db");
		// Seed a DB whose `runs` table HAS the required column.
		const seed = new Database(path, { create: true });
		seed.exec("CREATE TABLE runs (id TEXT PRIMARY KEY, created_at TEXT NOT NULL)");
		seed.exec("INSERT INTO runs (id, created_at) VALUES ('r1', 'now')");
		seed.close();

		const db = openDatabase(path, { guard: { table: "runs", columns: ["created_at"] } });
		const row = db.query("SELECT id FROM runs WHERE id = 'r1'").get() as { id: string } | null;
		expect(row?.id).toBe("r1"); // data preserved — no recreation
		db.close();
		// No backup file created.
		expect(readdirSync(dir).some((f) => f.includes("incompatible"))).toBe(false);
	});

	test("guard backs up and recreates an incompatible (foreign) DB", () => {
		const path = join(dir, "foreign.db");
		// Seed a DB shaped like the OTHER agentplate: `runs` has `started_at`,
		// not `created_at`.
		const seed = new Database(path, { create: true });
		seed.exec(
			"CREATE TABLE runs (id TEXT PRIMARY KEY, started_at TEXT NOT NULL, agent_count INTEGER)",
		);
		seed.exec("INSERT INTO runs (id, started_at, agent_count) VALUES ('old', 'then', 3)");
		seed.close();

		const db = openDatabase(path, { guard: { table: "runs", columns: ["created_at"] } });
		// The foreign `runs` table is gone; we can now create ours and insert.
		db.exec("CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, created_at TEXT NOT NULL)");
		db.exec("INSERT INTO runs (id, created_at) VALUES ('new', 'now')");
		const cols = db.query("PRAGMA table_info(runs)").all() as Array<{ name: string }>;
		expect(cols.map((c) => c.name)).toContain("created_at");
		// The old row is NOT present (fresh DB).
		const old = db.query("SELECT id FROM runs WHERE id = 'old'").get();
		expect(old).toBeNull();
		db.close();

		// A backup of the incompatible file exists.
		expect(readdirSync(dir).some((f) => f.startsWith("foreign.db.incompatible-"))).toBe(true);
	});

	test("guard ignores an absent table (fresh project)", () => {
		const path = join(dir, "empty.db");
		const db = openDatabase(path, { guard: { table: "runs", columns: ["created_at"] } });
		// No backup, no error — our CREATE TABLE will make it correctly.
		db.exec("CREATE TABLE runs (id TEXT PRIMARY KEY, created_at TEXT NOT NULL)");
		db.close();
		expect(readdirSync(dir).some((f) => f.includes("incompatible"))).toBe(false);
	});
});
