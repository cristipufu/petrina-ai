import { afterAll, describe, expect, it, spyOn } from "bun:test";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Task } from "@petrina/core";
import { CHECK_EXIT_UNREPORTED, checksFingerprint, commandText, detectChecks, parseCommand } from "../src/checks.js";
import { childState, CLEANUP_INCOMPLETE, parseDescendants, readProcessList } from "../src/process-tree.js";
import { Engine } from "./engine.js";
import { Store } from "../src/store.js";
import { defunctProcess, EngineProcess, Fakes, HARNESS, heldMachineRecords, makeProduct, powerLogSleep, removeDir, runChecks, SLOW, tempDir, waitFor } from "./support.js";

const roots: string[] = [];
afterAll(() => roots.forEach(removeDir));
// Check behavior and cleanup limits do not depend on the host's power-log read: the fixtures' check runs and
// engines supply no records. Evidence cases pass their own; the native reader's contract lives in check-interruption.test.ts.
const root = (prefix: string) => {
  const dir = tempDir(prefix);
  roots.push(dir);
  return dir;
};

describe("a product's checks", () => {
  it("captures the created log's descriptor identity even if its pathname is replaced before close", async () => {
    const dir = root("petrina-check-log-identity-");
    const logs = join(dir, "logs"), held = join(dir, "original.log");
    let logPath = "";
    const [run] = await runChecks(dir, [{ name: "Fail", argv: [process.execPath, "-e", 'process.stdout.write("original diagnostic"); process.exit(1)'] }], process.env, 30_000 * SLOW, undefined, logs, undefined, (event) => {
      if (event.kind !== "started") return;
      logPath = join(logs, readdirSync(logs)[0]!);
      renameSync(logPath, held);
      writeFileSync(logPath, "replacement file");
    });
    expect(run!.logComplete).toBe(true);
    expect(run!.logFileIdentity).toBeDefined();
    // Length and beginning also come from the opened file, not the replacement at its old name.
    expect(run!.logFileLength).toBe(Buffer.byteLength("original diagnostic"));
    expect(run!.logFileBeginning).toBe(createHash("sha256").update("original diagnostic").digest("hex"));
    unlinkSync(logPath);
    renameSync(held, logPath);
    const exact = statSync(logPath, { bigint: true });
    expect(run!.logFileIdentity).toEqual({ device: exact.dev.toString(), inode: exact.ino.toString() });
  });

  it("reports each check's start and result while another check is still running", async () => {
    const dir = root("petrina-check-progress-");
    const release = join(dir, "release");
    const updates: { index: number; kind: string; at: number }[] = [];
    const held = `import { existsSync } from "node:fs"; while (!existsSync(process.argv[1])) await Bun.sleep(20);`;
    const running = runChecks(dir, [{ name: "Quick", argv: ["git", "--version"] }, { name: "Held", argv: [process.execPath, "-e", held, release] }], process.env, 30_000 * SLOW, undefined, undefined, undefined, (event) => updates.push(event));
    try {
      await waitFor(() => updates.some((event) => event.index === 0 && event.kind === "finished") && updates.some((event) => event.index === 1 && event.kind === "started"), "one completed check and another still running");
      expect(updates.some((event) => event.index === 1 && event.kind === "finished")).toBe(false);
    } finally { writeFileSync(release, "go"); }
    const results = await running;
    expect(results.every((run) => run.ok)).toBe(true);
    expect(updates.map((event) => `${event.index}:${event.kind}`)).toEqual(["0:started", "0:finished", "1:started", "1:finished"]);
  });

  it("runs static checks first and skips heavy commands after a static failure", async () => {
    const dir = root("petrina-check-stages-");
    const heavy = join(dir, "heavy-started");
    const results = await runChecks(dir, [
      { name: "Tests", argv: [process.execPath, "-e", 'require("node:fs").writeFileSync(process.argv[1], "yes")', heavy] },
      { name: "Type check", argv: [process.execPath, "-e", "process.exit(1)"] },
      { name: "Lint", argv: ["git", "--version"] },
    ], process.env, 30_000 * SLOW);
    expect(results.map((run) => [run.name, run.ok])).toEqual([["Type check", false]]);
    expect(existsSync(heavy)).toBe(false);
  });
  it("suggests the checks a repository declares, whatever its stack", () => {
    const js = root("petrina-checks-js-");
    writeFileSync(join(js, "package.json"), JSON.stringify({ scripts: { typecheck: "tsc --noEmit", test: "vitest run", build: "vite build", dev: "vite" } }));
    writeFileSync(join(js, "bun.lock"), "");
    expect(detectChecks(js)).toEqual([
      { name: "Type check", argv: ["bun", "run", "typecheck"] },
      { name: "Tests", argv: ["bun", "run", "test"] },
      { name: "Build", argv: ["bun", "run", "build"] },
    ]);

    const placeholder = root("petrina-checks-npm-");
    writeFileSync(join(placeholder, "package.json"), JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1' } }));
    expect(detectChecks(placeholder)).toEqual([]);

    const rust = root("petrina-checks-rust-");
    writeFileSync(join(rust, "Cargo.toml"), "[package]\nname = \"x\"\n");
    expect(detectChecks(rust)).toEqual([{ name: "Rust tests", argv: ["cargo", "test"] }]);
  });

  it("reads a typed command into arguments, without a shell", () => {
    expect(parseCommand(`dotnet test "My App.sln" --nologo`)).toEqual(["dotnet", "test", "My App.sln", "--nologo"]);
    expect(parseCommand("bun run test && rm -rf /")).toEqual(["bun", "run", "test", "&&", "rm", "-rf", "/"]);
  });

  it("notices when the CI or build files change, and only then", () => {
    const dir = root("petrina-checks-print-");
    writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { test: "vitest" } }));
    const first = checksFingerprint(dir);
    writeFileSync(join(dir, "README.md"), "# Hello");
    expect(checksFingerprint(dir)).toBe(first);
    mkdirSync(join(dir, ".github", "workflows"), { recursive: true });
    writeFileSync(join(dir, ".github", "workflows", "ci.yml"), "jobs: {}");
    expect(checksFingerprint(dir)).not.toBe(first);
  });

  it("reports what really happened: passed, failed, or could not start", async () => {
    const dir = root("petrina-checks-run-");
    // These commands test exit results, so allow time for process startup on a busy machine.
    const results = await runChecks(
      dir,
      [
        { name: "Passes", argv: ["git", "--version"] },
        { name: "Fails", argv: ["git", "no-such-subcommand-petrina"] },
        { name: "Missing", argv: ["petrina-no-such-program"] },
      ],
      process.env,
      30_000 * SLOW,
    );
    expect(results.map((run) => [run.name, run.ok]), JSON.stringify(results)).toEqual([
      ["Passes", true],
      ["Fails", false],
      ["Missing", false],
    ]);
    expect(results[0]!.output).toContain("git version");
    expect(results[2]!.output).toStartWith("Could not start");
  });

  for (const code of [0, 7]) it(`keeps the output and exit code ${code} when the command ended before spawn returned`, async () => {
    // A fast command under bun:test may be reaped before the caller can attach any event listeners.
    const child = {
      exited: Promise.resolve(code),
      stdout: new Response("Check finished\n").body!,
      stderr: new Response("Details kept\n").body!,
    } as Bun.Subprocess<"ignore", "pipe", "pipe">;
    const spawning = spyOn(Bun, "spawn").mockReturnValue(child);
    // This run's own records: sleep that began a minute ago and lasted an hour.
    const sleep = powerLogSleep(Date.now() - 60_000, 3600);
    const reads: (AbortSignal | undefined)[] = [];
    try {
      const runs = await runChecks(root("petrina-checks-ended-"), [{ name: "Already ended", argv: ["petrina-already-ended"] }], process.env, 200 * SLOW, undefined, undefined, undefined, undefined, async (signal) => { reads.push(signal); return sleep; });
      expect(runs, JSON.stringify(runs)).toEqual([expect.objectContaining({
        name: "Already ended", command: "petrina-already-ended", ms: expect.any(Number), ok: code === 0, output: "Check finished\nDetails kept\n",
        startedAt: expect.any(Number), endedAt: expect.any(Number),
      })]);
      expect(runs[0]!.ms).toBe(runs[0]!.endedAt! - runs[0]!.startedAt!);
      expect(runs[0]!.interruption).toEqual(code === 0 ? undefined : { source: "macOS power log", at: Date.parse(sleep.slice(0, 25)), event: expect.stringContaining("Entering Sleep state") });
      expect(reads).toEqual(code === 0 ? [] : [undefined]);
    } finally { spawning.mockRestore(); }
  });

  it("records a cancelled check without starting an environment investigation", async () => {
    const stop = new AbortController();
    const child = {
      exited: Promise.resolve(1), stdout: new Response("Original diagnostic\n").body!, stderr: new Response("").body!,
    } as Bun.Subprocess<"ignore", "pipe", "pipe">;
    const spawning = spyOn(Bun, "spawn").mockImplementation(() => { stop.abort(); return child; });
    const reads: (AbortSignal | undefined)[] = [];
    try {
      const runs = await runChecks(root("petrina-checks-cancelled-"), [{ name: "Stopped", argv: ["stopped-check"] }, { name: "Pending", argv: ["pending-check"] }], process.env, 30_000, stop.signal, undefined, undefined, undefined, async (signal) => { reads.push(signal); return ""; });
      expect(runs).toHaveLength(1);
      expect(runs[0]!.ok).toBe(false);
      expect(runs[0]!.interrupted).toBe(true);
      expect(runs[0]!.output).toBe("Original diagnostic\n");
      expect(reads).toEqual([]);
      expect(spawning).toHaveBeenCalledTimes(1);
    } finally { spawning.mockRestore(); }
  });

  it("cancels evidence collection after a completed failure without starting pending checks", async () => {
    const stop = new AbortController();
    const child = {
      exited: Promise.resolve(7), stdout: new Response("Original failure\n").body!, stderr: new Response("").body!,
    } as Bun.Subprocess<"ignore", "pipe", "pipe">;
    const spawning = spyOn(Bun, "spawn").mockReturnValue(child);
    // A read racing the stop answers with sleep covering the check: it arrives too late to count.
    const held = heldMachineRecords(powerLogSleep(Date.now() - 60_000, 3600));
    let running: ReturnType<typeof runChecks> | undefined;
    try {
      running = runChecks(root("petrina-checks-evidence-stop-"), [{ name: "Failed", argv: ["failed-check"] }, { name: "Pending", argv: ["pending-check"] }], process.env, 30_000, stop.signal, undefined, undefined, undefined, held.source);
      await held.started();
      expect(held.reads).toEqual([stop.signal]);
      stop.abort();
      const runs = await running;
      expect(runs).toHaveLength(1);
      expect(runs[0]!.ok).toBe(false);
      expect(runs[0]!.interrupted).toBe(true);
      expect(runs[0]!.interruption).toBeUndefined();
      expect(runs[0]!.output).toBe("Original failure\n");
      expect(runs[0]!.ms).toBe(runs[0]!.endedAt! - runs[0]!.startedAt!);
      expect(spawning).toHaveBeenCalledTimes(1);
    } finally {
      stop.abort(); held.answer(""); await running;
      spawning.mockRestore();
    }
  });

  it("reports a check that exceeds its deadline as timed out", async () => {
    const dir = root("petrina-checks-timeout-");
    const [run] = await runChecks(dir, [{ name: "Too slow", argv: ["sleep", "120"] }], process.env, 200 * SLOW, undefined, join(dir, "logs"));
    expect(run!.ok).toBe(false);
    expect(run!.timedOut).toBe(true);
    expect(existsSync(run!.logPath!)).toBe(true);
    expect(run!.logError).toBeUndefined();
  });

  it("keeps the original failure before later output, with separate durable logs for concurrent and repeated checks", async () => {
    const dir = root("petrina-checks-logs-");
    const logs = join(dir, "logs");
    const trace = "Original assertion: expected three agents, received four";
    const text = `before\n${trace}\n${"later passing test\n".repeat(20_000)}last line\n`;
    const script = join(dir, "fails.ts");
    writeFileSync(script, `await Bun.write(Bun.stdout, ${JSON.stringify(text)}); await Bun.write(Bun.stderr, 'stderr trace\\n'); process.exitCode = 1;`);
    const check = { name: "Same name", argv: [process.execPath, script] };
    const results = await runChecks(dir, [check, check], process.env, 30_000 * SLOW, undefined, logs);
    const [again] = await runChecks(dir, [check], process.env, 30_000 * SLOW, undefined, logs);
    expect(new Set([...results, again!].map((run) => run.logPath)).size).toBe(3);
    for (const run of [...results, again!]) {
      expect(run.ok).toBe(false);
      expect(run.logError).toBeUndefined();
      expect(run.output.length).toBeLessThan(7000);
      expect(run.output).not.toContain(trace);
      const saved = readFileSync(run.logPath!, "utf8");
      expect(saved).toContain(trace);
      expect(saved).toContain("stderr trace\n");
      // The two pipes can interleave; every stdout byte must still be there in order.
      const digest = (value: string) => createHash("sha256").update(value).digest("hex");
      expect(digest(saved.replace("stderr trace\n", ""))).toBe(digest(text));
      if (process.platform !== "win32") expect(statSync(run.logPath!).mode & 0o777).toBe(0o600);
      // The recorded fingerprint is bounded to the beginning; the length is the exact settled total.
      const raw = readFileSync(run.logPath!);
      expect(run.logFileLength).toBe(raw.length);
      expect(run.logFileBeginning).toBe(createHash("sha256").update(raw.subarray(0, 4096)).digest("hex"));
    }
  });

  it("reports a log write failure without changing whether a command passed or failed", async () => {
    const dir = root("petrina-checks-log-error-");
    const blocked = join(dir, "not-a-directory");
    writeFileSync(blocked, "Keep this file.");
    const results = await runChecks(dir, [
      { name: "Pass", argv: [process.execPath, "-e", "console.log('passed')"] },
      { name: "Fail", argv: [process.execPath, "-e", "console.error('real error'); process.exitCode = 7"] },
    ], process.env, 30_000 * SLOW, undefined, blocked);
    expect(results.map((run) => run.ok)).toEqual([true, false]);
    expect(results[1]!.output).toContain("real error");
    for (const run of results) {
      expect(run.logError).toBeTruthy();
      expect(run.logPath).toBeUndefined();
      expect(run.logFileIdentity).toBeUndefined();
      expect(run.logFileLength).toBeUndefined();
      expect(run.logFileBeginning).toBeUndefined();
    }
    expect(readFileSync(blocked, "utf8")).toBe("Keep this file.");
  });
});

