import { afterAll, describe, expect, it } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Task } from "@petrina/core";
import { checksFingerprint, detectChecks, parseCommand, runChecks } from "../src/checks.js";
import { Engine } from "../src/engine.js";
import { Fakes, makeProduct, removeDir, tempDir, waitFor, SLOW } from "./support.js";

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
    expect(results.map((run) => [run.name, run.ok])).toEqual([
      ["Passes", true],
      ["Fails", false],
      ["Missing", false],
    ]);
    expect(results[0]!.output).toContain("git version");
    expect(results[2]!.output).toStartWith("Could not start");
  });

  it("reports a check that exceeds its deadline as timed out", async () => {
    const [run] = await runChecks(root("petrina-checks-timeout-"), [{ name: "Too slow", argv: ["sleep", "120"] }], process.env, 200 * SLOW);
    expect(run!.ok).toBe(false);
    expect(run!.timedOut).toBe(true);
  });
});

describe("a check that misbehaves", () => {
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
    const results = await runChecks(root("petrina-checks-abort-"), [{ name: "Slow", argv: ["sleep", "30"] }, { name: "Slower", argv: ["sleep", "40"] }], process.env, 60_000, stop.signal);
    expect(Date.now() - started).toBeLessThan(4000);
    expect(results.map((run) => [run.name, run.ok])).toEqual([["Slow", false], ["Slower", false]]);
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
        const reviewerRuns = task.timeline.filter((entry) => entry.text === "Code reviewer started").length;
        if (outcome === "pass") {
          expect(task.checks!.results[0]!.ok).toBe(true);
          expect(reviewerRuns).toBeGreaterThan(0);
          expect(engine.getState().inbox.find((item) => item.taskId === taskId)!.body).toContain("Petrina's checks: all 1 passed");
        } else {
          expect(task.checks!.results[0]!.ok).toBe(false);
          // Reviewers never spent a turn on work whose checks fail.
          expect(reviewerRuns).toBe(0);
          expect(task.findings.some((finding) => finding.raisedBy === "petrina" && finding.text.startsWith("Check failed: Tests") && finding.evidence)).toBe(true);
          expect(task.timeline.some((entry) => entry.text.startsWith("Sent back to the builder"))).toBe(true);
          expect(engine.getState().inbox.find((item) => item.taskId === taskId)!.body).toContain("Petrina's checks: 1 of 1 failed (Tests)");
        }
        // The finder ran once for the product, not once per review round.
        expect(task.timeline.filter((entry) => entry.text.startsWith("Found how to check")).length).toBe(1);
      } finally {
        engine.shutdown();
      }
    });
  }
});
