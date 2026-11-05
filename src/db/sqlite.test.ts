import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, setSystemTime, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ValidationError } from "../errors.ts";
import { DEFAULT_LIST_LIMIT, type Migration, openDatabase, resolveLimit } from "./sqlite.ts";

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "agentplate-db-"));
});

afterEach(() => {
	setSystemTime(); // restore the real clock if a test froze it
	rmSync(dir, { recursive: true, force: true });
});

/** Main backup files (not their -wal/-shm sidecars) left by a heal of `name`. */
function backups(name: string): string[] {
	return readdirSync(dir).filter(
		(f) => f.startsWith(`${name}.incompatible-`) && !f.endsWith("-wal") && !f.endsWith("-shm"),
	);
}

/** Write a DB shaped like the OTHER agentplate: `runs` has `started_at`, not `created_at`. */
function seedForeign(path: string, rowId: string): Database {
	const seed = new Database(path, { create: true });
	seed.exec("PRAGMA journal_mode = WAL");
	seed.exec("DROP TABLE IF EXISTS runs");
	seed.exec(
		"CREATE TABLE runs (id TEXT PRIMARY KEY, started_at TEXT NOT NULL, agent_count INTEGER)",
	);
	seed.query("INSERT INTO runs (id, started_at, agent_count) VALUES (?, 'then', 3)").run(rowId);
	return seed;
}

const RUNS_GUARD = { table: "runs", columns: ["created_at"] };
const RUNS_MIGRATIONS: Migration[] = [
	{ version: 1, sql: "CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, created_at TEXT)" },
];

function userVersion(db: Database): number {
	return (db.query("PRAGMA user_version").get() as { user_version: number }).user_version;
}

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

describe("openDatabase self-heal (concurrency)", () => {
	test("a connection opened before the heal writes into the healed DB, not a stray backup", () => {
		const path = join(dir, "shared.db");
		seedForeign(path, "old").close();
		// Another process already has the file open (e.g. `ap serve` mid-snapshot).
		const early = new Database(path);
		try {
			const db = openDatabase(path, { guard: RUNS_GUARD, migrations: RUNS_MIGRATIONS });
			db.close();
			// The early handle must see the healed schema: a rename-based heal left
			// it pointing at the moved-away foreign file, so this insert failed (or
			// landed in a backup nobody reads).
			early.exec("INSERT INTO runs (id, created_at) VALUES ('from-early', 'now')");
		} finally {
			early.close();
		}

		const later = openDatabase(path, { guard: RUNS_GUARD, migrations: RUNS_MIGRATIONS });
		const ids = (later.query("SELECT id FROM runs").all() as Array<{ id: string }>).map(
			(r) => r.id,
		);
		later.close();
		expect(ids).toEqual(["from-early"]);
		expect(backups("shared.db")).toHaveLength(1); // healed exactly once
	});

	test("the backup holds the foreign data, including rows still in the WAL", () => {
		const path = join(dir, "walled.db");
		// Keep the seeding connection open so its rows stay in -wal (no checkpoint).
		const seed = seedForeign(path, "in-wal");
		try {
			openDatabase(path, { guard: RUNS_GUARD, migrations: RUNS_MIGRATIONS }).close();
		} finally {
			seed.close();
		}
		const [backup] = backups("walled.db");
		expect(backup).toBeDefined();
		const bak = new Database(join(dir, backup ?? ""), { readonly: true });
		const row = bak.query("SELECT id, started_at FROM runs").get();
		bak.close();
		expect(row).toEqual({ id: "in-wal", started_at: "then" });
	});

	test("two heals in the same millisecond never overwrite each other's backup", () => {
		const path = join(dir, "twice.db");
		setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
		seedForeign(path, "first").close();
		openDatabase(path, { guard: RUNS_GUARD }).close();
		seedForeign(path, "second").close();
		openDatabase(path, { guard: RUNS_GUARD }).close();

		const names = backups("twice.db");
		expect(names).toHaveLength(2);
		const ids = names
			.map((name) => {
				const bak = new Database(join(dir, name), { readonly: true });
				const row = bak.query("SELECT id FROM runs").get() as { id: string };
				bak.close();
				return row.id;
			})
			.sort();
		expect(ids).toEqual(["first", "second"]);
	});

	test("concurrent processes heal once and every process's write survives", async () => {
		const path = join(dir, "race.db");
		seedForeign(path, "old").close();
		const script = join(dir, "opener.ts");
		const sqliteModule = join(import.meta.dir, "sqlite.ts");
		writeFileSync(
			script,
			[
				`import { openDatabase } from ${JSON.stringify(sqliteModule)};`,
				"const [path, id] = process.argv.slice(2);",
				`const db = openDatabase(path, { guard: ${JSON.stringify(RUNS_GUARD)}, migrations: ${JSON.stringify(RUNS_MIGRATIONS)} });`,
				"db.query(\"INSERT INTO runs (id, created_at) VALUES (?, 'now')\").run(id);",
				"db.close();",
			].join("\n"),
		);
		const ids = ["p1", "p2", "p3", "p4", "p5", "p6"];
		const procs = ids.map((id) =>
			Bun.spawn([process.execPath, script, path, id], { stdout: "pipe", stderr: "pipe" }),
		);
		const codes = await Promise.all(procs.map((p) => p.exited));
		const errors = await Promise.all(procs.map((p) => new Response(p.stderr).text()));
		expect(errors.filter((e) => e.trim() !== "")).toEqual([]);
		expect(codes).toEqual(ids.map(() => 0));

		const db = openDatabase(path, { guard: RUNS_GUARD, migrations: RUNS_MIGRATIONS });
		const rows = db.query("SELECT id FROM runs ORDER BY id").all() as Array<{ id: string }>;
		db.close();
		expect(rows.map((r) => r.id)).toEqual(ids);
		expect(backups("race.db")).toHaveLength(1);
	});
});

