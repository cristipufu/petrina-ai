// The required command passes only when every workspace runs and passes. The quick suites run first, all
// of them even after a failure, and the long engine suite starts only after they pass; otherwise it is
// recorded as not run. Selection is measured, never used to skip tests.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { conventions, inputs, observe, recordedCoverage, ROOT } from "./repository.js";
import { fingerprint, impactPlan, WORKSPACES } from "./impact.js";
import { failedFiles } from "./results.js";

const PRELIMINARY: readonly string[] = ["packages/core", "apps/desktop"];
const ORDER = [...PRELIMINARY, ...WORKSPACES.filter(workspace => !PRELIMINARY.includes(workspace))];
const suite = (workspace: string) => workspace.split("/").at(-1)!;
type Ran = { workspace: string; code: number; ms: number; failures?: string[]; missedFailures?: string[]; error?: string };
type Result = Ran | { workspace: string; notRun: string };
const passed = (result: Result) => "code" in result && result.code === 0 && !result.error && !result.failures?.length;

const errors = conventions(inputs(ROOT));
if (errors.length) { console.error(errors.join("\n")); process.exit(1); }
const began = performance.now();
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
console.log(`Affected-test observation: ${plan.selected.length}/${plan.total} candidates; it never changes which tests run. Order: ${PRELIMINARY.map(suite).join(" and ")}, then ${ORDER.slice(PRELIMINARY.length).map(suite).join(" and ")} only if they pass. Reports: ${relative(ROOT, folder)}`);
const results: Result[] = [];
let child: ReturnType<typeof Bun.spawn> | undefined;
let interrupted: number | undefined;
let finished = false;
const interrupt = (signal: "SIGINT" | "SIGTERM", code: number) => { interrupted = code; child?.kill(signal); };
const onInt = () => interrupt("SIGINT", 130), onTerm = () => interrupt("SIGTERM", 143);
process.on("SIGINT", onInt); process.on("SIGTERM", onTerm);
try {
  for (const workspace of ORDER) {
    if (interrupted) break;
    if (!PRELIMINARY.includes(workspace) && !results.filter(result => PRELIMINARY.includes(result.workspace)).every(passed)) {
      results.push({ workspace, notRun: `${PRELIMINARY.map(suite).join(" and ")} did not both pass` });
      continue;
    }
    const engine = workspace === "packages/engine";
    const output = join(folder, `${suite(workspace)}.${engine ? "xml" : "json"}`);
    const reporter = engine ? ["--reporter=junit", `--reporter-outfile=${output}`] : ["--reporter=json", `--outputFile=${output}`];
    const start = performance.now();
    child = Bun.spawn([process.execPath, "run", "--cwd", workspace, "test", ...reporter], { cwd: ROOT, stdin: "inherit", stdout: "inherit", stderr: "inherit" });
    const code = await child.exited;
    const result: Ran = { workspace, code, ms: Math.round(performance.now() - start) };
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
  finished = true;
} finally {
  process.off("SIGINT", onInt); process.off("SIGTERM", onTerm);
  // Work never started is recorded as not run, never as a pass or an observation without misses.
  for (const workspace of ORDER) if (!results.some(result => result.workspace === workspace)) results.push({ workspace, notRun: interrupted ? "the run was interrupted first" : "the runner stopped first" });
  const complete = !interrupted && results.every(result => "code" in result);
  const stable = fingerprint(inputs(ROOT)) === plan.fingerprint;
  writeFileSync(join(folder, "results.json"), JSON.stringify({ mode: "observation", scope: complete ? "complete" : "partial", stableInputs: stable, interrupted, ms: Math.round(performance.now() - began), results }, null, 2));
  if (finished && !interrupted) {
    const unrun = results.filter(result => !("code" in result)).map(result => suite(result.workspace));
    console.log(unrun.length ? `Test summary: ${unrun.join(" and ")} did not run, so this run cannot pass and its affected-test observation covers only the suites that ran.` : "Test summary:");
    for (const result of results) console.log(`  ${suite(result.workspace)}: ${outcome(result)}`);
  }
  if (!stable) console.error("Test inputs changed during the run. Results cannot authorize delivery.");
  process.exitCode = interrupted ?? (stable && complete && results.every(passed) ? 0 : 1);
}

/** One plain line per suite. It never starts like a runner's failure marker, so real failing tests stay the diagnostic. */
function outcome(result: Result): string {
  if (!("code" in result)) return `not run, because ${result.notRun}`;
  const time = `${(result.ms / 1000).toFixed(1)}s`;
  const files = result.failures?.length ? `; failing files: ${result.failures.slice(0, 5).join(", ")}${result.failures.length > 5 ? ` and ${result.failures.length - 5} more` : ""}` : "";
  if (passed(result)) return `passed in ${time}`;
  if (result.code !== 0) return `failed after ${time}${files || "; no failing test file could be attributed"}`;
  return `incomplete after ${time}: ${result.error ? "its structured results were unavailable" : "it exited successfully but its structured results report failures"}${files}`;
}
