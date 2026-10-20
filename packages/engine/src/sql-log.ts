import type { Database } from "bun:sqlite";
import { closeSync, fstatSync, openSync, renameSync, rmSync, writeSync } from "node:fs";
import { join } from "node:path";

/** One complete JSON record per line; rotation preserves whole executions, including large SQL. */
class RotatingLog {
  private fd: number;
  private size: number;

  constructor(private readonly path: string, private readonly maxBytes: number, private readonly files: number) {
    this.fd = openSync(path, "a", 0o600);
    try { this.size = fstatSync(this.fd).size; }
    catch (error) { closeSync(this.fd); throw error; }
  }

  write(record: object): void {
    const line = Buffer.from(`${JSON.stringify(record)}\n`);
    if (this.size && this.size + line.length > this.maxBytes) {
      closeSync(this.fd);
      this.fd = -1;
      if (this.files === 1) rmSync(this.path, { force: true });
      else {
        rmSync(`${this.path}.${this.files - 1}`, { force: true });
        for (let index = this.files - 2; index >= 0; index--) {
          try { renameSync(index ? `${this.path}.${index}` : this.path, `${this.path}.${index + 1}`); }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
        }
      }
      this.fd = openSync(this.path, "a", 0o600);
      this.size = 0;
    }
    let written = 0;
    while (written < line.length) {
      const bytes = writeSync(this.fd, line, written, line.length - written);
      if (!bytes) throw new Error("The SQL debug log could not be written.");
      written += bytes;
      this.size += bytes;
    }
  }

  close(): void {
    if (this.fd < 0) return;
    const fd = this.fd;
    this.fd = -1;
    closeSync(fd);
  }
}

/** Debug only. Bindings, rows, expanded statements and error messages never enter this log. */
export class SqlExecutionLog {
  private readonly queries: RotatingLog;
  private readonly transactions: RotatingLog;
  private enabled = true;
  private transactionDepth = 0;

  constructor(folder: string, options: { maxBytes?: number; files?: number } = {}) {
    const maxBytes = options.maxBytes ?? 10 * 1024 * 1024, files = options.files ?? 5;
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || !Number.isSafeInteger(files) || files < 1) throw new Error("SQL log rotation needs positive byte and file limits.");
    this.queries = new RotatingLog(join(folder, "sql-executions.jsonl"), maxBytes, files);
    try { this.transactions = new RotatingLog(join(folder, "sql-transactions.jsonl"), maxBytes, files); }
    catch (error) { this.queries.close(); throw error; }
  }

  execution<T>(sql: string, call: () => T): T {
    if (!this.enabled) return call();
    const at = new Date().toISOString(), start = performance.now();
    try { return call(); }
    finally { this.record(this.queries, { sql, ms: performance.now() - start, at }); }
  }

  *iterate<T>(sql: string, create: () => IterableIterator<T>): Generator<T, unknown, unknown> {
    if (!this.enabled) return yield* create();
    const at = new Date().toISOString();
    const iterator = create();
    let ms = 0;
    try {
      for (;;) {
        let next: IteratorResult<T, unknown>;
        const start = performance.now();
        try { next = iterator.next(); }
        finally { ms += performance.now() - start; }
        if (next.done) return next.value;
        yield next.value;
      }
    } finally {
      const start = performance.now();
      try { iterator.return?.(); }
      finally {
        ms += performance.now() - start;
        this.record(this.queries, { sql, ms, at });
      }
    }
  }

  transaction<T>(mode: string, call: () => T): T {
    if (!this.enabled) return call();
    const outer = this.transactionDepth++ === 0, at = new Date().toISOString(), start = performance.now();
    try { return call(); }
    finally {
      this.transactionDepth--;
      // Nested savepoints belong to their outer transaction, never a second inclusive total.
      if (outer) this.record(this.transactions, { transaction: mode, ms: performance.now() - start, at });
    }
  }

  private record(log: RotatingLog, record: object): void {
    if (!this.enabled) return;
    try { log.write(record); }
    catch {
      this.close();
      console.error(`${new Date().toISOString()} SQL debug logging stopped: its log could not be written. No further executions will be recorded; fix log storage and restart with --debug-sql.`);
    }
  }

  close(): void {
    this.enabled = false;
    for (const log of [this.queries, this.transactions]) { try { log.close(); } catch { /* Logging must not change a query's result or original error. */ } }
  }
}

/** Wrap this connection, not global SQLite prototypes. Cached statements retain their identity. */
export function logSqlExecutions(db: Database, log: SqlExecutionLog): void {
  const statements = new WeakSet<object>();
  for (const factory of ["query", "prepare"] as const) {
    const original = db[factory];
    Object.defineProperty(db, factory, { configurable: true, writable: true, value: function(this: Database, ...args: Parameters<Database["prepare"]>) {
      const statement = Reflect.apply(original, this, args);
      if (!statements.has(statement)) {
        statements.add(statement);
        const sql = args[0];
        for (const method of ["get", "all", "run", "values", "raw"] as const) {
          const execute = statement[method];
          statement[method] = function(this: object, ...params: unknown[]) { return log.execution(sql, () => Reflect.apply(execute, this, params)); };
        }
        const iterate = statement.iterate;
        statement.iterate = function(this: object, ...params: unknown[]) { return log.iterate(sql, () => Reflect.apply(iterate, this, params) as IterableIterator<unknown>); };
        const iterator = statement[Symbol.iterator];
        statement[Symbol.iterator] = function(this: object) { return log.iterate(sql, () => Reflect.apply(iterator, this, []) as IterableIterator<unknown>); };
      }
      return statement;
    } });
  }
  // These execute directly in Bun; they do not call the public statement methods above.
  for (const method of ["run", "exec"] as const) {
    const execute = db[method];
    Object.defineProperty(db, method, { configurable: true, writable: true, value: function(this: Database, sql: string, ...params: unknown[]) {
      return log.execution(sql, () => Reflect.apply(execute, this, [sql, ...params]));
    } });
  }
  const transaction = db.transaction;
  Object.defineProperty(db, "transaction", { configurable: true, writable: true, value: function(this: Database, ...args: Parameters<Database["transaction"]>) {
    const native = Reflect.apply(transaction, this, args);
    const modes = ["default", "deferred", "immediate", "exclusive"] as const;
    const wrapped = Object.fromEntries(modes.map(mode => [mode, function(this: unknown, ...params: unknown[]) {
      return log.transaction(mode, () => Reflect.apply(mode === "default" ? native : native[mode], this, params));
    }]));
    const properties: PropertyDescriptorMap = Object.fromEntries(modes.map(mode => [mode, { value: wrapped[mode] }]));
    properties.database = { value: this, enumerable: true };
    for (const mode of modes) Object.defineProperties(wrapped[mode]!, properties);
    return wrapped.default;
  } });
  const close = db.close;
  db.close = function(...args: Parameters<Database["close"]>) {
    const result = Reflect.apply(close, this, args);
    log.close();
    return result;
  };
}
