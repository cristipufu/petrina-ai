import { afterAll, describe, expect, it, spyOn } from "bun:test";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CheckId, DeepMutable, TaskRepository } from "@petrina/core";
import { Engine } from "../../engine.js";
import { acceptanceAgents } from "../../fixtures/acceptance-agents.js";
import { ScriptedAgents } from "../../scripted-agents.js";
import { ReleaseEvents } from "../../release-events.js";
import { executionFor } from "@petrina/orchestrator";
import * as gitOps from "@petrina/repositories/git";
import { FAKE_AGENT, Fakes, git, makeProduct, removeDir, tempDir, waitFor } from "../../fixtures.js";

const roots: string[] = [];
afterAll(() => roots.forEach(removeDir));

/** A Builder's real driver and failure/retry path, stopped at its first new review. */
async function fixture(nativeStartup = false) {
  const root = tempDir("petrina-wait-partial-recovery-"); roots.push(root);
  const home = join(root, "data"), native = new Fakes(join(root, "fake"));
  const releases = new ReleaseEvents(), marked = new Set<string>();
  let failReply = true;
  const replies = acceptanceAgents(); replies.configure({ builder: "plain", reopen: "resume" });
  const agents = new ScriptedAgents(async (prompt, signal) => {
    if (prompt.result !== "build") throw new Error(`Unexpected partial-recovery provider: ${prompt.result}`);
    marked.add(`working-${prompt.sessionId}`);
    const fail = failReply;
    await releases.wait(`release-${prompt.sessionId}`, signal);
    if (fail) throw new Error("The Builder stopped before finishing its partial work");
    return replies.respond(prompt, signal);
  });
  const fakes = nativeStartup ? native : {
    received: (role: string) => agents.received().filter(prompt => prompt.roleId.replaceAll("-", " ") === role).map(prompt => ({ ...prompt, session: prompt.sessionId })),
    marked: (key: string) => marked.has(key),
  };
  const startupGate = join(root, "builder-startup");
  const script = (fail: boolean) => { failReply = fail; native.scenario({ builder: "plain", reopen: "resume", nativeRetry: [{ role: "builder", steps: [
    { mark: "working-{session}" }, { wait: "release-{session}" },
    ...(fail ? [{ fail: { code: -32603, message: "The Builder stopped before finishing its partial work" } }] : []),
  ] }] }); };
  script(true);
  const open = async () => {
    const owner = new Engine(home, { agentCommand: () => [process.execPath, FAKE_AGENT, native.dir, ...(existsSync(startupGate) ? [`--hold-open=${startupGate}`] : [])], toolPath: () => process.execPath, terminals: () => [], ...(nativeStartup ? {} : { startAgentSession: agents.start }) });
    owner.schedule = () => {};
    await owner.waitUntilReady();
    owner.s.setup!.checks = owner.s.tools.map(tool => ({ id: tool.id as CheckId, status: "ready", at: Date.now() }));
    owner.s.tools.forEach(tool => { tool.status = "ready"; });
    return owner;
  };
  let engine = await open();
  const path = await makeProduct(join(root, "product"));
  const product = { id: "p", name: "Product", path, repo: "local/product", tone: "blue" as const, defaultBranch: "main", delivery: "local" as const, remoteRefused: "Local delivery only", checks: [] };
  engine.s.products.push(product);
  const id = engine.addTask({ productId: product.id, title: "Keep the Builder's unfinished changes", backlog: true });
  const prerequisite = engine.addTask({ productId: product.id, title: "Land the required source", backlog: true });
  let task = engine.task(id)!, scope = executionFor(task);
  const worktree = join(root, "work"), branch = "task-change", base = await git(path, "rev-parse", "HEAD");
  await git(path, "worktree", "add", "-qb", branch, worktree, "main");
  Object.assign(scope.work, { worktree, branch, baseSha: base, base: "main", delivery: "local",
    source: { product: { ...product }, start: { kind: "default", branch: "main" }, destination: { mode: "local", kind: "branch", repo: product.repo, branch: "main" }, confirmed: true, initialSha: base } });
  task.startedAt = 1; task.state = "waiting"; task.stageIndex = 0;
  task.plan = { rationale: "Only partial-work recovery and the next source boundary", plannerProfileId: "sol-high", stages: [
    { id: "build", title: "Build", kind: "do", roleId: "builder", profileIds: ["sol-high"] },
    { id: "review", title: "Review", kind: "review-chain", roleId: "code-reviewer", profileIds: ["opus-high"] },
  ] };
  const admitted: { fix: boolean; partial?: string; base?: string }[] = [], reviewed: typeof admitted = [];
  const observe = () => {
    const evidence = () => ({ fix: existsSync(join(worktree, "required-fix.txt")), partial: existsSync(join(worktree, "unfinished.txt")) ? readFileSync(join(worktree, "unfinished.txt"), "utf8") : undefined, base: scope.work.baseSha });
    const attach = engine["turns"]["attachInput"].bind(engine["turns"]);
    engine["turns"]["attachInput"] = async (...args) => {
      if (args[1]?.input.roleId === "builder") admitted.push(evidence());
      return attach(...args);
    };
    engine["reviews"].runReview = async () => { reviewed.push(evidence()); return "stop"; };
  };
  observe(); engine.commitNow(task);
  return {
    root, id, prerequisite, path, worktree, base, fakes, admitted, reviewed,
    engine: () => engine, task: () => task, scope: () => scope,
    script,
    holdStartup() { writeFileSync(startupGate, "Hold the actual native session/new reply"); },
    startupReached: () => waitFor(() => existsSync(`${startupGate}.reached`), "the admitted Builder to wait for its native conversation"),
    unblockStartup() { rmSync(startupGate, { force: true }); },
    drive() { engine.startDriver(id); return engine.settling.get(id)!; },
    started: (index: number) => waitFor(() => {
      if (task.state === "failed") throw new Error(`Builder attempt ${index + 1} was not admitted: ${task.error}`);
      const prompt = fakes.received("builder")[index];
      return prompt && fakes.marked(`working-${prompt.session}`) && task.agent?.roleId === "builder" && prompt;
    }, `Builder attempt ${index + 1} to receive input`),
    unblock: (session: string) => { writeFileSync(join(native.dir, `release-${session}`), "go"); releases.release(`release-${session}`); },
    hold() { engine.setRuntimeWait(id, [prerequisite], "The next new step needs the source fix", "partial-hold"); },
    async land() { writeFileSync(join(path, "required-fix.txt"), "The required source fix\n"); await git(path, "add", "."); await git(path, "commit", "-qm", "Land the required source fix"); return git(path, "rev-parse", "HEAD"); },
    release(how: "clear" | "landed", latest: string) {
      if (how === "clear") engine.setRuntimeWait(id, [], "The required source is available", "partial-clear");
      else { const required = engine.task(prerequisite)!; required.repository!.delivery = "local"; required.repository!.landed = { branch: "main", sha: latest }; required.state = "done"; engine["driver"].syncRuntimeWaits(); }
    },
    async retry() {
      const stuck = engine.s.inbox.find(item => item.taskId === id && item.kind === "stuck");
      expect(stuck).toBeDefined(); await engine.retry(stuck!.id);
    },
    async restart() { await engine.shutdown(); engine = await open(); task = engine.task(id)!; scope = executionFor(task); observe(); },
  };
}