describe("a check that misbehaves", () => {
  for (const ending of ["abort", "timeout"] as const) it.skipIf(process.platform === "win32")(`stops detached children and grandchildren on ${ending}, leaving an unrelated process alive`, async () => {
    const dir = root("petrina-checks-detached-");
    const worker = join(dir, "worker.ts");
    const parent = join(dir, "parent.ts");
    const childPid = join(dir, "child.pid");
    const grandPid = join(dir, "grandchild.pid");
    const ready = join(dir, "ready");
    const logs = join(dir, "logs");
    writeFileSync(worker, `import { spawn } from "node:child_process"; import { renameSync, writeFileSync } from "node:fs";
writeFileSync(process.argv[2] + ".tmp", String(process.pid)); renameSync(process.argv[2] + ".tmp", process.argv[2]);
if (process.argv[3]) spawn(process.execPath, [${JSON.stringify(worker)}, process.argv[3]], { detached: true, stdio: "ignore" }).unref();
setInterval(() => {}, 1000);`);
    writeFileSync(parent, `import { spawn } from "node:child_process"; import { existsSync, writeFileSync } from "node:fs";
spawn(process.execPath, [${JSON.stringify(worker)}, ${JSON.stringify(childPid)}, ${JSON.stringify(grandPid)}], { detached: true, stdio: "ignore" }).unref();
while (!existsSync(${JSON.stringify(grandPid)})) await Bun.sleep(20);
writeFileSync(${JSON.stringify(ready)}, "ready"); console.log("The check started both detached workers");
setInterval(() => {}, 1000);`);
    const sentinel = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    const stop = new AbortController();
    const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
    const workers = () => [childPid, grandPid].filter(existsSync).map((file) => Number(readFileSync(file, "utf8")));
    let running: Promise<unknown> | undefined;
    try {
      running = runChecks(dir, [{ name: "Detached workers", argv: [process.execPath, parent] }], process.env, 20_000, stop.signal, logs);
      // Readiness precedes the diagnostic: cancellation must wait for the output it asserts.
      await waitFor(() => existsSync(ready) && readdirSync(logs).some(file => readFileSync(join(logs, file), "utf8").includes("both detached workers")), "both detached check workers and their captured start message");
      expect(workers()).toHaveLength(2);
      expect(workers().every(alive)).toBe(true);
      const stoppingAt = Date.now();
      if (ending === "abort") stop.abort();
      const [run] = await running as Awaited<ReturnType<typeof runChecks>>;
      expect(run!.ok).toBe(false);
      expect(!!run!.timedOut).toBe(ending === "timeout");
      expect(readFileSync(run!.logPath!, "utf8")).toContain("both detached workers");
      if (ending === "abort") expect(Date.now() - stoppingAt).toBeLessThan(5000);
      await waitFor(() => workers().every((pid) => !alive(pid)), "the detached workers to exit", 3000);
      expect(alive(sentinel.pid!)).toBe(true);
    } finally {
      stop.abort();
      await running;
      for (const pid of workers()) { try { process.kill(pid, "SIGKILL"); } catch { /* Already gone. */ } }
      sentinel.kill("SIGKILL");
    }
  });

  // The parent and both detached workers are alive. The first list fails. A later real list stops
  // them. When every list fails, those workers stay running and the check says cleanup is incomplete.
  for (const outcome of ["recovers", "cannot read"] as const) it.skipIf(process.platform === "win32")(`reports an unavailable process tree accurately when cleanup ${outcome}`, async () => {
    const dir = root("petrina-checks-process-list-");
    const worker = join(dir, "worker.ts");
    const parent = join(dir, "parent.ts");
    const childPid = join(dir, "child.pid");
    const grandPid = join(dir, "grandchild.pid");
    const parentPid = join(dir, "parent.pid");
    const ready = join(dir, "ready");
    writeFileSync(worker, `import { spawn } from "node:child_process"; import { renameSync, writeFileSync } from "node:fs";
writeFileSync(process.argv[2] + ".tmp", String(process.pid)); renameSync(process.argv[2] + ".tmp", process.argv[2]);
if (process.argv[3]) spawn(process.execPath, [${JSON.stringify(worker)}, process.argv[3]], { detached: true, stdio: "ignore" }).unref();
setInterval(() => {}, 1000);`);
    writeFileSync(parent, `import { spawn } from "node:child_process"; import { existsSync, writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(parentPid)}, String(process.pid));
spawn(process.execPath, [${JSON.stringify(worker)}, ${JSON.stringify(childPid)}, ${JSON.stringify(grandPid)}], { detached: true, stdio: "ignore" }).unref();
while (!existsSync(${JSON.stringify(grandPid)})) await Bun.sleep(20);
writeFileSync(${JSON.stringify(ready)}, "ready"); console.log("The check started both detached workers");
setInterval(() => {}, 1000);`);
    const sentinel = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    const stop = new AbortController();
    const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
    const workers = () => [childPid, grandPid].filter(existsSync).map((file) => Number(readFileSync(file, "utf8")));
    const timeouts: number[] = [];
    let captured: number[] = [];
    const processList = async (timeout: number) => {
      timeouts.push(timeout);
      const pids = workers();
      expect(alive(Number(readFileSync(parentPid, "utf8")))).toBe(true);
      expect(pids).toHaveLength(2);
      expect(pids.every(alive)).toBe(true);
      expect(pids).not.toContain(sentinel.pid);
      if (timeouts.length === 1) captured = [...pids];
      if (outcome === "cannot read" || timeouts.length === 1) return undefined;
      return readProcessList(timeout);
    };
    let running: Promise<unknown> | undefined;
    try {
      running = runChecks(dir, [{ name: "Detached workers", argv: [process.execPath, parent] }], process.env, 20_000, stop.signal, join(dir, "logs"), processList);
      await waitFor(() => existsSync(ready), "both detached check workers to start");
      const parentId = Number(readFileSync(parentPid, "utf8"));
      const found = parseDescendants(await readProcessList(4_000) ?? "", [parentId]);
      for (const pid of workers()) expect(found).toContain(pid);
      expect(found).not.toContain(sentinel.pid);
      const stoppingAt = Date.now();
      stop.abort();
      const [run] = await running as Awaited<ReturnType<typeof runChecks>>;
      expect(run!.ok).toBe(false);
      expect(run!.timedOut).toBeUndefined();
      expect(Date.now() - stoppingAt).toBeLessThan(5000);
      expect(timeouts).toEqual([1_000, 2_000]);
      expect(captured).toHaveLength(2);
      expect(alive(parentId)).toBe(false);
      expect(alive(sentinel.pid!)).toBe(true);
      if (outcome === "recovers") {
        expect(run!.cleanupIncomplete).toBeUndefined();
        expect(run!.output).not.toContain(CLEANUP_INCOMPLETE);
        expect(captured.every((pid) => !alive(pid))).toBe(true);
      } else {
        expect(run!.cleanupIncomplete).toBe(true);
        expect(run!.output).toContain(CLEANUP_INCOMPLETE);
        expect(captured.every(alive)).toBe(true);
      }
    } finally {
      stop.abort();
      await running;
      for (const pid of workers()) { try { process.kill(pid, "SIGKILL"); } catch { /* Already gone. */ } }
      try { process.kill(Number(readFileSync(parentPid, "utf8")), "SIGKILL"); } catch { /* Already gone. */ }
      sentinel.kill("SIGKILL");
    }
  });

  it("reports fast failures when many checks finish together, without waiting for their timeout", async () => {
    // A minute leaves room for 24 programs starting at once while the load climbs after SLOW was measured.
    // A failure Petrina missed would still be cut off at that limit and show as timed out.
    const results = await runChecks(root("petrina-checks-fast-"), Array.from({ length: 24 }, (_, index) => ({ name: `Check ${index}`, argv: [process.execPath, "-e", "console.error('Failed right away'); process.exit(1)"] })), process.env, 60_000 * SLOW);
    for (const result of results) {
      expect(result.ok).toBe(false);
      expect(result.timedOut).toBeUndefined();
      expect(result.output).toContain("Failed right away");
    }
  });

  it.skipIf(process.platform === "win32")("keeps only the end of a flood of output", async () => {
    const [run] = await runChecks(root("petrina-checks-flood-"), [{ name: "Noisy", argv: ["sh", "-c", "yes petrina | head -c 5000000; echo the-end"] }], process.env);
    expect(run!.ok).toBe(true);
    expect(run!.output.length).toBeLessThan(7000);
    expect(run!.output).toEndWith("the-end\n");
  });

  it.skipIf(process.platform === "win32")("ends everything a check started when it runs out of time", async () => {
    const started = Date.now();
    // The background sleep holds the output open: only stopping the whole group ends it quickly.
    const [run] = await runChecks(root("petrina-checks-group-"), [{ name: "Hangs", argv: ["sh", "-c", "sleep 30 & echo started; wait"] }], process.env, 500);
    expect(run!.timedOut).toBe(true);
    expect(run!.output).toContain("started");
    expect(Date.now() - started).toBeLessThan(4000);
  });

  it("stops the current check and never starts pending commands when the task is stopped", async () => {
    const stop = new AbortController();
    setTimeout(() => stop.abort(), 300);
    const started = Date.now();
    const dir = root("petrina-checks-abort-");
    const results = await runChecks(dir, [{ name: "Slow", argv: ["sleep", "30"] }, { name: "Slower", argv: ["sleep", "40"] }], process.env, 60_000, stop.signal, join(dir, "logs"));
    expect(Date.now() - started).toBeLessThan(4000);
    expect(results.map((run) => [run.name, run.ok])).toEqual([["Slow", false]]);
    for (const run of results) {
      expect(existsSync(run.logPath!)).toBe(true);
      expect(run.logError).toBeUndefined();
    }
  });

  it("serializes commands that share a build directory", async () => {
    const dir = root("petrina-checks-shared-output-");
    const command = 'const fs = require("node:fs"); fs.writeFileSync("build.lock", "held", {flag:"wx"}); await Bun.sleep(40); fs.unlinkSync("build.lock");';
    const results = await runChecks(dir, [1, 2, 3].map((n) => ({ name: `Check ${n}`, argv: [process.execPath, "-e", command] })), process.env);
    expect(results.map((run) => [run.name, run.ok])).toEqual([["Check 1", true], ["Check 2", true], ["Check 3", true]]);
    expect(existsSync(join(dir, "build.lock"))).toBe(false);
  });
});

