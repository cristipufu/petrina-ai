import { resolve as testFixturePath } from "node:path";
const TEST_FIXTURE_ROOT = testFixturePath(import.meta.dir, "../..");
import { completeAll as probes } from "@petrina/core";
import { afterAll, expect, it } from "bun:test";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { browserProcesses } from "@petrina/platform/browser-processes";
import { removeDir, SLOW, tempDir, testGitEnv, waitFor } from "../../fixtures.js";
import { FALLBACK_TIMEOUT, testCommand, TEST_RUNNER } from "@petrina/test-support/run";

// Each probe is a real Bun run of private tests that only sleep. Bun reports the limit that stopped each
// test; the probe's own bound stops the whole command if Bun never finishes, which is not a test timeout.
const ENGINE = resolve(TEST_FIXTURE_ROOT, ".."), ROOT = resolve(ENGINE, "../..");
const WORKERS = "PETRINA_TEST_DEADLINE_PROBE_WORKERS";
const WAIT = 500, COMMAND = 100, SHORTER = 50, LONGER = 30_000, PAST_DEFAULT = 5_500;
const BOUND = 30_000 * SLOW;
const HELPERS = { none: undefined, fixtures: join(TEST_FIXTURE_ROOT, "fixtures.ts"), support: join(TEST_FIXTURE_ROOT, "support.ts") };
type Helper = keyof typeof HELPERS;

const fixture = tempDir("petrina-test-deadlines-");
afterAll(() => removeDir(fixture));

/** A private test file. TypeScript drops a named import that is never used, so the helper is used to make it load. */
function probeFile(helper: Helper, name: string, tests: string): string {
  const file = join(fixture, `${name}-${helper}.test.ts`), path = HELPERS[helper];
  writeFileSync(file, `import { it } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
${path ? `import { tempDir } from ${JSON.stringify(path)};
if (typeof tempDir !== "function") throw new Error("The helper did not load");` : ""}
writeFileSync(join(process.env.${WORKERS}!, String(process.pid)), "");
${tests}`);
  return file;
}

const alive = (pid: number) => browserProcesses.exists(pid);

/** Each test's outcome by name, with the limit Bun reports for a timeout. */
function outcomes(report: string, output: string): Record<string, string> {
  const limits = new Map([...output.matchAll(/^\(fail\) (.+) \[[\d.]+ms\]\r?\n\s+\^ this test timed out after (\d+)ms\./gm)].map(match => [match[1]!, match[2]!]));
  return Object.fromEntries([...report.matchAll(/<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/g)].map(([, attributes, body = ""]) => {
    const name = attributes!.match(/\bname="([^"]*)"/)![1]!;
    if (body.includes("<skipped")) return [name, "skipped"];
    if (body.includes('type="TimeoutError"')) return [name, `timed out after ${limits.has(name) ? `${limits.get(name)}ms` : "an unreported limit"}`];
    return [name, body.includes("<failure") ? "failed" : "passed"];
  }));
}

async function probe(label: string, args: string[], cwd: string): Promise<{ code: number; output: string; outcomes: Record<string, string> }> {
  const folder = join(fixture, label), workers = join(folder, "workers"), report = join(folder, "report.xml");
  mkdirSync(workers, { recursive: true });
  const started = Date.now();
  const child = Bun.spawn([process.execPath, ...args, "--reporter=junit", `--reporter-outfile=${report}`], {
    cwd, env: { ...testGitEnv(), [WORKERS]: workers }, stdin: "ignore", stdout: "pipe", stderr: "pipe",
    // Its own process group, so the bound stops a runner, Bun and every worker together.
    detached: process.platform !== "win32",
  });
  const signal = (name: "SIGTERM" | "SIGKILL") => {
    try { if (process.platform === "win32") child.kill(name); else process.kill(-child.pid, name); } catch { /* Already stopped. */ }
  };
  let output = "";
  const read = async (stream: ReadableStream<Uint8Array>) => { const decoder = new TextDecoder(); for await (const chunk of stream) output += decoder.decode(chunk, { stream: true }); };
  let stopped = false, giveUp!: () => void;
  const abandoned = new Promise<undefined>(done => { giveUp = () => done(undefined); });
  // Bun can lose a child's exit under load: stop waiting after the stop signals have had their chance.
  const timers = [
    setTimeout(() => { stopped = true; signal("SIGTERM"); }, BOUND),
    setTimeout(() => signal("SIGKILL"), BOUND + 5_000 * SLOW),
    setTimeout(giveUp, BOUND + 10_000 * SLOW),
  ];
  const finished = await Promise.race([Promise.all([child.exited, read(child.stdout), read(child.stderr)]), abandoned]);
  for (const timer of timers) clearTimeout(timer);
  const recorded = () => readdirSync(workers).map(Number).filter(alive);
  try { await waitFor(() => !recorded().length, `the ${label} probe's test workers to stop`); }
  catch (error) { if (finished && !stopped) throw error; }
  finally {
    if (recorded().length) {
      if (process.platform !== "win32") signal("SIGKILL");
      else for (const pid of recorded()) try { process.kill(pid, "SIGKILL"); } catch { /* Already stopped. */ }
    }
  }
  if (!finished || stopped) {
    throw new Error(`Incomplete: the ${label} probe was stopped by its own ${BOUND}ms bound after ${Date.now() - started}ms, before Bun reported every result. Last output:\n${output.slice(-2_000)}`);
  }
  let body: string;
  try { body = readFileSync(report, "utf8"); }
  catch { throw new Error(`The ${label} probe wrote no report (exit ${finished[0]}):\n${output}`); }
  return { code: finished[0], output: `${label}, ${Date.now() - started}ms:\n${output}`, outcomes: outcomes(body, output) };
}

