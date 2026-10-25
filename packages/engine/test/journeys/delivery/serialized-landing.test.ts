import { afterAll, expect, it } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Engine } from "../../engine.js";
import { executionFor } from "@petrina/orchestrator";
import { commandText } from "../../../src/checks.js";
import { git, makeProduct, removeDir, tempDir } from "../../fixtures.js";

const roots: string[] = [];
afterAll(() => roots.forEach(removeDir));

// Two individually good changes are intentionally incompatible. The old pass must never authorize
// their combined tree, even when both publication calls begin together on the same approved base.
it("serializes concurrent local landings and checks the second integrated tree before moving main", async () => {
  const root = tempDir("petrina-landing-reliability-"); roots.push(root);
  const engine = new Engine(join(root, "data"), { agentCommand: () => undefined, terminals: () => [] });
  engine.schedule = () => {};
  engine.setPoolPaused(false);
  try {
    const repo = await makeProduct(root);
    // An explicitly local product: no account, GitHub address confirmation or remote service.
    await git(repo, "remote", "remove", "origin");
    const productId = await engine.addProduct(repo);
    const base = await git(repo, "rev-parse", "HEAD");
    const log = join(root, "checks.jsonl");
    const script = join(root, "check.ts");
    // A product check: the engine's check runner bounds this program and stops its whole process group.
    writeFileSync(script, `import { appendFileSync, existsSync } from "node:fs";
const result = Bun.spawnSync(["git", "rev-parse", "HEAD^{tree}"], { stdout: "pipe" });
const ok = !(existsSync("feature-a") && existsSync("feature-b"));
appendFileSync(process.argv[2], JSON.stringify({ tree: result.stdout.toString().trim(), ok }) + "\\n");
process.exit(ok ? 0 : 1);`);
    engine.setProductChecks(productId, [{ name: "Tests", command: commandText([process.execPath, script, log]) }]);
    const signal = new AbortController().signal;
    const tasks: NonNullable<ReturnType<typeof engine.task>>[] = [];
    // These direct calls exercise the last ref-movement defense with two already-prepared candidates.
    // Return their delivery turns when an attempt ends, as the real task driver does in its cleanup.
    const attempt = async <T>(task: NonNullable<ReturnType<typeof engine.task>>, run: () => Promise<T>): Promise<T> => {
      try { return await run(); }
      finally { engine["shipping"].releaseDeliveryTurn(task.id); }
    };
    for (const name of ["a", "b"]) {
      const task = engine.task(engine.addTask({ productId, title: `Feature ${name}` }))!;
      const work = executionFor(task).work;
      work.delivery = "local"; work.base = "main"; work.baseSha = base;
      work.branch = `task-${name}`; work.worktree = join(root, `copy-${name}`);
      await git(repo, "worktree", "add", "-q", "-b", work.branch, work.worktree, base);
      writeFileSync(join(work.worktree, `feature-${name}`), name);
      await git(work.worktree, "add", ".");
      await git(work.worktree, "commit", "-q", "-m", task.title);
      task.plan = { rationale: "Focused delivery fixture", plannerProfileId: "opus-high", stages: [
        { id: "delivery", title: "Delivery", kind: "gate", gate: "delivery", roleId: "coordinator", profileIds: [] },
        { id: "ship", title: "Ship", kind: "do", roleId: "release-manager", profileIds: ["opus-high"] },
      ] };
      task.stageIndex = 1;
      tasks.push(task);
    }
    for (const task of tasks) {
      const scope = executionFor(task);
      expect(await engine["checks"].failing(scope, signal)).toBe(false);
      const tested = await git(scope.work.worktree!, "rev-parse", "HEAD");
      scope.work.approvedSha = tested;
      scope.work.approvedPatch = await engine["updates"].patch(scope);
      scope.work.shipping = { moves: 0, failures: 0, base, start: tested, prepared: { tested, summary: task.title } };
    }
    const results = await Promise.all(tasks.map(task => attempt(task, () => engine["shipping"]["publishLocal"](executionFor(task), signal))));
    expect([...results].sort()).toEqual(["again", "done"]);
    expect(tasks.every(task => !engine["checks"].deliveryOrders.has(task.id))).toBe(true);
    const landed = tasks[results.indexOf("done")]!;
    const second = tasks[results.indexOf("again")]!;
    const firstTip = await git(repo, "rev-parse", "main");
    expect(firstTip).toBe(executionFor(landed).work.approvedSha!);
    expect(executionFor(second).work.shipping?.prepared).toBeUndefined();
    // Re-enter the real preparation boundary. Its integrated tree fails, so it cannot publish.
    expect(await attempt(second, () => engine["shipping"]["readyToShip"](executionFor(second), signal))).toBe("back");
    const evidence = readFileSync(log, "utf8").trim().split("\n").map(line => JSON.parse(line) as { tree: string; ok: boolean });
    expect(evidence.map(run => run.ok)).toEqual([true, true, false]);
    expect(evidence[2]!.tree).not.toBe(evidence[0]!.tree);
    expect(evidence[2]!.tree).not.toBe(evidence[1]!.tree);
    expect(executionFor(second).work.checks?.tree).toBe(evidence[2]!.tree);
    expect(executionFor(second).work.approvedSha).toBeUndefined();
    expect(await git(repo, "rev-parse", "main")).toBe(firstTip);
    expect(second.stageIndex).toBe(0);
    expect(engine["checks"].deliveryOrders.has(second.id)).toBe(false);
  } finally { await engine.shutdown(); }
});
