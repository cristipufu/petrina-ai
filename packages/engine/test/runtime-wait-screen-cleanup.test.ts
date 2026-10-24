import { nativeAgentProcess } from "./native-agent.js";
import { afterAll, describe, expect, it } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ChildProcess } from "node:child_process";
import { onScreen, type CheckId } from "@petrina/core";
import { Engine } from "./engine.js";
import { executionFor } from "../src/repository-context.js";
import { Fakes, FAKE_AGENT, git, makeProduct, removeDir, tempDir, waitFor } from "./fixtures.js";

const roots: string[] = [];
afterAll(() => roots.forEach(removeDir));

/** A prepared review only: no planning, building, check discovery or real screen use. */
async function fixture() {
  const root = tempDir("petrina-wait-screen-cleanup-"); roots.push(root);
  const fakes = new Fakes(join(root, "fake"));
  fakes.scenario({ controlled: true, screenRoles: ["code reviewer"], screenModels: ["gpt-6.1-sol"], screenRoleHold: true, reopen: "resume" });
  const clone = await makeProduct(root), base = await git(clone, "rev-parse", "HEAD");
  await git(clone, "config", "branch.autoSetupMerge", "false");
  const engine = new Engine(join(root, "data"), { agentCommand: () => [process.execPath, FAKE_AGENT, fakes.dir] });
  // Drive only the group under test; competing screen admission is checked directly.
  engine.schedule = () => {};
  engine.s.setup!.checks = engine.s.tools.map(tool => ({ id: tool.id as CheckId, status: "ready", at: Date.now() }));
  engine.s.tools.forEach(tool => { tool.status = "ready"; });
  engine.s.pool.limit = 3; engine.s.pool.paused = false; engine.s.pool.screen = { mode: "on" };
  engine.s.products.push({ id: "p", name: "Product", path: clone, repo: "local/product", tone: "blue", delivery: "local" });
  const task = engine.task(engine.addTask({ productId: "p", title: "Review the screen change", backlog: true }))!;
  const prerequisite = engine.addTask({ productId: "p", title: "Required screen fix", backlog: true });
  const other = engine.task(engine.addTask({ productId: "p", title: "Another screen check", backlog: true }))!;
  task.startedAt = 20; task.state = "running"; task.stageIndex = 0;
  const stage = { id: "review", kind: "review-chain" as const, title: "Review", roleId: "code-reviewer", profileIds: ["sol-xhigh", "opus-high"] };
  task.plan = { rationale: "Review the prepared change", plannerProfileId: "sol-high", stages: [stage] };
  task.hunt = { stageId: stage.id, round: 1, reported: {} };
  Object.assign(executionFor(task).work, { worktree: clone, branch: "main", base: "main", baseSha: base, report: { summary: "Prepared change", changes: [] } });
  other.startedAt = 25; other.state = "running";
  const hold = () => engine.setRuntimeWait(task.id, [prerequisite], "Wait for the required screen fix", "hold");
  return { engine, fakes, task, other, hold };
}

describe.concurrent("screen ownership while a review closes", () => {
  it.each([false, true])("keeps the screen until an admitted reviewer's cleanup settles after its peer fails (held: %s)", async held => {
    const f = await fixture();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let stopping = false;
    const owned: ChildProcess[] = [];
    try {
      f.engine.startDriver(f.task.id);
      await waitFor(() => f.fakes.received("code reviewer").length === 2, "the prepared review's two stand-ins to start");
      const first = f.fakes.received("code reviewer").find(entry => JSON.parse(readFileSync(join(f.fakes.dir, "conversations", `${entry.session}.json`), "utf8")).model === "gpt-6.1-sol")!;
      writeFileSync(join(f.fakes.dir, `release-${first.session}`), "go");
      await waitFor(() => existsSync(join(f.fakes.dir, `on-screen-${first.session}`)), "the admitted reviewer to use its stand-in screen");
      const runs = [...f.engine.helperRuns.get(f.task.id)!];
      owned.push(...runs.map(run => nativeAgentProcess(run)));
      const holder = runs.find(run => run.sessionId === first.session)!;
      const peer = runs.find(run => run !== holder)!;
      const stop = holder.stop.bind(holder);
      holder.stop = async (...args) => { stopping = true; await gate; return stop(...args); };
      if (held) f.hold();
      expect(f.task.screen?.granted).toBe(true);
      peer.close();
      await waitFor(() => stopping && !f.engine.screenGroups.has(f.task.id), "the failed group to await its screen holder's cleanup after deregistering");
      expect(f.engine.drivers.has(f.task.id)).toBe(true);
      expect(f.engine.settling.has(f.task.id)).toBe(true);
      f.engine.syncScreen();
      expect(f.engine.askScreen(f.other, "builder", "sol-high", "Check another window")).toBe(false);
      expect(onScreen(f.engine.getState().tasks)?.id).toBe(f.task.id);
      expect(f.other.screen?.granted).not.toBe(true);
      release();
      await f.engine.settling.get(f.task.id);
      expect(f.task.state).toBe("failed");
      expect(f.task.screen).toBeUndefined();
      expect(f.engine.helperRuns.has(f.task.id)).toBe(false);
      expect(f.engine.runs.has(f.task.id)).toBe(false);
      expect(f.engine.askScreen(f.other, "builder", "sol-high", "Check another window")).toBe(true);
      expect(onScreen(f.engine.getState().tasks)?.id).toBe(f.other.id);
    } finally {
      release(); await f.engine.shutdown();
      expect(owned.every(child => child.exitCode !== null || child.signalCode !== null)).toBe(true);
    }
  });

  it("returns a held member's settled grant even while its live group and driver remain", async () => {
    const f = await fixture();
    const controller = new AbortController();
    let release!: () => void;
    const settling = new Promise<void>(resolve => { release = resolve; });
    try {
      f.task.screen = { reason: "Inspect the window", at: 30, roleId: "code-reviewer", profileId: "sol-xhigh", member: "review-0", granted: true };
      f.engine.drivers.set(f.task.id, controller); f.engine.settling.set(f.task.id, settling);
      f.engine.screenGroups.set(f.task.id, { continue: () => {}, running: () => false, recipients: () => [], finished: () => {} });
      f.hold(); f.engine.syncScreen();
      expect(f.task.screen.granted).toBe(false);
      expect(f.engine.askScreen(f.other, "builder", "sol-high", "Check another window")).toBe(true);
    } finally {
      release(); f.engine.drivers.delete(f.task.id); f.engine.settling.delete(f.task.id); f.engine.screenGroups.delete(f.task.id);
      await f.engine.shutdown();
    }
  });
});