describe.concurrent("unfinished Builder work after a prerequisite wait", () => {
  for (const scenario of [
    { timing: "after failure", how: "clear", restart: false, dirty: true },
    { timing: "after failure", how: "landed", restart: true, dirty: true },
    { timing: "during startup", how: "clear", restart: false, dirty: true },
    { timing: "during startup", how: "landed", restart: true, dirty: true },
    { timing: "after failure", how: "clear", restart: false, dirty: false },
    { timing: "during startup", how: "landed", restart: false, dirty: false },
  ] as const) it(`recovers its admitted attempt when the wait is added ${scenario.timing} (${scenario.how}, restart: ${scenario.restart}, partial changes: ${scenario.dirty})`, async () => {
    const f = await fixture(scenario.timing === "during startup");
    let drive: Promise<void> | undefined;
    try {
      let latest = f.base;
      if (scenario.timing === "during startup") f.holdStartup();
      drive = f.drive();
      if (scenario.timing === "during startup") {
        await f.startupReached();
        expect(f.task().agent?.roleId).toBe("builder");
        expect(f.task().holdsSlot).toBe(true);
        expect(f.task().statusLine).toBe("Builder is starting");
        expect(f.scope().work.conversation).toBeUndefined();
        expect(f.task().journey!.flatMap(step => step.agentInputs ?? [])).toEqual([]);
        expect(f.admitted).toEqual([]);
        f.hold(); latest = await f.land(); f.release(scenario.how, latest);
        f.unblockStartup();
      }
      const first = await f.started(0);
      expect(f.admitted).toEqual([{ fix: false, partial: undefined, base: f.base }]);
      if (scenario.dirty) writeFileSync(join(f.worktree, "unfinished.txt"), "First early partial edit\n");
      f.unblock(first.session); await drive;
      expect(f.task().state).toBe("failed");
      expect(f.task().error).toContain("The Builder stopped before finishing its partial work");
      if (scenario.timing === "after failure") {
        f.hold(); latest = await f.land(); f.release(scenario.how, latest);
      }
      expect(f.task().runtimeWait?.refreshPending).toBe(true);
      expect(f.scope().work.baseSha).toBe(f.base);
      if (scenario.restart) await f.restart();

      // A repeated failure must retain the same editable attempt's partial-work ownership.
      await f.retry(); drive = f.drive();
      const second = await f.started(1);
      const recovery = { fix: !scenario.dirty, partial: scenario.dirty ? "First early partial edit\n" : undefined, base: scenario.dirty ? f.base : latest };
      expect(f.admitted[1]).toEqual(recovery);
      expect(f.reviewed).toEqual([]);
      if (scenario.dirty) writeFileSync(join(f.worktree, "unfinished.txt"), "Second early partial edit\n");
      f.unblock(second.session); await drive;
      expect(f.task().state).toBe("failed");
      expect(f.task().error).toContain("The Builder stopped before finishing its partial work");
      f.script(false); await f.retry(); drive = f.drive();
      const final = await f.started(2);
      expect(f.admitted[2]).toEqual({ ...recovery, partial: scenario.dirty ? "Second early partial edit\n" : undefined });
      f.unblock(final.session); await drive;
      expect(f.task().error).toBeUndefined();
      expect(f.reviewed).toEqual([{ fix: true, partial: scenario.dirty ? "Second early partial edit\n" : undefined, base: latest }]);
      expect(await git(f.worktree, "status", "--porcelain")).toBe("");
      if (scenario.dirty) expect(await git(f.worktree, "show", "HEAD:unfinished.txt")).toBe("Second early partial edit");
      expect(await git(f.worktree, "merge-base", "HEAD", latest)).toBe(latest);
      expect(f.task().runtimeWait?.refreshPending).toBeUndefined();
      expect(f.scope().work.editAttempt).toBeUndefined();
      expect(f.task().runtimeWait?.changes).toHaveLength(scenario.how === "clear" ? 2 : 1);
      expect(f.task().rounds).toEqual({});
      const inputs = f.task().journey!.flatMap(step => step.agentInputs ?? []).filter(input => input.roleId === "builder");
      expect(inputs).toHaveLength(3);
      expect(new Set(inputs.map(input => input.sessionId)).size).toBe(3);
      expect(inputs.every(input => input.mode === "fresh")).toBe(true);
      expect(inputs.some(input => /wait|rethink/i.test(input.freshReason ?? ""))).toBe(false);
      expect(f.task().journey!.flatMap(step => step.agentResults ?? []).filter(result => result.roleId === "builder")).toHaveLength(1);
    } finally {
      f.unblockStartup();
      for (const prompt of f.fakes.received("builder")) f.unblock(prompt.session);
      await f.engine().shutdown(); await drive;
    }
  });

  it("refuses unrelated dirty work without an admitted editable attempt", async () => {
    const f = await fixture();
    let drive: Promise<void> | undefined;
    try {
      writeFileSync(join(f.worktree, "unfinished.txt"), "An unrelated edit predating any attempt\n");
      f.hold(); const latest = await f.land(); f.release("clear", latest);
      for (let attempt = 0; attempt < 2; attempt++) {
        if (attempt) await f.retry();
        drive = f.drive(); await drive;
        expect(f.task().state).toBe("failed");
        expect(f.task().error).toContain("The working copy has changes Petrina did not commit");
        expect(f.task().runtimeWait?.refreshPending).toBe(true);
        expect(f.scope().work.editAttempt).toBeUndefined();
        expect(f.admitted).toEqual([]);
        expect(f.reviewed).toEqual([]);
        expect(f.scope().work.baseSha).toBe(f.base);
        expect(readFileSync(join(f.worktree, "unfinished.txt"), "utf8")).toBe("An unrelated edit predating any attempt\n");
      }
    } finally { await f.engine().shutdown(); await drive; }
  });

  for (const scenario of [
    { how: "clear", recovery: "retry", dirty: true },
    { how: "landed", recovery: "retry", dirty: true },
    { how: "clear", recovery: "restart", dirty: true },
    { how: "landed", recovery: "pause-and-restart", dirty: true },
    { how: "none", recovery: "retry", dirty: true },
    { how: "clear", recovery: "retry", dirty: false },
  ] as const) it(`recovers its own partial attempt before new work (${scenario.how}, ${scenario.recovery}, partial changes: ${scenario.dirty})`, async () => {
    const f = await fixture();
    let drive: Promise<void> | undefined;
    try {
      drive = f.drive(); const first = await f.started(0);
      const original = structuredClone(f.task().journey!.findLast(step => step.roleId === "builder")!);
      let latest = f.base;
      if (scenario.how !== "none") { f.hold(); latest = await f.land(); f.release(scenario.how, latest); }
      if (scenario.dirty) writeFileSync(join(f.worktree, "unfinished.txt"), "First partial edit\n");
      f.unblock(first.session); await drive;
      expect(f.task().state).toBe("failed");
      expect(f.task().error).toContain("The Builder stopped before finishing its partial work");
      expect(f.scope().work.baseSha).toBe(f.base);
      if (scenario.how !== "none") expect(f.task().runtimeWait?.refreshPending).toBe(true);
      if (scenario.recovery === "restart") await f.restart();
      await f.retry();
      if (scenario.recovery === "pause-and-restart") {
        f.engine().pause(f.id); await f.restart();
        expect(f.task().state).toBe("paused"); f.engine().resume(f.id);
      }
      const count = f.admitted.length;
      f.script(true); drive = f.drive();
      const retried = await waitFor(() => {
        if (f.task().state === "failed") throw new Error(`Retry did not admit the Builder: ${f.task().error}`);
        return f.fakes.received("builder")[1] && f.fakes.marked(`working-${f.fakes.received("builder")[1]!.session}`) && f.fakes.received("builder")[1];
      }, "the failed Builder to retry on its preserved work");
      expect(f.admitted).toHaveLength(count + 1);
      expect(f.admitted[1]).toEqual({ fix: scenario.how !== "none" && !scenario.dirty, partial: scenario.dirty ? "First partial edit\n" : undefined, base: scenario.dirty ? f.base : latest });
      expect(f.reviewed).toEqual([]);
      if (scenario.dirty) writeFileSync(join(f.worktree, "unfinished.txt"), "Second partial edit\n");
      f.unblock(retried.session); await drive;
      expect(f.task().state).toBe("failed");
      expect(f.task().error).toContain("The Builder stopped before finishing its partial work");
      await f.retry(); f.script(false); drive = f.drive();
      const final = await f.started(2); f.unblock(final.session); await drive;
      expect(f.task().error).toBeUndefined();
      expect(f.reviewed).toEqual([{ fix: scenario.how !== "none", partial: scenario.dirty ? "Second partial edit\n" : undefined, base: latest }]);
      expect(await git(f.worktree, "status", "--porcelain")).toBe("");
      if (scenario.dirty) expect(await git(f.worktree, "show", "HEAD:unfinished.txt")).toBe("Second partial edit");
      if (scenario.how !== "none") {
        expect(f.task().runtimeWait?.refreshPending).toBeUndefined();
        expect(f.task().runtimeWait?.changes).toHaveLength(scenario.how === "clear" ? 2 : 1);
        expect(await git(f.worktree, "merge-base", "HEAD", latest)).toBe(latest);
      }
      expect(f.task().rounds).toEqual({});
      const inputs = f.task().journey!.flatMap(step => step.agentInputs ?? []).filter(input => input.roleId === "builder");
      expect(inputs).toHaveLength(3);
      expect(new Set(inputs.map(input => input.sessionId)).size).toBe(3);
      expect(inputs.every(input => input.mode === "fresh")).toBe(true);
      expect(inputs.some(input => /wait|rethink/i.test(input.freshReason ?? ""))).toBe(false);
      expect(f.task().journey!.flatMap(step => step.agentResults ?? []).filter(result => result.roleId === "builder")).toHaveLength(1);
      const retained = f.task().journey!.find(step => step.id === original.id)!;
      expect(retained.startedAt).toBe(original.startedAt);
      expect(retained.agentInputs?.slice(0, original.agentInputs?.length)).toEqual(original.agentInputs);
      expect(retained.end).toBe("failed");
    } finally {
      for (const prompt of f.fakes.received("builder")) f.unblock(prompt.session);
      await f.engine().shutdown(); await drive;
    }
  });

  it("rechecks a replaced wait after inspecting whether a failed attempt still has partial work", async () => {
    const f = await fixture(), inspected = Promise.withResolvers<void>(), releaseInspection = Promise.withResolvers<void>();
    let drive: Promise<void> | undefined, restore = () => {};
    try {
      drive = f.drive(); const first = await f.started(0);
      f.hold(); const latest = await f.land(); f.release("clear", latest);
      const partial = join(f.worktree, "unfinished.txt");
      writeFileSync(partial, "The Builder's unfinished attempt\n");
      f.unblock(first.session); await drive;
      expect(f.task().state).toBe("failed");
      expect(f.scope().work.editAttempt?.failed).toBe(true);
      // The coordinator removes only this test's untracked draft; no completed commit is invented.
      rmSync(partial);
      expect(await git(f.worktree, "status", "--porcelain")).toBe("");
      const isClean = gitOps.isClean;
      let held = false;
      const clean = spyOn(gitOps, "isClean").mockImplementation(async path => {
        const result = await isClean(path);
        if (path === f.worktree && !held) {
          held = true; expect(result).toBe(true); inspected.resolve(); await releaseInspection.promise;
        }
        return result;
      });
      restore = () => clean.mockRestore();
      f.script(false); await f.retry(); drive = f.drive();
      await inspected.promise;
      const originalWait = f.task().runtimeWait!, recovery = structuredClone(f.scope().work.editAttempt);
      f.engine().setRuntimeWait(f.id, [f.prerequisite], "Recheck the required source before recovery", "replacement-hold");
      f.engine().setRuntimeWait(f.id, [], "The required source is available for recovery", "replacement-clear");
      expect(f.task().runtimeWait).not.toBe(originalWait);
      expect(f.scope().work.editAttempt).toEqual(recovery);
      expect(f.admitted).toHaveLength(1);
      releaseInspection.resolve();
      const recovered = await f.started(1);
      expect(f.admitted[1]).toEqual({ fix: true, partial: undefined, base: latest });
      f.unblock(recovered.session); await drive;
      expect(f.task().error).toBeUndefined();
      expect(f.reviewed).toEqual([{ fix: true, partial: undefined, base: latest }]);
      expect(f.task().runtimeWait?.changes).toHaveLength(4);
      expect(f.task().runtimeWait?.refreshPending).toBeUndefined();
      expect(f.scope().work.editAttempt).toBeUndefined();
      expect(f.task().rounds).toEqual({});
      const steps = f.task().journey!.filter(step => step.roleId === "builder");
      expect(steps.map(step => step.end)).toEqual(["failed", "done"]);
      expect(steps.flatMap(step => step.agentResults ?? [])).toHaveLength(1);
      expect(await git(f.worktree, "merge-base", "HEAD", latest)).toBe(latest);
    } finally {
      releaseInspection.resolve();
      for (const prompt of f.fakes.received("builder")) f.unblock(prompt.session);
      await f.engine().shutdown(); await drive; restore();
    }
  });

  it("keeps a strict source failure visible after the partial Builder work has recovered", async () => {
    const f = await fixture();
    let drive: Promise<void> | undefined;
    try {
      drive = f.drive(); const first = await f.started(0);
      f.hold(); const latest = await f.land(); f.release("clear", latest);
      writeFileSync(join(f.worktree, "unfinished.txt"), "The Builder's kept edit\n");
      f.unblock(first.session); await drive;
      expect(f.task().state).toBe("failed");
      f.scope().work.delivery = "pull-request";
      const fetch = f.engine()["connections"].fetchDefault.bind(f.engine()["connections"]);
      f.engine()["connections"].fetchDefault = async () => ({ ok: false, missing: true, error: "The required source could not be reached" });
      f.script(false); await f.retry(); drive = f.drive();
      const recovered = await waitFor(() => {
        if (f.task().state === "failed") throw new Error(`The partial attempt was not allowed to recover: ${f.task().error}`);
        return f.fakes.received("builder")[1] && f.fakes.marked(`working-${f.fakes.received("builder")[1]!.session}`) && f.fakes.received("builder")[1];
      }, "the partial Builder attempt to recover before a new source check");
      expect(f.admitted[1]).toEqual({ fix: false, partial: "The Builder's kept edit\n", base: f.base });
      f.unblock(recovered.session); await drive;
      expect(f.task().state).toBe("failed");
      expect(f.task().error).toContain("could not get the latest starting code");
      expect(f.task().runtimeWait?.refreshPending).toBe(true);
      expect(f.reviewed).toEqual([]);
      expect(await git(f.worktree, "status", "--porcelain")).toBe("");
      expect(await git(f.worktree, "show", "HEAD:unfinished.txt")).toBe("The Builder's kept edit");
      f.engine()["connections"].fetchDefault = fetch;
      f.scope().work.delivery = "local";
      await f.retry(); drive = f.drive(); await drive;
      expect(f.task().error).toBeUndefined();
      expect(f.reviewed).toEqual([{ fix: true, partial: "The Builder's kept edit\n", base: latest }]);
      expect(f.fakes.received("builder")).toHaveLength(2);
      expect(f.task().runtimeWait?.refreshPending).toBeUndefined();
      expect(f.task().rounds).toEqual({});
    } finally {
      for (const prompt of f.fakes.received("builder")) f.unblock(prompt.session);
      await f.engine().shutdown(); await drive;
    }
  });

  it("keeps recovery on its own product while a clean companion receives its required source", async () => {
    const f = await fixture();
    let drive: Promise<void> | undefined;
    try {
      const path = await makeProduct(join(f.root, "companion"));
      const product = { id: "api", name: "API", path, repo: "local/api", tone: "blue" as const, defaultBranch: "main", delivery: "local" as const, remoteRefused: "Local delivery only", checks: [] };
      const worktree = join(f.root, "api-work"), branch = "api-task", base = await git(path, "rev-parse", "HEAD");
      await git(path, "worktree", "add", "-qb", branch, worktree, "main");
      writeFileSync(join(worktree, "api-change.txt"), "The companion's completed build\n");
      await git(worktree, "add", "."); await git(worktree, "commit", "-qm", "Complete the companion build");
      const companion: DeepMutable<TaskRepository> = { productId: product.id, delivery: "local", preparation: "ready", completedStages: ["build"], worktree, branch, base: "main", baseSha: base,
        source: { product, start: { kind: "default", branch: "main" }, destination: { mode: "local", kind: "branch", repo: product.repo, branch: "main" }, confirmed: true, initialSha: base } };
      f.engine().s.products.push(product);
      Object.assign(f.scope().work, { completedStages: [], preparation: "ready" });
      f.task().repositories = [f.scope().work as DeepMutable<TaskRepository>, companion];
      delete f.task().repository; f.task().leadProductId = "p"; f.task().activeProductId = "p";
      drive = f.drive(); const first = await f.started(0);
      f.hold(); const latest = await f.land();
      writeFileSync(join(path, "companion-fix.txt"), "The companion's required source\n");
      await git(path, "add", "."); await git(path, "commit", "-qm", "Land the companion source");
      const companionLatest = await git(path, "rev-parse", "HEAD");
      f.release("clear", latest);
      writeFileSync(join(f.worktree, "unfinished.txt"), "The first product's partial edit\n");
      f.unblock(first.session); await drive;
      expect(f.task().state).toBe("failed");
      f.script(false); await f.retry(); drive = f.drive();
      const recovered = await waitFor(() => {
        if (f.task().state === "failed") throw new Error(`The shared task did not recover: ${f.task().error}`);
        return f.fakes.received("builder")[1] && f.fakes.marked(`working-${f.fakes.received("builder")[1]!.session}`) && f.fakes.received("builder")[1];
      }, "the failed product alone to recover its partial work");
      expect(f.admitted[1]).toEqual({ fix: false, partial: "The first product's partial edit\n", base: f.base });
      f.unblock(recovered.session); await drive;
      expect(f.task().error).toBeUndefined();
      expect(f.task().repositories![1]!.baseSha).toBe(companionLatest);
      expect(await git(worktree, "show", "HEAD:companion-fix.txt")).toBe("The companion's required source");
      expect(await git(worktree, "show", "HEAD:api-change.txt")).toBe("The companion's completed build");
      expect(f.reviewed).toEqual([{ fix: true, partial: "The first product's partial edit\n", base: latest }]);
      expect(f.task().repositories!.map(work => work.completedStages)).toEqual([["build"], ["build"]]);
      expect(f.task().runtimeWait?.refreshPending).toBeUndefined();
      expect(f.task().rounds).toEqual({});
      expect(f.fakes.received("builder")).toHaveLength(2);
    } finally {
      for (const prompt of f.fakes.received("builder")) f.unblock(prompt.session);
      await f.engine().shutdown(); await drive;
    }
  });
});
