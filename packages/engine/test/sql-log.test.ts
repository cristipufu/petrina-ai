import { afterAll, expect, it, spyOn } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Store } from "../src/store.js";
import { WorkLog } from "../src/worklog.js";
import { logSqlExecutions, SqlExecutionLog } from "../src/sql-log.js";
import { removeDir, tempDir } from "./support.js";

const root = tempDir("petrina-sql-log-");
afterAll(() => removeDir(root));
function folder(name: string): string { const path = join(root, name); mkdirSync(path); return path; }
type Entry = { sql: string; ms: number; at: string };
const entries = (path: string, file = "sql-executions.jsonl"): Entry[] => readFileSync(join(path, file), "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line));

it("times executions of cached and explicitly prepared statements without recording bindings, rows or expanded SQL", () => {
  const path = folder("statements"), store = new Store(join(path, "petrina.db"), { debugSql: true });
  try {
    const db = store.database;
    db.run("CREATE TABLE sample (value TEXT UNIQUE)");
    const insert = db.query("INSERT INTO sample VALUES (?)");
    insert.run("secret-one"); insert.run("secret-two");
    expect(db.query("INSERT INTO sample VALUES (?)")).toBe(insert);
    expect(() => insert.run("secret-one")).toThrow();
    const select = db.prepare<{ value: string }, string[]>("SELECT value FROM sample WHERE value = ?", ["secret-one"]);
    expect(select.get()?.value).toBe("secret-one");
    expect(select.get("secret-two")?.value).toBe("secret-two");
    expect(select.all("secret-one")).toEqual([{ value: "secret-one" }]);
    expect(select.values("secret-one")).toEqual([["secret-one"]]);
    expect(new TextDecoder().decode(select.raw("secret-one")[0]![0]!)).toBe("secret-one");
    db.run("INSERT INTO sample VALUES (?)", ["secret-three"]);
    db.exec("DELETE FROM sample WHERE value = ?", ["secret-three"]);
    const log = entries(path);
    expect(log.filter(row => row.sql === "INSERT INTO sample VALUES (?)")).toHaveLength(4);
    expect(log.filter(row => row.sql === "SELECT value FROM sample WHERE value = ?")).toHaveLength(5);
    expect(log.filter(row => row.sql === "DELETE FROM sample WHERE value = ?")).toHaveLength(1);
    expect(readFileSync(join(path, "sql-executions.jsonl"), "utf8")).not.toContain("secret-");
    for (const row of log) {
      expect(Object.keys(row)).toEqual(["sql", "ms", "at"]);
      expect(Number.isFinite(row.ms) && row.ms >= 0).toBe(true);
      expect(new Date(row.at).toISOString()).toBe(row.at);
    }
  } finally { store.close(); }
});

it("keeps transaction totals separate, preserves variants and receiver, and logs rollback executions", () => {
  const path = folder("transactions"), db = new Database(":memory:");
  logSqlExecutions(db, new SqlExecutionLog(path));
  try {
    db.exec("CREATE TABLE sample(value TEXT)");
    const nested = db.transaction(() => db.query("SELECT 1 AS nested").get());
    const owner = { value: "private" };
    const transaction = db.transaction(function(this: typeof owner, value: string) {
      expect(this).toBe(owner);
      db.query("INSERT INTO sample VALUES (?)").run(value);
      nested();
      return 42;
    });
    expect(transaction.immediate.call(owner, owner.value)).toBe(42);
    const exposed = transaction as typeof transaction & { default: typeof transaction; database: Database };
    expect(exposed.database).toBe(db);
    expect(exposed.default).toBe(transaction);
    expect((transaction.immediate as typeof exposed).deferred).toBe(transaction.deferred);
    expect(db.transaction(() => { db.query("SELECT 2 AS deferred").get(); }).deferred()).toBeUndefined();
    const problem = new Error("private-error");
    expect(() => db.transaction(() => { db.query("INSERT INTO sample VALUES (?)").run("private-rollback"); throw problem; }).exclusive()).toThrow(problem);
    expect(db.query("SELECT count(*) AS count FROM sample").get()).toEqual({ count: 1 });
    const totals = entries(path, "sql-transactions.jsonl") as unknown as { transaction: string; ms: number; at: string }[];
    expect(totals.map(row => row.transaction)).toEqual(["immediate", "deferred", "exclusive"]);
    expect(totals.every(row => !("sql" in row) && row.ms >= 0)).toBe(true);
    expect(entries(path).filter(row => row.sql === "SELECT 1 AS nested")).toHaveLength(1);
    expect(entries(path).filter(row => row.sql === "INSERT INTO sample VALUES (?)")).toHaveLength(2);
    expect(readFileSync(join(path, "sql-transactions.jsonl"), "utf8")).not.toContain("private");
  } finally { db.close(); }
});

it("records history iterators once on completion or early close, without counting the consumer's work", () => {
  const path = folder("iterators"), db = new Database(":memory:");
  logSqlExecutions(db, new SqlExecutionLog(path));
  const clock = spyOn(performance, "now");
  let now = 0; clock.mockImplementation(() => now);
  try {
    const sql = "SELECT 1 AS value UNION ALL SELECT 2", statement = db.query(sql);
    const unused = statement.iterate();
    expect(entries(path)).toHaveLength(0);
    unused.return?.();
    for (const row of statement.iterate()) { expect(row).toBeDefined(); now += 10_000; }
    for (const _row of statement.iterate()) { now += 10_000; break; }
    expect([...db.prepare(sql)]).toHaveLength(2);
    expect(entries(path).map(row => ({ sql: row.sql, ms: row.ms }))).toEqual([{ sql, ms: 0 }, { sql, ms: 0 }, { sql, ms: 0 }]);
    expect(db.query("SELECT 3").get()).toEqual({ "3": 3 });
  } finally { clock.mockRestore(); db.close(); }
});

it("logs history and work-log operations through Store's shared connection and stays off by default", () => {
  const path = folder("shared"), store = new Store(join(path, "petrina.db"), { debugSql: true });
  const work = new WorkLog(store.database);
  try {
    work.addMoment({ id: "sensitive-moment", at: 1, kind: "stage-start", taskId: "sensitive-task", productId: "sensitive-product" });
    expect(work.moments({ taskId: "sensitive-task" })).toHaveLength(1);
    store.history.get("sensitive-missing-task");
    const log = entries(path);
    expect(log.some(row => row.sql.startsWith("INSERT INTO work_moments"))).toBe(true);
    expect(log.some(row => row.sql.includes("FROM task_history"))).toBe(true);
    expect(readFileSync(join(path, "sql-executions.jsonl"), "utf8")).not.toContain("sensitive-");
  } finally { work.close(); store.close(); }
  const off = folder("off"), disabled = new Store(join(off, "petrina.db"));
  try { disabled.database.query("SELECT 1").get(); } finally { disabled.close(); }
  expect(readdirSync(off).filter(name => name.endsWith("jsonl"))).toEqual([]);
});

it("rotates complete JSON lines, bounds retained files, and appends across restarts", () => {
  const path = folder("rotation");
  const open = () => { const db = new Database(":memory:"); logSqlExecutions(db, new SqlExecutionLog(path, { maxBytes: 120, files: 3 })); return db; };
  let db = open();
  for (let index = 0; index < 8; index++) db.query(`SELECT ${index} AS value`).get();
  db.close();
  db = open(); db.query("SELECT 8 AS value").get(); db.close();
  const files = readdirSync(path).filter(name => name.startsWith("sql-executions.jsonl"));
  expect(files.sort()).toEqual(["sql-executions.jsonl", "sql-executions.jsonl.1", "sql-executions.jsonl.2"]);
  const log = [...files].sort().reverse().flatMap(file => entries(path, file));
  expect(log.map(row => row.sql)).toEqual(["SELECT 6 AS value", "SELECT 7 AS value", "SELECT 8 AS value"]);
  const size = readFileSync(join(path, "sql-executions.jsonl"), "utf8").length;
  db = open(); db.close();
  expect(readFileSync(join(path, "sql-executions.jsonl"), "utf8").length).toBe(size);
});

it("stops logging visibly after an IO failure without changing SQL results or errors", () => {
  const path = folder("write-failure"), db = new Database(":memory:");
  const log = new SqlExecutionLog(path, { maxBytes: 1 }); logSqlExecutions(db, log);
  const warning = spyOn(console, "error").mockImplementation(() => {});
  try {
    db.query("SELECT 1").get();
    mkdirSync(join(path, "sql-executions.jsonl.4"));
    expect(db.query("SELECT 2").get()).toEqual({ "2": 2 });
    expect(db.query("SELECT 3").get()).toEqual({ "3": 3 });
    expect(warning).toHaveBeenCalledTimes(1);
    expect(String(warning.mock.calls[0]?.[0])).toContain("SQL debug logging stopped");
    expect(() => db.run("not valid SQL")).toThrow();
  } finally { warning.mockRestore(); db.close(); }
  expect(existsSync(join(path, "sql-transactions.jsonl"))).toBe(true);
});

it("keeps an oversized SQL record whole and supports retaining just the current file", () => {
  const path = folder("single-file"), db = new Database(":memory:");
  logSqlExecutions(db, new SqlExecutionLog(path, { maxBytes: 80, files: 1 }));
  try {
    const sql = `SELECT ? AS value /* ${"large-template".repeat(100)} */`;
    expect(db.query(sql).get("private-binding")).toEqual({ value: "private-binding" });
    expect(entries(path).map(row => row.sql)).toEqual([sql]);
    db.query("SELECT 2").get();
    expect(entries(path).map(row => row.sql)).toEqual(["SELECT 2"]);
    expect(readdirSync(path).some(name => name.endsWith(".1"))).toBe(false);
  } finally { db.close(); }
});