describe("Petrina runs the checks itself during a task", () => {
  for (const outcome of ["pass", "fail"] as const) {
    it(`${outcome === "pass" ? "lets the review go ahead when they pass" : "sends the work back before any reviewer runs when they fail"}`, async () => {
      const dir = root("petrina-checks-task-");
      const product = makeProduct(dir);
      const fakes = new Fakes(join(dir, "fake"));
      fakes.scenario({ planner: "short", checks: outcome });
      const engine = new Engine(join(dir, "data"), { agentCommand: () => [process.execPath, join(import.meta.dir, "fake-agent.ts"), fakes.dir] });
      try {
        const productId = await engine.addProduct(product);
        engine.setProductDelivery(productId, "local", true);
        const taskId = engine.addTask({ productId, title: "Add a greeting", description: "[no-check]" });
        const task = await waitFor(() => {
          const state = engine.getState();
          // Approve the plan like a coordinator would; everything else runs by itself.
          for (const item of state.inbox) {
            if (item.taskId !== taskId) continue;
            if (item.kind === "plan") engine.approve(item.id);
            else if (item.kind === "permission") engine.allow(item.id, "once");
            else if (item.kind === "question") engine.answer(item.id, item.options?.[0] ?? "Yes");
          }
          const found = state.tasks.find((entry) => entry.id === taskId) as Task | undefined;
          if (found?.state === "failed") throw new Error(`The task failed: ${found.error}`);
          return found && state.inbox.some((item) => item.taskId === taskId && item.kind === "delivery") && found;
        }, "the delivery check", 60_000);

        const finder = engine.getState().products.find((entry) => entry.id === productId)!;
        expect(finder.checksBy).toBe("finder");
        expect(finder.checks?.length).toBe(1);
        expect(task.checks?.results).toHaveLength(1);
        expect(existsSync(task.checks!.results[0]!.logPath!)).toBe(true);
        const reviewerRuns = task.timeline.filter((entry) => entry.text === "Code reviewer started").length;
        if (outcome === "pass") {
          expect(task.checks!.results[0]!.ok).toBe(true);
          expect(reviewerRuns).toBeGreaterThan(0);
          expect(engine.getState().inbox.find((item) => item.taskId === taskId)!.body).toContain("Automated checks: all 1 passed");
        } else {
          expect(task.checks!.results[0]!.ok).toBe(false);
          // Reviewers never spent a turn on work whose checks fail.
          expect(reviewerRuns).toBe(0);
          expect(task.findings.some((finding) => finding.raisedBy === "petrina" && finding.text.startsWith("Check failed: Tests") && finding.evidence)).toBe(true);
          const fixing = fakes.received("builder").find((entry) => entry.text.includes("Saved failed-check output"));
          expect(fixing?.text).toContain(join(dir, "data", "checks", taskId));
          expect(fixing?.text).toContain("do not rerun just to recover the error");
          expect(task.timeline.some((entry) => entry.text.startsWith("Sent back to the builder"))).toBe(true);
          expect(engine.getState().inbox.find((item) => item.taskId === taskId)!.body).toContain("Automated checks: 1 of 1 failed (Tests)");
        }
        // The finder ran once for the product, not once per review round.
        expect(task.timeline.filter((entry) => entry.text.startsWith("Found how to check")).length).toBe(1);
        const savedLog = task.checks!.results[0]!.logPath!;
        const contents = readFileSync(savedLog, "utf8");
        engine.shutdown();
        const store = new Store(join(dir, "data", "petrina.db"));
        try {
          expect(store.load()!.tasks.find((entry) => entry.id === taskId)!.repository!.checks!.results[0]!.logPath).toBe(savedLog);
          expect(readFileSync(savedLog, "utf8")).toBe(contents);
        } finally { store.close(); }
      } finally {
        engine.shutdown();
      }
    });
  }
});

