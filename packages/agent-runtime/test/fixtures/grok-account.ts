import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "@petrina/test-support/fixtures";
import { readFixtureJsonLines } from "@petrina/test-support/fixture-json";

export function server(plan: unknown) {
  const dir = tempDir("petrina-grok-usage-");
  writeFileSync(join(dir, "billing.json"), JSON.stringify(plan));
  const asked = () => readFixtureJsonLines<{ pid: number; method: string }>(join(dir, "requests.jsonl"));
  return { dir, asked, command: [process.execPath, join(import.meta.dir, "fake-grok-usage.ts"), dir] };
}
