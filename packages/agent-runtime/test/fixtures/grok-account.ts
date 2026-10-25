import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "@petrina/test-support/fixtures";

export function server(plan: unknown) {
  const dir = tempDir("petrina-grok-usage-");
  writeFileSync(join(dir, "billing.json"), JSON.stringify(plan));
  const asked = () => existsSync(join(dir, "requests.jsonl")) ? readFileSync(join(dir, "requests.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line) as { pid: number; method: string }) : [];
  return { dir, asked, command: [process.execPath, join(import.meta.dir, "fake-grok-usage.ts"), dir] };
}
