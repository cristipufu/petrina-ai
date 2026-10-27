import { randomUUID } from "node:crypto";
import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";

/** Read completed fixture records while a child may still be appending the last line. */
export function readFixtureJsonLines<T = unknown>(path: string): T[] {
  let body: string;
  try { body = readFileSync(path, "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") return []; throw error; }
  const end = body.lastIndexOf("\n");
  if (end < 0) return [];
  // A complete malformed record must fail; only the not-yet-terminated tail is pending.
  return body.slice(0, end).split("\n").map(line => JSON.parse(line) as T);
}

/** Publish complete fixture configuration to live child readers, preserving the old file on failure. */
export function writeFixtureJson(path: string, value: unknown, spaces?: number): void {
  const body = JSON.stringify(value, null, spaces);
  if (body === undefined) throw new Error("Fixture configuration must be a JSON value.");
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, body, { flag: "wx", mode: 0o600 });
    renameSync(temporary, path);
  } finally { rmSync(temporary, { force: true }); }
}
