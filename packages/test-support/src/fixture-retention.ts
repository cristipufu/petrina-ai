import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { writeFixtureJson } from "./fixture-json.js";

export const FIXTURE_JOURNAL = "PETRINA_TEST_FIXTURE_JOURNAL";
const HEADER = "journal.json";

/** File evidence for outer directory disposal; these records make no claim about process settlement. */
export type FixtureRetention = { kind: "clear" } | { kind: "retained"; roots: string[] } | { kind: "unknown"; error: unknown };

function header(folder: string): void {
  if (!isAbsolute(folder) || !lstatSync(folder).isDirectory()) throw new Error("Fixture journal must be a private directory");
  const file = join(folder, HEADER);
  if (!lstatSync(file).isFile()) throw new Error("Fixture journal header is unavailable");
  const value: unknown = JSON.parse(readFileSync(file, "utf8"));
  if (!value || typeof value !== "object" || Object.keys(value).length !== 1 || !("version" in value) || value.version !== 1)
    throw new Error("Fixture journal header is malformed");
}

export function createFixtureJournal(folder: string): void {
  mkdirSync(folder, { mode: 0o700 });
  writeFixtureJson(join(folder, HEADER), { version: 1 });
}

/** Publish ownership before setup or native admission; a publication failure must prevent that work. */
export function registerFixtureRoot(root: string, env: NodeJS.ProcessEnv = process.env): void {
  const folder = env[FIXTURE_JOURNAL];
  if (folder === undefined) return;
  if (!isAbsolute(root) || root.includes("\0")) throw new Error("Fixture root must be an absolute native path");
  header(folder);
  const name = createHash("sha256").update(root).digest("hex") + ".json";
  writeFixtureJson(join(folder, name), { version: 1, root });
}

/** Exact absence after the fixture's own cleanup discharges a record; access errors never do. */
export function fixtureRetention(folder: string): FixtureRetention {
  try {
    header(folder);
    const roots: string[] = [];
    for (const name of readdirSync(folder)) {
      if (name === HEADER) continue;
      const file = join(folder, name);
      if (!/^[a-f0-9]{64}\.json$/.test(name) || !lstatSync(file).isFile()) throw new Error("Fixture journal contains an incomplete record");
      const value: unknown = JSON.parse(readFileSync(file, "utf8"));
      if (!value || typeof value !== "object" || Object.keys(value).length !== 2 || !("version" in value) || value.version !== 1 ||
        !("root" in value) || typeof value.root !== "string" || !isAbsolute(value.root) || value.root.includes("\0") ||
        createHash("sha256").update(value.root).digest("hex") + ".json" !== name) throw new Error("Fixture journal root is malformed");
      try {
        lstatSync(value.root);
        roots.push(value.root);
      }
      catch (error) { if ((error as NodeJS.ErrnoException | undefined)?.code !== "ENOENT") throw error; }
    }
    return roots.length ? { kind: "retained", roots } : { kind: "clear" };
  } catch (error) { return { kind: "unknown", error }; }
}