describe("a stopped check keeps an incomplete cleanup warning", () => {
  // The process list fails only while this check or hook is stopped. The engine's own PATH stands in
  // for ps, so the rest of the suite still sees the real one.
  for (const kind of ["check", "hook"] as const) {
    it.skipIf(process.platform === "win32")(`saves it when cancelling a ${kind} cannot list the programs it started`, async () => {
      const dir = tempDir("petrina-check-stop-warn-");
      const home = join(dir, "data");
      const fakes = new Fakes(join(dir, "fake"));
      fakes.scenario({ planner: "short", builder: "plain" });
      const bin = join(dir, "bin");
      mkdirSync(bin);
      const blind = join(dir, "blind");
      const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
      writeFileSync(join(bin, "ps"), `#!/bin/sh\nif [ -f ${quote(blind)} ]; then exit 1; fi\nexec /bin/ps "$@"\n`);
      chmodSync(join(bin, "ps"), 0o755);
      const worker = join(dir, "worker.ts");
      const childPid = join(dir, "child.pid");
      const ready = join(dir, "ready");
      writeFileSync(worker, `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(childPid)}, String(process.pid));\nsetInterval(() => {}, 1000);\n`);
      const hang = `import { spawn } from "node:child_process";\nimport { existsSync, writeFileSync } from "node:fs";\nconst child = spawn(process.execPath, [${JSON.stringify(worker)}], { detached: true, stdio: "ignore" });\nchild.unref();\nwhile (!existsSync(${JSON.stringify(childPid)})) await Bun.sleep(20);\nwriteFileSync(${JSON.stringify(ready)}, "ready");\nsetInterval(() => {}, 1000);\n`;
      const parent = join(dir, kind === "check" ? "parent.ts" : "pass.ts");
      const hookScript = join(dir, "hook.ts");
      writeFileSync(parent, kind === "check" ? hang : "process.exit(0);\n");
      if (kind === "hook") writeFileSync(hookScript, hang);
      const repo = makeProduct(dir);
      if (kind === "hook") {
        const hook = join(repo, ".git", "hooks", "pre-commit");
        writeFileSync(hook, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(hookScript)}\n`);
        chmodSync(hook, 0o755);
      }
      const launcher = join(dir, "engine.ts");
      writeFileSync(launcher, `process.env.PATH = ${JSON.stringify(bin)} + ":" + process.env.PATH;\nawait import(${JSON.stringify(HARNESS)});\n`);
      let engine: EngineProcess | undefined;
      const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
      try {
        engine = await EngineProcess.start(home, [launcher, home, fakes.dir]);
        const productId = await engine.act("addProduct", repo) as string;
        await engine.act("setProductChecks", productId, [{ name: "Detached", command: commandText([process.execPath, parent]) }]);
        await engine.act("setProductDelivery", productId, "local", true);
        const id = await engine.act("addTask", { productId, title: "Add a greeting", description: "[no-check]" }) as string;
        await waitFor(async () => {
          const state = await engine!.state();
          for (const item of state.inbox) {
            if (item.kind === "plan" || item.kind === "design") await engine!.act("approve", item.id);
            else if (item.kind === "question") await engine!.act("answer", item.id, item.options?.[0] ?? "Yes");
            else if (item.kind === "permission") await engine!.act("allow", item.id, "once");
          }
          const task = state.tasks.find((entry) => entry.id === id);
          if (task?.state === "failed") throw new Error(task.error ?? task.statusLine);
          return existsSync(ready);
        }, `the ${kind} to start its detached program`, 90_000);
        const pid = Number(readFileSync(childPid, "utf8"));
        expect(alive(pid)).toBe(true);
        writeFileSync(blind, "");
        await engine.act("cancel", id);
        const state = await waitFor(async () => {
          const next = await engine!.state();
          const task = next.tasks.find((entry) => entry.id === id);
          return task?.checks?.results.some((run) => run.cleanupIncomplete) ? next : undefined;
        }, "the stopped run to keep its cleanup warning");
        const task = state.tasks.find((entry) => entry.id === id)!;
        const run = task.checks!.results.find((entry) => entry.cleanupIncomplete)!;
        expect(task.state).toBe("cancelled");
        expect(task.checks?.sha).toBeUndefined();
        expect(task.checks?.tree).toBeUndefined();
        expect(run.output).toContain(CLEANUP_INCOMPLETE);
        if (kind === "hook") expect(run.command).toContain("pre-commit");
        expect(task.timeline.some((entry) => entry.text === CLEANUP_INCOMPLETE)).toBe(true);
        expect(task.findings.some((finding) => finding.text.startsWith("Check failed"))).toBe(false);
        expect(alive(pid)).toBe(true);
        // Inspect durable evidence only after its writer has finished saving and released SQLite.
        await engine.quit();
        const store = new Store(join(home, "petrina.db"));
        try {
          const saved = store.load()!.tasks.find((entry) => entry.id === id)!;
          expect(saved.repository!.checks?.sha).toBeUndefined();
          expect(saved.repository!.checks?.tree).toBeUndefined();
          expect(saved.repository!.checks?.results.some((entry) => entry.cleanupIncomplete)).toBe(true);
          expect(saved.timeline.some((entry) => entry.text === CLEANUP_INCOMPLETE)).toBe(true);
        } finally { store.close(); }
      } finally {
        if (engine?.proc.exitCode === null) await engine.quit().catch(() => engine!.kill());
        try { process.kill(Number(readFileSync(childPid, "utf8")), "SIGKILL"); } catch { /* Already gone. */ }
        removeDir(dir);
      }
    });
  }
});

describe("a check that closes its output", () => {
  it.skipIf(process.platform === "win32")("keeps running inside its allowance when it sends its output to a file, and is still stopped at its deadline", async () => {
    const dir = root("petrina-checks-redirected-");
    const log = join(dir, "check.log");
    const started = Date.now();
    // The check closes Petrina's pipes at once and does valid work for longer than any grace would allow.
    const [run] = await runChecks(dir, [{ name: "Redirected", argv: ["sh", "-c", `exec >${JSON.stringify(log)} 2>&1; sleep 6.5; echo finished; exit 0`] }], process.env, 60_000 * SLOW, undefined, join(dir, "logs"));
    expect(run!.ok).toBe(true);
    expect(run!.timedOut).toBeUndefined();
    expect(run!.output).not.toContain(CHECK_EXIT_UNREPORTED);
    expect(Date.now() - started).toBeGreaterThanOrEqual(6_000);
    expect(readFileSync(log, "utf8")).toBe("finished\n");
    const limited = Date.now();
    const [late] = await runChecks(dir, [{ name: "Past its limit", argv: ["sh", "-c", "exec >&- 2>&-; exec sleep 120"] }], process.env, 2_000, undefined, join(dir, "logs"));
    expect(late!.ok).toBe(false);
    expect(late!.timedOut).toBe(true);
    expect(late!.output).not.toContain(CHECK_EXIT_UNREPORTED);
    expect(Date.now() - limited).toBeLessThan(12_000);
  });
});

describe("a check whose exit the system never reports", () => {
  it.skipIf(process.platform === "win32")("settles within the grace as unknown, keeps its output, and stops what it started", async () => {
    // What a lost exit looks like: the output ended, the runtime never reports the exit, and the system shows the
    // check defunct. A real defunct process stands in for the check; the runtime's report never comes.
    const dir = root("petrina-checks-unreported-");
    const defunct = await defunctProcess();
    const standIn = { pid: defunct.pid, exited: new Promise<number>(() => {}), stdout: new Response("finished\n").body!, stderr: new Response("").body! } as unknown as Bun.Subprocess<"ignore", "pipe", "pipe">;
    const spawning = spyOn(Bun, "spawn");
    try {
      await waitFor(async () => (await childState(defunct.pid)) === "ended", "the stand-in to be defunct", 10_000);
      spawning.mockReturnValueOnce(standIn);
      const started = Date.now();
      const [run] = await runChecks(dir, [{ name: "Ended quietly", argv: ["petrina-ended-quietly"] }], process.env, 60_000 * SLOW, undefined, join(dir, "logs"));
      expect(Date.now() - started).toBeLessThan(30_000 * SLOW);
      expect(run!.ok).toBe(false);
      expect(run!.timedOut).toBeUndefined();
      expect(run!.output).toContain("finished");
      expect(run!.output).toContain(CHECK_EXIT_UNREPORTED);
      // A defunct check is not a running process: its cleanup is complete.
      expect(run!.cleanupIncomplete).toBeUndefined();
      expect(run!.output).not.toContain(CLEANUP_INCOMPLETE);
      expect(run!.logComplete).toBe(true);
    } finally {
      spawning.mockRestore();
      await defunct.release();
    }
  });
});
