import { afterAll, expect, it } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { tempDir, removeDir } from "@petrina/test-support/fixtures";
import { runCommand } from "@petrina/test-support/commands";

const cli = fileURLToPath(import.meta.resolve("../../quality/resources.ts"));
const roots: string[] = [];
afterAll(() => roots.forEach(removeDir));
it("prints profiler help without beginning a full suite", async () => {
  const result = await runCommand([process.execPath, cli, "--help"]);
  expect(result.code).toBe(0); expect(result.stdout).toContain("--report DIR");
  expect(result.stdout).not.toContain("Affected-test observation:");
});
it("rejects an empty event file instead of manufacturing a zero-cost report", async () => {
  const cwd = tempDir("petrina-resource-report-"); roots.push(cwd);
  const events = join(cwd, "events"); mkdirSync(events); writeFileSync(join(events, "events-empty.jsonl"), "");
  const result = await runCommand([process.execPath, cli, "--report", events]);
  expect(result.code).toBe(1); expect(result.stderr).toContain("No valid resource case evidence");
  expect(result.stdout).not.toContain("Observed launch calls:");
});