describe("openDatabase migrations", () => {
	test("a fresh DB gets every step and user_version = newest", () => {
		const path = join(dir, "m.db");
		const db = openDatabase(path, {
			migrations: [
				{ version: 1, sql: "CREATE TABLE t (a TEXT)" },
				{ version: 2, sql: "ALTER TABLE t ADD COLUMN b TEXT" },
			],
		});
		const cols = db.query("PRAGMA table_info(t)").all() as Array<{ name: string }>;
		expect(cols.map((c) => c.name)).toEqual(["a", "b"]);
		expect(userVersion(db)).toBe(2);
		db.close();
	});

	test("reopening never re-runs applied steps; a newly appended step upgrades in place", () => {
		const path = join(dir, "up.db");
		// Non-idempotent SQL on purpose: a re-run would throw "already exists".
		const v1: Migration = { version: 1, sql: "CREATE TABLE t (a TEXT)" };
		const first = openDatabase(path, { migrations: [v1] });
		first.exec("INSERT INTO t (a) VALUES ('kept')");
		first.close();
		openDatabase(path, { migrations: [v1] }).close();

		const upgraded = openDatabase(path, {
			migrations: [v1, { version: 2, sql: "ALTER TABLE t ADD COLUMN b TEXT DEFAULT 'x'" }],
		});
		expect(upgraded.query("SELECT a, b FROM t").all()).toEqual([{ a: "kept", b: "x" }]);
		expect(userVersion(upgraded)).toBe(2);
		upgraded.close();
	});

	test("a pre-versioning DB (user_version 0, tables present) keeps its data", () => {
		const path = join(dir, "legacy.db");
		const seed = new Database(path, { create: true });
		seed.exec("CREATE TABLE runs (id TEXT PRIMARY KEY, created_at TEXT)");
		seed.exec("INSERT INTO runs VALUES ('r1', 'now')");
		seed.close();

		const db = openDatabase(path, { guard: RUNS_GUARD, migrations: RUNS_MIGRATIONS });
		expect(db.query("SELECT id FROM runs").all()).toEqual([{ id: "r1" }]);
		expect(userVersion(db)).toBe(1);
		db.close();
		expect(backups("legacy.db")).toHaveLength(0);
	});

	test("a failing step rolls the whole upgrade back", () => {
		const path = join(dir, "fail.db");
		expect(() =>
			openDatabase(path, {
				migrations: [
					{ version: 1, sql: "CREATE TABLE t (a TEXT)" },
					{ version: 2, sql: "THIS IS NOT SQL" },
				],
			}),
		).toThrow();
		const db = new Database(path);
		expect(userVersion(db)).toBe(0);
		expect(db.query("SELECT name FROM sqlite_master WHERE name = 't'").get()).toBeNull();
		db.close();
	});

	test("a DB from a newer version (higher user_version) is left alone", () => {
		const path = join(dir, "newer.db");
		const seed = new Database(path, { create: true });
		seed.exec("PRAGMA user_version = 9");
		seed.close();
		const db = openDatabase(path, { migrations: [{ version: 1, sql: "CREATE TABLE t (a TEXT)" }] });
		expect(userVersion(db)).toBe(9);
		expect(db.query("SELECT name FROM sqlite_master WHERE name = 't'").get()).toBeNull();
		db.close();
	});

	test("a foreign version stamp without our guarded table is healed, not trusted", () => {
		const path = join(dir, "stamped.db");
		const seed = new Database(path, { create: true });
		seed.exec("CREATE TABLE other_tool (x TEXT)");
		seed.exec("PRAGMA user_version = 42");
		seed.close();

		const db = openDatabase(path, { guard: RUNS_GUARD, migrations: RUNS_MIGRATIONS });
		const cols = db.query("PRAGMA table_info(runs)").all() as Array<{ name: string }>;
		expect(cols.map((c) => c.name)).toEqual(["id", "created_at"]);
		expect(userVersion(db)).toBe(1);
		expect(db.query("SELECT name FROM sqlite_master WHERE name = 'other_tool'").get()).toBeNull();
		db.close();
		expect(backups("stamped.db")).toHaveLength(1);
	});

	test("migrations apply to :memory: databases too", () => {
		const db = openDatabase(":memory:", {
			migrations: [{ version: 1, sql: "CREATE TABLE t (a)" }],
		});
		expect(userVersion(db)).toBe(1);
		db.close();
	});

	test("rejects out-of-order or non-positive versions", () => {
		const bad: Migration[][] = [
			[{ version: 0, sql: "SELECT 1" }],
			[
				{ version: 2, sql: "SELECT 1" },
				{ version: 1, sql: "SELECT 1" },
			],
			[
				{ version: 1, sql: "SELECT 1" },
				{ version: 1, sql: "SELECT 1" },
			],
			[{ version: 1.5, sql: "SELECT 1" }],
		];
		for (const migrations of bad) {
			expect(() => openDatabase(join(dir, "bad.db"), { migrations })).toThrow(ValidationError);
		}
	});
});

describe("resolveLimit", () => {
	test("undefined means no limit", () => {
		expect(resolveLimit(undefined)).toBeUndefined();
	});

	test("positive values pass through (truncated to an integer)", () => {
		expect(resolveLimit(1)).toBe(1);
		expect(resolveLimit(250)).toBe(250);
		expect(resolveLimit(2.9)).toBe(2);
	});

	test("0, negatives, NaN and Infinity fall back to the default, never to unlimited", () => {
		for (const bad of [0, -1, -500, 0.5, Number.NaN, Number.POSITIVE_INFINITY]) {
			expect(resolveLimit(bad)).toBe(DEFAULT_LIST_LIMIT);
		}
		expect(resolveLimit(Number.NaN, 7)).toBe(7);
	});
});
