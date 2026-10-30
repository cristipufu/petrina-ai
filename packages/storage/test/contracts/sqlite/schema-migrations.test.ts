import { Database } from "bun:sqlite";
import { afterAll, expect, it } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  CORRUPT_STATE_QUARANTINE_KEY,
  MIGRATIONS,
  preUpgradeBackupPath,
  readAppliedMigrations,
  readSchemaVersion,
  Store,
  TARGET_SCHEMA_VERSION,
  type SchemaMigration,
} from "@petrina/storage";
import { removeDir, tempDir } from "@petrina/test-support/fixtures";

const roots: string[] = [];
afterAll(() => roots.forEach(removeDir));

it("initializes a fresh database at TARGET_SCHEMA_VERSION without writing a pre-upgrade backup", () => {
  const root = tempDir("petrina-schema-fresh-");
  roots.push(root);
  const file = join(root, "petrina.db");
  const store = new Store(file);
  try {
    expect(readSchemaVersion(store.database)).toBe(TARGET_SCHEMA_VERSION);
    expect(readAppliedMigrations(store.database).map((entry) => ({ version: entry.version, name: entry.name }))).toEqual([
      { version: 1, name: "baseline-core-schema" },
    ]);
  } finally {
    store.close();
  }
  expect(readdirSync(root).some((name) => name.endsWith(".bak"))).toBe(false);
});

it("snapshots a pre-existing database via VACUUM INTO before upgrading and applies ordered migrations once", () => {
  const root = tempDir("petrina-schema-upgrade-");
  roots.push(root);
  const file = join(root, "sensitive-folder-name", "petrina.db");

  const legacy = new Store(file);
  legacy.database.run("CREATE TABLE legacy_notes (id TEXT PRIMARY KEY, body TEXT NOT NULL)");
  legacy.database.query("INSERT INTO legacy_notes VALUES (?, ?)").run("note-1", "saved before v2");
  legacy.database.run("DELETE FROM schema_migrations");
  legacy.database.run("PRAGMA user_version = 0");
  legacy.close();

  const migrations: readonly SchemaMigration[] = [
    ...MIGRATIONS,
    {
      version: 2,
      name: "add-legacy-notes-tag",
      up: (db) => {
        db.run("ALTER TABLE legacy_notes ADD COLUMN tag TEXT NOT NULL DEFAULT 'migrated'");
      },
    },
    {
      version: 3,
      name: "normalize-legacy-notes-tag",
      up: (db) => {
        db.run("UPDATE legacy_notes SET tag = 'v3'");
      },
    },
  ];

  const upgraded = new Store(file, { debugSql: true, migrations, targetVersion: 3 });
  try {
    expect(readSchemaVersion(upgraded.database)).toBe(3);
    expect(readAppliedMigrations(upgraded.database).map((entry) => entry.version)).toEqual([1, 2, 3]);
    expect(upgraded.database.query<{ id: string; body: string; tag: string }, []>("SELECT id, body, tag FROM legacy_notes").all()).toEqual([
      { id: "note-1", body: "saved before v2", tag: "v3" },
    ]);
  } finally {
    upgraded.close();
  }

  const backupFile = preUpgradeBackupPath(file, 0);
  expect(existsSync(backupFile)).toBe(true);
  const backupDb = new Database(backupFile, { readonly: true });
  try {
    expect(readSchemaVersion(backupDb)).toBe(0);
    expect(backupDb.query<{ id: string; body: string }, []>("SELECT id, body FROM legacy_notes").all()).toEqual([
      { id: "note-1", body: "saved before v2" },
    ]);
    expect(
      backupDb
        .query<{ name: string }, []>("PRAGMA table_info(legacy_notes)")
        .all()
        .map((column) => column.name),
    ).toEqual(["id", "body"]);
  } finally {
    backupDb.close();
  }

  const sqlLog = readFileSync(join(root, "sensitive-folder-name", "sql-executions.jsonl"), "utf8");
  expect(sqlLog).toContain('"sql":"VACUUM INTO ?"');
  expect(sqlLog).not.toContain("sensitive-folder-name");
});

it("rolls back a failing migration atomically while preserving the original pre-upgrade backup across retries", () => {
  const root = tempDir("petrina-schema-rollback-");
  roots.push(root);
  const file = join(root, "petrina.db");
  const base = new Store(file);
  base.database.run("CREATE TABLE items (name TEXT PRIMARY KEY)");
  base.database.query("INSERT INTO items VALUES (?)").run("before-upgrade");
  base.close();

  let shouldFail = true;
  const migrations: readonly SchemaMigration[] = [
    ...MIGRATIONS,
    {
      version: 2,
      name: "atomic-two-step",
      up: (db) => {
        db.query("INSERT INTO items VALUES (?)").run("partial-write");
        if (shouldFail) throw new Error("simulated migration failure");
      },
    },
  ];

  expect(() => new Store(file, { migrations, targetVersion: 2 })).toThrow("simulated migration failure");

  const backupFile = preUpgradeBackupPath(file, 1);
  expect(existsSync(backupFile)).toBe(true);
  const afterFailure = new Database(file);
  try {
    expect(readSchemaVersion(afterFailure)).toBe(1);
    expect(readAppliedMigrations(afterFailure).map((entry) => entry.version)).toEqual([1]);
    expect(afterFailure.query<{ name: string }, []>("SELECT name FROM items").all()).toEqual([{ name: "before-upgrade" }]);
    // Mutate live DB before retry to verify retry does not overwrite the original v1 backup.
    afterFailure.query("INSERT INTO items VALUES (?)").run("added-before-retry");
  } finally {
    afterFailure.close();
  }

  shouldFail = false;
  const recovered = new Store(file, { migrations, targetVersion: 2 });
  try {
    expect(readSchemaVersion(recovered.database)).toBe(2);
    expect(
      recovered.database
        .query<{ name: string }, []>("SELECT name FROM items ORDER BY name ASC")
        .all()
        .map((row) => row.name),
    ).toEqual(["added-before-retry", "before-upgrade", "partial-write"]);
  } finally {
    recovered.close();
  }

  const originalBackup = new Database(backupFile, { readonly: true });
  try {
    expect(originalBackup.query<{ name: string }, []>("SELECT name FROM items").all()).toEqual([{ name: "before-upgrade" }]);
  } finally {
    originalBackup.close();
  }
});

it("refuses to open a database written by a newer schema version", () => {
  const root = tempDir("petrina-schema-future-");
  roots.push(root);
  const file = join(root, "petrina.db");
  const store = new Store(file);
  store.database.run(`PRAGMA user_version = ${TARGET_SCHEMA_VERSION + 5}`);
  store.close();

  expect(() => new Store(file)).toThrow(`newer schema version ${TARGET_SCHEMA_VERSION + 5}`);
  expect(existsSync(preUpgradeBackupPath(file, TARGET_SCHEMA_VERSION + 5))).toBe(false);
});

it("quarantines corrupt kv.state JSON before recovering to a fresh board", () => {
  const root = tempDir("petrina-schema-quarantine-");
  roots.push(root);
  const file = join(root, "petrina.db");
  const store = new Store(file);
  store.database
    .query("INSERT INTO kv (key, value, updated_at) VALUES ('state', ?, 1)")
    .run("{corrupt-json-snapshot");
  expect(store.loadActive()).toBeUndefined();
  const quarantined = store.database
    .query<{ value: string }, [string]>("SELECT value FROM kv WHERE key = ?")
    .get(CORRUPT_STATE_QUARANTINE_KEY);
  expect(quarantined?.value).toBe("{corrupt-json-snapshot");
  store.close();
});
