import { afterAll, describe, expect, it } from "bun:test";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { slotUses, type CheckId } from "@petrina/core";
import { Engine } from "./engine.js";
import { executionFor } from "../src/repository-context.js";
import { FAKE_AGENT, Fakes, git, makeProduct, removeDir, tempDir, waitFor } from "./fixtures.js";

const roots: string[] = [];
afterAll(() => roots.forEach(removeDir));

/** A real saved Builder, native readiness handshake and driver; no unrelated planning or review. */
async function fixture(inTurn = false) {
  const root = tempDir("petrina-wait-readiness-"); roots.push(root);
  const fakes = new Fakes(join(root, "fake")); fakes.scenario({ builder: "plain", reopen: "resume" });
  const gate = join(root, "readiness-held");
  let checking = false;
  const engine = new Engine(join(root, "data"), {
    agentCommand: profile => [process.execPath, FAKE_AGENT, fakes.dir, `--record-tool=${profile.toolId}`, ...(checking && profile.toolId === "codex" ? [`--hold-open-in-checks=${gate}`] : [])],
    toolPath: () => "/bin/true",
  });
  engine.schedule = () => {};
  await engine.waitUntilReady();
  engine.s.setup!.checks = engine.s.tools.map(tool => ({ id: tool.id as CheckId, status: "ready", at: Date.now() }));
  engine.s.tools.forEach(tool => { tool.status = "ready"; });
  const path = await makeProduct(join(root, "product"));
  const product = { id: "p", name: "Product", path, repo: "local/product", tone: "blue" as const, defaultBranch: "main", remoteRefused: "Local delivery only", checks: [] };
  engine.s.products.push(product);
  const id = engine.addTask({ productId: "p", title: "Resume the saved Builder", backlog: true });
  const prerequisite = engine.addTask({ productId: "p", title: "Land the required source", backlog: true });
  const task = engine.task(id)!, scope = executionFor(task);
  const worktree = join(root, "work"), branch = "task-change", base = await git(path, "rev-parse", "HEAD");
  await git(path, "worktree", "add", "-qb", branch, worktree, "main");
  Object.assign(scope.work, { worktree, branch, baseSha: base, base: "main", delivery: "local",
    source: { product: { ...product }, start: { kind: "default", branch: "main" }, destination: { mode: "local", kind: "branch", repo: product.repo, branch: "main" }, confirmed: true, initialSha: base } });
  const build = { id: "build", title: "Build", kind: "do" as const, roleId: "builder", profileIds: ["sol-high"] };
  task.plan = { rationale: "The next Builder return needs current source", plannerProfileId: "sol-high", stages: [build,
    { id: "review", title: "Review", kind: "review-chain", roleId: "code-reviewer", profileIds: ["opus-high"] },
  ] };
  task.startedAt = 1; task.state = "running"; task.stageIndex = 0;
  await engine["work"].runDo(scope, build, new AbortController().signal);
  const saved = scope.work.builderSession!.sessionId;
  task.stageIndex = 0; task.fixing = true; task.holdsSlot = true;
  task.agent = { roleId: "code-reviewer", profileId: "opus-high", since: Date.now(), step: 0 };
  const check = engine.s.setup!.checks.find(check => check.id === "codex")!;
  Object.assign(check, { status: "unknown", at: Date.now() - 10 * 60_000, detail: "An older inconclusive answer" });
  checking = true; writeFileSync(gate, "Hold the readiness handshake");
  // This variant reaches the sibling readiness boundary inside Turns, after driver selection.
  if (inTurn) engine["driver"]["seatFor"] = () => ({ agent: { roleId: "builder", profileId: "sol-high" }, toolId: "codex" });
  engine["reviews"].runReview = async () => "stop";
  const admitted: { fix: boolean; base?: string }[] = [];
  const attach = engine["turns"]["attachInput"].bind(engine["turns"]);
  engine["turns"]["attachInput"] = async (...args) => {
    if (args[1]?.input.roleId === "builder") admitted.push({ fix: existsSync(join(worktree, "required-fix.txt")), base: scope.work.baseSha });
    return attach(...args);
  };
  return { engine, task, scope, prerequisite, admitted, saved, fakes, base,
    drive: () => engine["driver"]["drive"](id),
    reached: () => waitFor(() => existsSync(`${gate}.reached`), "the saved Builder's readiness handshake"),
    unblock: () => rmSync(gate, { force: true }),
    hold() { engine.setRuntimeWait(id, [prerequisite], "This Builder needs the source fix", "readiness-hold"); engine["driver"].syncRuntimeWaits(); },
    async land() { writeFileSync(join(path, "required-fix.txt"), "The required source fix\n"); await git(path, "add", "."); await git(path, "commit", "-qm", "Land the required source fix"); return git(path, "rev-parse", "HEAD"); },
    release(how: "clear" | "landed", latest: string) {
      if (how === "clear") engine.setRuntimeWait(id, [], "The required source is available", "readiness-clear");
      else { const required = engine.task(prerequisite)!; required.repository!.delivery = "local"; required.repository!.landed = { branch: "main", sha: latest }; required.state = "done"; engine["driver"].syncRuntimeWaits(); }
    },
    checks: () => readFileSync(join(fakes.dir, "checks.jsonl"), "utf8").trim().split("\n"),
    answered: () => waitFor(() => engine.s.setup!.checks.find(check => check.id === "codex")?.status === "ready" && !engine["tools"].running("codex"), "the shared readiness answer"),
  };
}

