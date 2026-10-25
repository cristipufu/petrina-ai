import { impactRuntime } from "./impact-runtime.js";
// Optional single-file measurement. A recorded edge can only add a candidate, never remove one.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fingerprint, isTest, type CoverageMap } from "./impact.js";
import { inputs, recordedCoverage, ROOT } from "./repository.js";

import { coveredFiles } from "./coverage-records.js";
export { coveredFiles } from "./coverage-records.js";

if (import.meta.main) {
  const files = await inputs(ROOT);
  const file = process.argv[2]?.replaceAll("\\", "/");
  if (!file || !file.startsWith("packages/engine/test/") || !isTest(file) || !files.has(file)) throw new Error("Pass one exact engine test file relative to the repository root");
  const before = fingerprint(files, impactRuntime().identity);
  const folder = join(ROOT, ".test-results", `coverage-${crypto.randomUUID()}`);
  mkdirSync(folder, { recursive: true });
  const child = Bun.spawn([process.execPath, "run", "--cwd", "packages/engine", "test", join(ROOT, file), "--coverage", "--coverage-reporter=lcov", `--coverage-dir=${folder}`], { cwd: ROOT, stdin: "inherit", stdout: "inherit", stderr: "inherit" });
  const stop = () => child.kill("SIGTERM");
  process.on("SIGINT", stop); process.on("SIGTERM", stop);
  let code: number;
  try { code = await child.exited; }
  finally { process.off("SIGINT", stop); process.off("SIGTERM", stop); }
  if (code !== 0) process.exit(code);
  if (fingerprint(await inputs(ROOT), impactRuntime().identity) !== before) throw new Error("Inputs changed during coverage collection; no mapping was recorded");
  const existing = recordedCoverage(ROOT);
  const record: CoverageMap = { version: 1, fingerprint: before, tests: existing?.fingerprint === before ? existing.tests : {} };
  record.tests[file] = coveredFiles(readFileSync(join(folder, "lcov.info"), "utf8"), "packages/engine", ROOT).filter(path => files.has(path));
  const target = join(ROOT, ".test-results", "coverage-map.json"), temporary = `${target}.${crypto.randomUUID()}`;
  writeFileSync(temporary, JSON.stringify(record, null, 2)); renameSync(temporary, target);
  console.log(`Recorded ${record.tests[file]!.length} executed-file edges for ${file}. This does not authorize skipping tests.`);
}
