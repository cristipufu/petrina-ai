// The required command always runs every workspace. Selection is measured, never used to skip tests.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { conventions, inputs, observe, recordedCoverage, ROOT } from "./repository.js";
import { fingerprint, impactPlan, WORKSPACES } from "./impact.js";
import { failedFiles } from "./results.js";

const errors = conventions(inputs(ROOT));
if (errors.length) { console.error(errors.join("\n")); process.exit(1); }
const folder = join(ROOT, ".test-results", `${new Date().toISOString().replace(/[:.]/g, "-")}-${crypto.randomUUID().slice(0, 8)}`);
mkdirSync(folder, { recursive: true });
let plan: ReturnType<typeof observe> | ReturnType<typeof impactPlan>;
try { plan = observe(ROOT, process.env.PETRINA_TEST_BASE, recordedCoverage(ROOT)); }
catch (error) {
  const files = inputs(ROOT);
  plan = impactPlan(files, ["unknown-base"]);
  plan.reasons.push(error instanceof Error ? error.message : String(error));
}
writeFileSync(join(folder, "impact.json"), JSON.stringify(plan, null, 2));
console.log(`Affected-test observation: ${plan.selected.length}/${plan.total} candidates; the full suite still runs. Reports: ${relative(ROOT, folder)}`);
const results: { workspace: string; code: number; ms: number; failures?: string[]; missedFailures?: string[]; error?: string }[] = [];
let child: ReturnType<typeof Bun.spawn> | undefined;
let interrupted: number | undefined;
const interrupt = (signal: "SIGINT" | "SIGTERM", code: number) => { interrupted = code; child?.kill(signal); };
const onInt = () => interrupt("SIGINT", 130), onTerm = () => interrupt("SIGTERM", 143);
process.on("SIGINT", onInt); process.on("SIGTERM", onTerm);
try {
  for (const workspace of WORKSPACES) {
    if (interrupted) break;
    const engine = workspace === "packages/engine";
    const output = join(folder, `${workspace.split("/").at(-1)}.${engine ? "xml" : "json"}`);
    const reporter = engine ? ["--reporter=junit", `--reporter-outfile=${output}`] : ["--reporter=json", `--outputFile=${output}`];
    const start = performance.now();
    child = Bun.spawn([process.execPath, "run", "--cwd", workspace, "test", ...reporter], { cwd: ROOT, stdin: "inherit", stdout: "inherit", stderr: "inherit" });
    const code = await child.exited;
    const result: typeof results[number] = { workspace, code, ms: Math.round(performance.now() - start) };
    try {
      result.failures = failedFiles(readFileSync(output, "utf8"), workspace, engine ? "bun" : "vitest", ROOT);
      result.missedFailures = result.failures.filter(file => !plan.selected.includes(file));
      if (code !== 0 && !result.failures.length) result.error = "Run failed without an attributable test file; selection accuracy is unknown";
    } catch (error) { result.error = `Selection accuracy unavailable: ${error instanceof Error ? error.message : String(error)}`; }
    if (result.error) console.error(`${workspace}: ${result.error}`);
    else if (code === 0 && result.failures?.length) console.error(`${workspace}: structured results report failed files despite a zero exit code: ${result.failures.join(", ")}`);
    results.push(result);
    child = undefined;
  }
} finally {
  process.off("SIGINT", onInt); process.off("SIGTERM", onTerm);
  const stable = fingerprint(inputs(ROOT)) === plan.fingerprint;
  writeFileSync(join(folder, "results.json"), JSON.stringify({ mode: "observation", stableInputs: stable, interrupted, results }, null, 2));
  if (!stable) console.error("Test inputs changed during the full run. Results cannot authorize delivery.");
  process.exitCode = interrupted ?? (stable && results.length === WORKSPACES.length && results.every(result => result.code === 0 && !result.error && !result.failures?.length) ? 0 : 1);
}