describe.concurrent("a wait released during Builder readiness", () => {
  for (const [how, inTurn] of [["clear", false], ["landed", false], ["held", false], ["none", false], ["clear", true]] as const) it(`revalidates source before Builder input (${how}, inside turn: ${inTurn})`, async () => {
    const f = await fixture(inTurn);
    let drive: Promise<void> | undefined;
    try {
      drive = f.drive(); await f.reached();
      expect(f.admitted).toEqual([]);
      let latest = f.base;
      if (how !== "none") { f.hold(); latest = await f.land(); }
      if (how === "clear" || how === "landed") f.release(how, latest);
      f.unblock(); await drive; await f.answered();
      if (how === "held") {
        expect(f.admitted).toEqual([]); expect(f.task.state).toBe("waiting");
        f.release("clear", latest); await f.drive();
      } else if (how === "none") expect(f.admitted).toHaveLength(1);
      else if (!f.admitted.length) await f.drive();
      expect(f.task.error).toBeUndefined();
      expect(f.admitted).toEqual([{ fix: how !== "none", base: latest }]);
      expect(f.scope.work.builderSession?.sessionId).toBe(f.saved);
      expect(f.checks()).toHaveLength(1);
      expect(f.fakes.received("builder")).toHaveLength(2);
      expect(f.task.journey!.flatMap(step => step.agentResults ?? []).filter(result => result.roleId === "builder")).toHaveLength(2);
      if (how !== "none") expect(f.task.runtimeWait?.refreshPending).toBeUndefined();
    } finally { f.unblock(); await f.engine.shutdown(); await drive; }
  });

  for (const how of ["held", "clear", "landed"] as const) it(`frees an unused readiness reservation for queued work before the tool replies (${how})`, async () => {
    const f = await fixture();
    let drive: Promise<void> | undefined;
    try {
      f.engine.s.pool.paused = false;
      f.engine.s.pool.limit = 1;
      drive = f.drive(); await f.reached();
      expect(f.task.holdsSlot).toBe(true);
      expect(f.admitted).toEqual([]);
      f.fakes.scenario({ controlled: true, builder: "plain", reopen: "resume" });
      const queued = f.engine.addTask({ productId: "p", title: "Use the freed place" });
      f.engine["driver"].schedule();
      expect(f.engine.task(queued)!.state).toBe("queued");
      f.hold();
      // Releasing the task's admission owner does not end the tool check, even before the old driver settles.
      expect(f.task.state).toBe("waiting");
      expect(f.task.holdsSlot).toBe(false);
      expect(f.task.agent).toBeUndefined();
      expect(f.engine["tools"].running("codex")).toBeDefined();
      await drive;
      f.engine["driver"].schedule();
      await waitFor(() => f.fakes.received("planner").length === 1, "the queued task's Planner in the freed place");
      expect(slotUses(f.engine.activeState()).map(use => use.taskId)).toEqual([queued]);
      const latest = await f.land();
      if (how !== "held") f.release(how, latest);
      f.engine["driver"].schedule();
      expect(f.admitted).toEqual([]);
      f.unblock(); await f.answered();
      f.engine["driver"].schedule();
      expect(f.admitted).toEqual([]);
      expect(f.task.holdsSlot).toBe(false);
      expect(slotUses(f.engine.activeState()).map(use => use.taskId)).toEqual([queued]);
      expect(f.checks()).toHaveLength(1);
      if (how === "held") f.release("clear", latest);
      f.engine.pause(queued);
      await waitFor(() => !f.engine.drivers.has(queued) && !f.engine.settling.has(queued), "the queued task's pause and cleanup");
      f.fakes.scenario({ builder: "plain", reopen: "resume" });
      f.engine["driver"].schedule();
      await waitFor(() => f.admitted.length === 1, "the returning Builder's fresh admission");
      expect(f.admitted).toEqual([{ fix: true, base: latest }]);
      await waitFor(() => !f.engine.drivers.has(f.task.id) && !f.engine.settling.has(f.task.id), "the returning Builder to complete its step");
      expect(f.task.error).toBeUndefined();
      expect(f.scope.work.builderSession?.sessionId).toBe(f.saved);
      expect(f.fakes.received("builder")).toHaveLength(2);
      expect(f.task.journey!.flatMap(step => step.agentResults ?? []).filter(result => result.roleId === "builder")).toHaveLength(2);
      expect(f.checks()).toHaveLength(1);
    } finally { f.unblock(); await f.engine.shutdown(); await drive; }
  });
});
