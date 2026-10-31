// One engine per Petrina folder. The engine, not the desktop shell, decides whether one is
// already running: either it holds the folder's lock, or the connection file points to an
// engine that answers (one started before the lock existed).

import { Database } from "bun:sqlite";
import { lstatSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** What scripts and the window need to reach an engine. Kept in engine.json, readable by this user only. */
export interface Connection {
  url: string;
  api: string;
  token: string;
  pid: number;
}

/** Only a missing process proves it exited; permission errors do not. */
export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

const TOKEN = /^[A-Za-z0-9_-]{16,128}$/;
const LOCAL = /^(ws|http):\/\/127\.0\.0\.1:\d{1,5}(\/ws)?$/;

/**
 * The folder's lock: an exclusive SQLite transaction on engine.lock. The operating system lets
 * go of it the moment the process ends, crash or forced kill included, on macOS, Windows and Linux.
 */
export class FolderLock {
  private constructor(private readonly db: Database) {}

  static take(home: string): FolderLock | undefined {
    const path = join(home, "engine.lock");
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const db = new Database(path, { create: true });
      try {
        db.run("PRAGMA busy_timeout = 0");
        db.run("BEGIN EXCLUSIVE");
        return new FolderLock(db);
      } catch (error) {
        db.close();
        // Anything but "locked" means the file is not a lock we know: start a new one.
        if (/locked|busy/i.test(String(error)) || attempt > 0) return undefined;
        rmSync(path, { force: true });
      }
    }
    return undefined;
  }

  release(): void {
    try {
      this.db.run("ROLLBACK");
    } catch {
      // Already rolled back.
    }
    this.db.close();
  }
}

export function connectionPath(home: string): string {
  return join(home, "engine.json");
}

export function readConnection(home: string): Connection | undefined {
  try {
    const raw = JSON.parse(readFileSync(connectionPath(home), "utf8")) as Partial<Connection>;
    if (typeof raw.url !== "string" || typeof raw.api !== "string" || typeof raw.token !== "string" || typeof raw.pid !== "number") return undefined;
    if (!LOCAL.test(raw.url) || !LOCAL.test(raw.api) || !TOKEN.test(raw.token)) return undefined;
    return { url: raw.url, api: raw.api, token: raw.token, pid: raw.pid };
  } catch {
    return undefined;
  }
}

/**
 * The key from the last run, so open windows reconnect after a restart. Only trusted from a
 * regular file (not a link) that this user owns and nobody else can read; otherwise a new one.
 */
export function previousToken(home: string): string | undefined {
  try {
    const info = lstatSync(connectionPath(home));
    const readableByOthers = process.platform !== "win32" && (info.mode & 0o077) !== 0;
    if (!info.isFile() || (process.getuid && info.uid !== process.getuid()) || readableByOthers) return undefined;
    const token = (JSON.parse(readFileSync(connectionPath(home), "utf8")) as { token?: unknown }).token;
    return typeof token === "string" && /^[A-Za-z0-9_-]{32}$/.test(token) ? token : undefined;
  } catch {
    return undefined;
  }
}

/** Written whole or not at all, so a script never reads half a file. */
export function writeConnection(home: string, connection: Connection): void {
  const path = connectionPath(home);
  const temporary = `${path}.${process.pid}.tmp`;
  const text = JSON.stringify(connection, null, 2);
  writeFileSync(temporary, text, { mode: 0o600 });
  try {
    renameSync(temporary, path);
  } catch {
    // Windows refuses to replace a file another program has open: write it in place.
    rmSync(temporary, { force: true });
    writeFileSync(path, text, { mode: 0o600 });
  }
}

/** Remove the connection file, but only while it still describes this engine. */
export function removeConnection(home: string, pid: number): void {
  if (readConnection(home)?.pid === pid) rmSync(connectionPath(home), { force: true });
}

/** Does an engine answer at this address, with this key? */
export async function answers(connection: Connection, timeoutMs = 1500): Promise<boolean> {
  const ask = (path: string) => fetch(
    `${connection.api}${path}`,
    {
    headers: { authorization: `Bearer ${connection.token}` },
    signal: AbortSignal.timeout(timeoutMs)
  }
  );
  try {
    const health = await ask("/api/health");
    if (health.ok) return true;
    // An engine from before this change has no health check, but knows its state.
    return health.status === 404 && (await ask("/api/state")).ok;
  } catch {
    return false;
  }
}

export type Claim = { kind: "free"; lock: FolderLock } | { kind: "running"; connection: Connection; locked: boolean } | { kind: "busy" };

/**
 * Take the folder, or find the engine that has it. An engine holding the lock may still be
 * starting, so give it `waitMs` to answer before calling the folder busy.
 */
export async function claimFolder(home: string, waitMs = 5000): Promise<Claim> {
  const deadline = Date.now() + waitMs;
  for (;;) {
    const lock = FolderLock.take(home);
    const connection = readConnection(home);
    if (lock) {
      if (connection && connection.pid !== process.pid && (await answers(connection))) {
        lock.release();
        return { kind: "running", connection, locked: false };
      }
      return { kind: "free", lock };
    }
    if (connection && (await answers(connection))) return { kind: "running", connection, locked: true };
    if (Date.now() > deadline) return { kind: "busy" };
    await Bun.sleep(200);
  }
}
