import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "@petrina/test-support/fixtures";
import { readFixtureJsonLines } from "@petrina/test-support/fixture-json";
import type { CodexScript } from "./fake-codex.js";
const fakeCodex = join(import.meta.dir, "fake-codex.ts");

/** A folder with the fake app-server's script, and what it was asked. */
export function appServer(plan: CodexScript) {
  const dir = tempDir("petrina-codex-");
  writeFileSync(join(dir, "codex.json"), JSON.stringify(plan));
  const asked = () => readFixtureJsonLines<{ pid: number; method: string; params?: { clientInfo?: { name: string } } }>(join(dir, "codex.jsonl"));
  return { dir, command: [process.execPath, fakeCodex, dir], asked };
}
