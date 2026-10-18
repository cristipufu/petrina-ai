import { afterAll, describe, expect, it, spyOn } from "bun:test";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Task } from "@petrina/core";
import { checksFingerprint, detectChecks, parseCommand, runChecks } from "../src/checks.js";
import { Engine } from "../src/engine.js";
import { Store } from "../src/store.js";
import { Fakes, makeProduct, removeDir, SLOW, tempDir, waitFor } from "./support.js";

const roots: string[] = [];
afterAll(() => roots.forEach(removeDir));
const root = (prefix: string) => {
  const dir = tempDir(prefix);
  roots.push(dir);
  return dir;
};

describe("a product's checks", () => {
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
    try {
      const runs = await runChecks(root("petrina-checks-ended-"), [{ name: "Already ended", argv: ["petrina-already-ended"] }], process.env, 200 * SLOW);
      expect(runs, JSON.stringify(runs)).toEqual([{
        name: "Already ended", command: "petrina-already-ended", ms: expect.any(Number), ok: code === 0, output: "Check finished\nDetails kept\n",
      }]);
    } finally { spawning.mockRestore(); }
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
    writeFileSync(worker, `import { spawn } from "node:child_process"; import { writeFileSync } from "node:fs";
writeFileSync(process.argv[2], String(process.pid));
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
      running = runChecks(dir, [{ name: "Detached workers", argv: [process.execPath, parent] }], process.env, 20_000, stop.signal, join(dir, "logs"));
      await waitFor(() => existsSync(ready), "both detached check workers to start");
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

  it("stops every check when the task is stopped", async () => {
    const stop = new AbortController();
    setTimeout(() => stop.abort(), 300);
    const started = Date.now();
    const dir = root("petrina-checks-abort-");
    const results = await runChecks(dir, [{ name: "Slow", argv: ["sleep", "30"] }, { name: "Slower", argv: ["sleep", "40"] }], process.env, 60_000, stop.signal, join(dir, "logs"));
    expect(Date.now() - started).toBeLessThan(4000);
    expect(results.map((run) => [run.name, run.ok])).toEqual([["Slow", false], ["Slower", false]]);
    for (const run of results) {
      expect(existsSync(run.logPath!)).toBe(true);
      expect(run.logError).toBeUndefined();
    }
  });

  it("runs the checks side by side: the wait is the slowest one, not the sum", async () => {
    const started = Date.now();
    const results = await runChecks(root("petrina-checks-side-"), [1, 2, 3].map((n) => ({ name: `Check ${n}`, argv: ["sleep", "1"] })), process.env);
    expect(results.map((run) => [run.name, run.ok])).toEqual([["Check 1", true], ["Check 2", true], ["Check 3", true]]);
    expect(Date.now() - started).toBeLessThan(2500);
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
          expect(store.load()!.tasks.find((entry) => entry.id === taskId)!.checks!.results[0]!.logPath).toBe(savedLog);
          expect(readFileSync(savedLog, "utf8")).toBe(contents);
        } finally { store.close(); }
      } finally {
        engine.shutdown();
      }
    });
  }
});
