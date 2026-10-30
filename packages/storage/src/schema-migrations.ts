import type { Database } from "bun:sqlite";
import { existsSync, renameSync, rmSync } from "node:fs";

export const TARGET_SCHEMA_VERSION = 1;
export const CORRUPT_STATE_QUARANTINE_KEY = "corrupt_state_quarantine";

export interface SchemaMigration {
  readonly version: number;
  readonly name: string;
  readonly up: (db: Database) => void;
}

export interface AppliedSchemaMigration {
  readonly version: number;
  readonly name: string;
  readonly appliedAt: number;
}

export const MIGRATIONS: readonly SchemaMigration[] = [
  {
    version: 1,
    name: "baseline-core-schema",
    up: () => {
      // Core tables and history indexes are ensured idempotently inside the startup transaction.
    },
  },
];

export function preUpgradeBackupPath(dbPath: string, fromVersion: number): string {
  return `${dbPath}.v${fromVersion}.bak`;
}

export function readSchemaVersion(db: Database): number {
  return db.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version ?? 0;
}

export function readAppliedMigrations(db: Database): AppliedSchemaMigration[] {
  const table = db
    .query<{ ok: number }, []>(
      "SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations' LIMIT 1",
    )
    .get();
  if (!table) return [];
  return db
    .query<{ version: number; name: string; applied_at: number }, []>(
      "SELECT version, name, applied_at FROM schema_migrations ORDER BY version ASC",
    )
    .all()
    .map((row) => ({ version: row.version, name: row.name, appliedAt: row.applied_at }));
}

function validateMigrations(migrations: readonly SchemaMigration[], targetVersion: number): void {
  if (!Number.isSafeInteger(targetVersion) || targetVersion < 1) {
    throw new Error(`Target schema version must be a positive integer (received ${targetVersion}).`);
  }
  let previous = 0;
  for (const migration of migrations) {
    if (!Number.isSafeInteger(migration.version) || migration.version <= previous || migration.version > targetVersion) {
      throw new Error(
        `Schema migrations must use strictly ascending versions up to ${targetVersion} (invalid version ${migration.version}).`,
      );
    }
    previous = migration.version;
  }
}

function hasExistingUserTables(db: Database): boolean {
  return (
    db
      .query<{ ok: number }, []>(
        "SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' LIMIT 1",
      )
      .get() !== null
  );
}

export function prepareSchemaUpgrade(
  db: Database,
  dbPath: string,
  migrations: readonly SchemaMigration[] = MIGRATIONS,
  targetVersion = TARGET_SCHEMA_VERSION,
): { currentVersion: number; targetVersion: number; backupPath?: string } {
  validateMigrations(migrations, targetVersion);
  const currentVersion = readSchemaVersion(db);
  if (!Number.isSafeInteger(currentVersion) || currentVersion < 0) {
    throw new Error(`Saved data reports an invalid schema version (${currentVersion}).`);
  }
  if (currentVersion > targetVersion) {
    throw new Error(
      `Saved data uses newer schema version ${currentVersion}, while this version of Petrina supports up to ${targetVersion}.`,
    );
  }
  const inMemory = dbPath === ":memory:" || dbPath === "" || dbPath.startsWith("file::memory:");
  if (inMemory || currentVersion === targetVersion || !hasExistingUserTables(db)) {
    return { currentVersion, targetVersion };
  }
  const backupPath = preUpgradeBackupPath(dbPath, currentVersion);
  if (!existsSync(backupPath)) {
    const stagingPath = `${backupPath}.tmp-${process.pid}-${Date.now()}`;
    rmSync(stagingPath, { force: true });
    try {
      db.query("VACUUM INTO ?").run(stagingPath);
      if (!existsSync(backupPath)) renameSync(stagingPath, backupPath);
      else rmSync(stagingPath, { force: true });
    } catch (error) {
      rmSync(stagingPath, { force: true });
      throw error;
    }
  }
  return { currentVersion, targetVersion, backupPath };
}

export function applySchemaMigrations(
  db: Database,
  currentVersion: number,
  targetVersion: number,
  migrations: readonly SchemaMigration[] = MIGRATIONS,
): void {
  db.run(
    "CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL)",
  );
  const applied = new Set(
    db
      .query<{ version: number }, []>("SELECT version FROM schema_migrations")
      .all()
      .map((row) => row.version),
  );
  const now = Date.now();
  const record = db.query("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)");
  for (const migration of migrations) {
    if (migration.version > currentVersion && !applied.has(migration.version)) {
      migration.up(db);
      record.run(migration.version, migration.name, now);
    }
  }
  if (currentVersion < targetVersion) {
    db.run(`PRAGMA user_version = ${targetVersion}`);
  }
}