it("an explicit command limit holds through the runner and direct Bun with shared helpers, and a test's own limit still wins", async () => {
  const files = (Object.keys(HELPERS) as Helper[]).map(helper => probeFile(helper, "explicit", `
it("${helper} uses the command limit", () => Bun.sleep(${WAIT}));
it("${helper} keeps its own longer limit", () => Bun.sleep(${WAIT}), ${LONGER});
it("${helper} keeps its own shorter limit", () => Bun.sleep(${WAIT}), ${SHORTER});
it("${helper} is left out by the name filter", () => { throw new Error("The name filter did not reach Bun"); });`));
  const filter = ["-t", "limit"];
  const runs = await probes([
    probe("runner-in-engine", [TEST_RUNNER, ...files, "--timeout", String(COMMAND), ...filter], ENGINE),
    probe("runner-from-root", ["run", "--cwd", "packages/engine", "test", ...files, `--timeout=${COMMAND}`, ...filter], ROOT),
    probe("direct-in-engine", ["test", ...files, `--timeout=${COMMAND}`, ...filter], ENGINE),
    probe("direct-from-root", ["test", ...files, "--timeout", String(COMMAND), ...filter], ROOT),
  ]);
  const expected = Object.fromEntries((Object.keys(HELPERS) as Helper[]).flatMap(helper => [
    [`${helper} uses the command limit`, `timed out after ${COMMAND}ms`],
    [`${helper} keeps its own longer limit`, "passed"],
    [`${helper} keeps its own shorter limit`, `timed out after ${SHORTER}ms`],
    [`${helper} is left out by the name filter`, "skipped"],
  ]));
  for (const run of runs) {
    expect(run.outcomes, run.output).toEqual(expected);
    expect(run.code, run.output).toBe(1);
  }
}, 90_000 * SLOW);

it("the runner gives tests without a limit its long fallback before the caller's options, while direct Bun keeps five seconds", async () => {
  expect(FALLBACK_TIMEOUT).toBe(12 * 60_000);
  expect(testCommand(["probe.test.ts", "--timeout", "100"])).toEqual([process.execPath, "--no-env-file", "test", "--parallel", `--timeout=${FALLBACK_TIMEOUT}`, "probe.test.ts", "--timeout", "100"]);
  const helpers = ["none", "fixtures"] as const;
  const files = helpers.map(helper => probeFile(helper, "default", `
it("${helper} runs just past five seconds", () => Bun.sleep(${PAST_DEFAULT}));
it("${helper} keeps its own shorter limit", () => Bun.sleep(${WAIT}), ${SHORTER});`));
  // Direct runs get one file each: a single Bun process runs its files one after another.
  const [runner, ...direct] = await probes([
    probe("runner-in-temporary-folder", [TEST_RUNNER, ...files], fixture),
    ...helpers.map((helper, index) => probe(`direct-default-${helper}`, ["test", files[index]!], ENGINE)),
  ]);
  expect(runner!.outcomes, runner!.output).toEqual(Object.fromEntries(helpers.flatMap(helper => [
    [`${helper} runs just past five seconds`, "passed"],
    [`${helper} keeps its own shorter limit`, `timed out after ${SHORTER}ms`],
  ])));
  expect(runner!.code, runner!.output).toBe(1);
  for (const [index, run] of direct.entries()) {
    const helper = helpers[index]!;
    expect(run.outcomes, run.output).toEqual({ [`${helper} runs just past five seconds`]: "timed out after 5000ms", [`${helper} keeps its own shorter limit`]: `timed out after ${SHORTER}ms` });
    expect(run.code, run.output).toBe(1);
  }
}, 90_000 * SLOW);
