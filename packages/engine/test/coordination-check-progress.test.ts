import { executionFor } from "../src/repository-context.js";
import { afterAll, expect, it } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { journeyView, type ProductCheck } from "@petrina/core";
import { Engine } from "../src/engine.js";
import { Coordination } from "../src/coordination.js";
import { makeProduct, removeDir, tempDir, waitFor } from "./support.js";

const roots: string[] = [];
const engines: Engine[] = [];
afterAll(async () => {
  await Promise.all(engines.map((engine) => engine.shutdown()));
  roots.forEach(removeDir);
});
const options = { agentCommand: () => undefined, usageCommands: { codex: null, grok: null }, terminals: () => [] };
function fixture() {
  const root = tempDir("petrina-check-evidence-");
  roots.push(root);
  const home = join(root, "home");
  const engine = new Engine(home, options);
  engines.push(engine);
  engine.setPoolPaused(true);
  engine.schedule = () => {};
  const product = makeProduct(root);
  engine.s.products.push({ id: "product", name: "Example", repo: "local/example", path: product, tone: "blue", delivery: "local" });
  const task = engine.task(engine.addTask({ productId: "product", title: "Check evidence" }))!;
  executionFor(task).work.worktree = product;
  task.plan = { stages: [{ id: "release", title: "Release", kind: "do", roleId: "release-manager", profileIds: ["opus-high"] }], rationale: "Release", plannerProfileId: "opus-high" };
  task.stageIndex = 0;
  task.journey = [{ id: "notes", kind: "agent", roleId: "release-manager", stageId: "release", startedAt: 1, round: 1, sub: 0 }];
  engine.setPoolPaused(false);
  const coordination = new Coordination(engine);
  return { root, home, engine, task, coordination };
}

it("retains live check progress and every original diagnostic through repeated preparation and restart", async () => {
  const { root, home, engine, task, coordination } = fixture();
  const release = join(root, "release");
  const checks: ProductCheck[] = [
    { name: "Quick", argv: [process.execPath, "-e", 'console.log("First preparation diagnostic")'] },
    { name: "Held", argv: [process.execPath, "-e", 'while (!(await Bun.file(process.argv[1]).exists())) await Bun.sleep(20);', release] },
  ];
  const running = engine["checks"].runProductChecks(executionFor(task), checks, new AbortController().signal);
  try {
    await waitFor(() => task.journey![0]!.productChecks?.[0]?.result === "pass" && task.journey![0]!.productChecks?.[1]?.result === "running", "a completed check beside a running check");
    const node = await coordination.call("journey.node", { taskId: task.id, nodeId: "notes" });
    const recorded = JSON.parse(String(node.text)).productChecks;
    expect(recorded[0].run.logComplete).toBe(true);
    expect(recorded[1].startedAt).toBeNumber();
    const visible = journeyView(task, engine.activeState()).nodes[0]!.productChecks!;
    expect(visible[1]).toHaveProperty("id", "check-1");
    expect(visible[1]).toHaveProperty("startedAt");
    expect(visible[1]).toMatchObject({ attemptId: "run-0", productId: "product", queuedAt: expect.any(Number) });
    expect(visible[0]).not.toHaveProperty("run");
  } finally { writeFileSync(release, "go"); }
  expect(await running).toBe(0);
  const firstLog = task.journey![0]!.productChecks![0]!.run!.logPath;
  const failure = "Original failure near the beginning\n" + "Later diagnostic line\n".repeat(9000);
  expect(await engine["checks"].runProductChecks(executionFor(task), [{ name: "Quick", argv: [process.execPath, "-e", 'await Bun.write(Bun.stderr, "Original failure near the beginning\\n" + "Later diagnostic line\\n".repeat(9000)); process.exit(1);'] }], new AbortController().signal)).toBe(1);
  const evidence = task.journey![0]!.productChecks!;
  expect(evidence).toHaveLength(3);
  expect(evidence[2]!.attemptId).not.toBe(evidence[0]!.attemptId);
  expect(new Set(evidence.map((check) => check.id)).size).toBe(3);
  expect(evidence[0]!.run!.logPath).toBe(firstLog);
  expect(evidence[2]!.run!.logPath).not.toBe(firstLog);
  // A newer successful run cannot replace the earlier failed run's diagnostics.
  expect(await engine["checks"].runProductChecks(executionFor(task), checks.slice(0, 1), new AbortController().signal)).toBe(0);
  task.state = "paused";
  engine.setPoolPaused(true);
  await engine.shutdown();
  const replacement = new Engine(home, { ...options, admissionsClosed: true });
  engines.push(replacement);
  const focused = new Coordination(replacement);
  expect(replacement.task(task.id)!.journey![0]!.productChecks![2]!.attemptId).toBe(evidence[2]!.attemptId);
  let page = await focused.call("journey.check", { taskId: task.id, nodeId: "notes", index: 2 });
  expect(page.commandOutcome).toBe("failed");
  expect(page.completeness).toBe("complete");
  let full = String(page.text);
  while (page.next) {
    page = await focused.call("journey.check", { taskId: task.id, nodeId: "notes", index: 2, cursor: page.next });
    full += page.text;
  }
  expect(full).toBe(failure);
  expect((await focused.call("journey.check", { taskId: task.id, nodeId: "notes", index: 0 })).text).toContain("First preparation diagnostic");
});

it("keeps stopped check diagnostics beside completed peers without duplicating progress entries", async () => {
  const { engine, task, coordination } = fixture();
  const stop = new AbortController();
  const running = engine["checks"].runProductChecks(executionFor(task), [
    { name: "Quick", argv: [process.execPath, "-e", 'console.log("Completed peer")'] },
    { name: "Held", argv: [process.execPath, "-e", 'console.log("Before interruption"); await Bun.sleep(60000);'] },
  ], stop.signal).then(() => "finished", () => "stopped");
  try {
    await waitFor(() => task.journey![0]!.productChecks?.[0]?.result === "pass" && task.journey![0]!.productChecks?.[1]?.result === "running", "a completed peer before interruption");
  } finally { stop.abort(); }
  expect(await running).toBe("stopped");
  const checks = task.journey![0]!.productChecks!;
  expect(checks).toHaveLength(2);
  expect(checks[0]!.result).toBe("pass");
  expect(checks[0]!.run!.ok).toBe(true);
  expect(checks[1]!.result).toBe("stopped");
  expect(checks[1]!.run!.interrupted).toBe(true);
  expect((await coordination.call("journey.check", { taskId: task.id, nodeId: "notes", index: 1 })).commandOutcome).toBe("unfinished");
});
