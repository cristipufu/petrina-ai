import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { State } from "@petrina/core";

/** The engine's state, kept in SQLite so tasks survive a restart. */
export class Store {
  private readonly db: Database;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new Database(path, { create: true });
    this.db.run("PRAGMA journal_mode = WAL");
    this.db.run("CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)");
  }

  load(): State | undefined {
    const row = this.db.query<{ value: string }, [string]>("SELECT value FROM kv WHERE key = ?").get("state");
    if (!row) return undefined;
    try {
      return JSON.parse(row.value) as State;
    } catch {
      return undefined;
    }
  }

  save(state: State): void {
    this.db.query("INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at").run("state", JSON.stringify(state), Date.now());
  }

  close(): void {
    this.db.close();
  }
}
