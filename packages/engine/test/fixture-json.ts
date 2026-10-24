import { randomUUID } from "node:crypto";
import { renameSync, rmSync, writeFileSync } from "node:fs";

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
