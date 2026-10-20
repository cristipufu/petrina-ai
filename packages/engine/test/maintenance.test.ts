import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { draftOf, MAINTENANCE_ROLES, type RoutineDraft, type Task } from "@petrina/core";
import { makeWorld, Fakes, FAKE_AGENT, until, removeDir } from "./support.js";
import { normalizePlan } from "../src/plan.js";
import { plannerRoles } from "../src/roles.js";
import type { Engine } from "../src/engine.js";
import { git } from "./support.js";

function setup(name: string, behavior: Parameters<Fakes["scenario"]>[0]["maintenance"], objectFormat?: "sha1" | "sha256") {
  const world = makeWorld(`maintenance-${name}`, { objectFormat }), fakes = new Fakes(join(world.dir, "agents"));
  fakes.scenario({ maintenance: behavior });
  const start = (onlyTool?: string) => {
    const engine = world.start({ agentCommand: profile => [process.execPath, FAKE_AGENT, fakes.dir, `--record-tool=${profile.toolId}`, ...(onlyTool && onlyTool !== profile.toolId ? ["--logged-out"] : [])], toolPath: () => process.execPath });
    engine.setPoolPaused(true);
    return engine;
  };
  return { world, fakes, start };
}
async function create(engine: Engine, clone: string, roleId = "maintenance-bug-finder", profileId = "sol-medium") {
  const productId = await engine.addProduct(clone);
  engine.setProductChecks(productId, [{ name: "Tests", command: `${process.execPath} -e 'process.exit(0)'` }]);
  const draft: RoutineDraft = { name: "Focused maintenance", productId, roleId, profileId, focus: "Inspect checkout behavior", zone: "UTC", schedule: { kind: "daily", time: "09:00" }, enabled: true };
  const routineId = engine.saveRoutine(draft);
  const due = engine.getState().routines!.find(r => r.id === routineId)!.nextAt;
  engine.pollRoutines(due);
  const taskId = engine.getState().routines!.find(r => r.id === routineId)!.latestTaskId!;
  return { productId, routineId, taskId, due, draft };
}
async function result(engine: Engine, taskId: string): Promise<Task> {
  await until(engine, () => ["done", "failed", "needs-you", "cancelled"].includes(engine.taskDetails(taskId)?.state ?? ""), () => {});
  return engine.taskDetails(taskId)!;
}

describe("real queue maintenance", () => {
  for (const format of ["sha1", "sha256"] as const) {
    it(`reviews committed maintenance changes in a ${format} product`, async () => {
      const { world, fakes, start } = setup(`committed-${format}`, { change: true, commit: true }, format); const engine = start();
      try {
        const run = await create(engine, world.clone, "maintenance-dead-code"); engine.setPoolPaused(false);
        const task = await result(engine, run.taskId);
        expect(task.error).toBeUndefined(); expect(task.state).toBe("needs-you");
        expect(task.baseSha).toHaveLength(format === "sha256" ? 64 : 40);
        expect(task.maintenance?.noProductChanges).not.toBe(true);
        expect(task.checks?.results.every(check => check.ok)).toBe(true);
        expect(fakes.received("code reviewer")).toHaveLength(2);
        expect(engine.getState().inbox.some(item => item.taskId === run.taskId && item.kind === "delivery")).toBe(true);
        expect(git(task.worktree!, "show", "HEAD:maintenance.txt")).toContain("Confirmed maintenance change");
      } finally { await engine.shutdown(); removeDir(world.dir); }
    });
    it(`undoes a reports-only agent's committed writes in a ${format} product`, async () => {
      const { world, start } = setup(`read-only-commit-${format}`, { readOnlyWrite: true, commit: true }, format); const engine = start();
      try {
        const run = await create(engine, world.clone); engine.setPoolPaused(false);
        const task = await result(engine, run.taskId);
        expect(task.state).toBe("failed"); expect(task.error).toContain("read-only");
        expect(task.maintenance?.noProductChanges).not.toBe(true);
        expect(git(task.worktree!, "rev-parse", "HEAD")).toBe(task.baseSha!);
        expect(existsSync(join(task.worktree!, "maintenance.txt"))).toBe(false);
        expect(git(task.worktree!, "status", "--porcelain")).toBe("");
      } finally { await engine.shutdown(); removeDir(world.dir); }
    });
    it(`finishes an unchanged reports-only investigation in a ${format} product`, async () => {
      const { world, fakes, start } = setup(`read-only-empty-${format}`, {}, format); const engine = start();
      try {
        const run = await create(engine, world.clone); engine.setPoolPaused(false);
        const task = await result(engine, run.taskId);
        expect(task.error).toBeUndefined(); expect(task.state).toBe("done"); expect(task.maintenance?.noProductChanges).toBe(true);
        expect(task.handedBack?.[0]?.summary).toContain("Investigated");
        expect(task.maintenance?.readOnlyWrites).not.toBe(true); expect(task.checks).toBeUndefined();
        expect(fakes.received("code reviewer")).toHaveLength(0);
        expect(task.timeline.some(line => line.text.startsWith("Undid"))).toBe(false);
        expect(engine.getState().inbox.some(item => item.taskId === run.taskId)).toBe(false);
      } finally { await engine.shutdown(); removeDir(world.dir); }
    });
  }
  for (const [fresh, queued] of [[false, true], [true, false], [true, true]] as const) it(`keeps a held question with a ${fresh ? "replacement" : "resumed"} conversation ${queued ? "and queued instructions" : "without queued instructions"}`, async () => {
    const { world, fakes, start } = setup(`kept-question-${fresh}-${queued}`, { mismatchReply: "question" }); let engine = start();
    const questionText = "Should I investigate the guest view?", instruction = "Also inspect the account view.";
    try {
      const run = await create(engine, world.clone); engine.setPoolPaused(false);
      expect((await result(engine, run.taskId)).maintenance?.pendingReply).toBeDefined();
      if (queued) engine.sendMessage(run.taskId, instruction);
      await engine.shutdown();
      if (fresh) fakes.forgetConversations();
      engine = start(); fakes.scenario({ maintenance: {} });
      engine.resolveMaintenanceSettings(run.taskId, "keep"); engine.setPoolPaused(false);
      const asking = await result(engine, run.taskId);
      const question = engine.getState().inbox.find(item => item.taskId === run.taskId && item.kind === "question");
      expect(question).toBeDefined(); expect(question!.title).toBe(questionText);
      expect(asking.session.filter(line => line.from === "agent" && line.text === questionText)).toHaveLength(1);
      expect(fakes.prompts()).toHaveLength(1);
      if (queued) expect(asking.queued.some(message => message.text === instruction)).toBe(true);
      if (fresh && queued) { await engine.shutdown(); engine = start(); }
      engine.answer(question!.id, "Yes"); engine.setPoolPaused(false);
      const completed = await result(engine, run.taskId);
      expect(completed.error).toBeUndefined(); expect(completed.state).toBe("done");
      const later = fakes.prompts().slice(1);
      expect(later.some(text => text.includes(questionText) && text.includes("Yes"))).toBe(true);
      if (fresh) expect(later.some(text => text.includes("Inspect checkout behavior"))).toBe(true);
      if (queued) expect(later.some(text => text.includes(instruction))).toBe(true);
      expect(engine.tracking.log.turns({ taskId: run.taskId }).every(turn => turn.modelAsked === "gpt-6.1-sol" && turn.effortAsked === "medium")).toBe(true);
      expect(completed.maintenance?.profile.id).toBe("sol-medium");
    } finally { await engine.shutdown(); removeDir(world.dir); }
  });
  for (const reply of ["question", "screen", "invalid", "validation", "cancelled"] as const) it(`holds changed settings before continuing a ${reply} reply`, async () => {
    const { world, fakes, start } = setup(`intermediate-${reply}`, { mismatchReply: reply, mismatchSetting: reply === "invalid" ? "model" : "effort" }); let engine = start();
    try {
      const run = await create(engine, world.clone); engine.setPoolPaused(false);
      const held = await result(engine, run.taskId);
      expect(held.error).toBeUndefined(); expect(held.state).toBe("needs-you");
      expect(held.stepClock?.since).toBeUndefined();
      expect(held.maintenance?.settingsDecision?.actual).toContain(reply === "invalid" ? "gpt-6-astra" : "high");
      expect(held.maintenance?.pendingReply).toBeDefined();
      expect(engine.getState().inbox.filter(item => item.taskId === run.taskId).map(item => item.kind)).toEqual(["maintenance-settings"]);
      expect(held.screen).toBeUndefined(); expect(fakes.prompts()).toHaveLength(1);
      await engine.shutdown(); engine = start();
      if (reply === "validation") fakes.forgetConversations();
      fakes.scenario({ maintenance: {} });
      engine.resolveMaintenanceSettings(run.taskId, reply === "screen" ? "stop" : "keep"); engine.setPoolPaused(false);
      if (reply === "question") {
        const asking = await result(engine, run.taskId);
        expect(asking.maintenance?.settingsDecision?.choice).toBe("keep");
        const question = engine.getState().inbox.find(item => item.taskId === run.taskId && item.kind === "question")!;
        expect(question.title).toBe("Should I investigate the guest view?");
        expect(fakes.prompts()).toHaveLength(1);
        engine.answer(question.id, "Yes");
      }
      const completed = await result(engine, run.taskId);
      expect(completed.error).toBeUndefined(); expect(completed.state).toBe(reply === "screen" ? "cancelled" : "done");
      expect(engine.getState().routines![0]!.profileId).toBe("sol-medium");
      const turns = engine.tracking.log.turns({ taskId: run.taskId });
      expect(turns.every(turn => turn.modelAsked === "gpt-6.1-sol" && turn.effortAsked === "medium")).toBe(true);
      if (reply !== "screen") {
        expect(fakes.prompts()).toHaveLength(2);
        if (reply === "validation") expect(fakes.prompts()[1]).toContain("Inspect checkout behavior");
        expect(turns.at(-1)?.modelRan).toBe("gpt-6.1-sol"); expect(turns.at(-1)?.effortRan).toBe("medium");
        expect(completed.maintenance?.pendingReply).toBeUndefined();
      }
    } finally { await engine.shutdown(); removeDir(world.dir); }
  });
  it("retains queued instructions behind a settings decision and sends them only on the saved profile", async () => {
    const { world, fakes, start } = setup("mismatch-message", { mismatch: true }); const engine = start();
    fakes.scenario({ maintenance: { mismatch: true }, controlled: true });
    try {
      const run = await create(engine, world.clone); engine.setPoolPaused(false);
      await until(engine, () => fakes.received("bug finder").length === 1, () => {});
      engine.sendMessage(run.taskId, "Also inspect the guest view.");
      writeFileSync(join(fakes.dir, `release-${fakes.received("bug finder")[0]!.session}`), "continue");
      const held = await result(engine, run.taskId);
      expect(held.maintenance?.settingsDecision).toBeDefined(); expect(held.queued.some(message => message.text.includes("guest view"))).toBe(true);
      expect(fakes.prompts()).toHaveLength(1);
      fakes.scenario({ maintenance: {} }); engine.resolveMaintenanceSettings(run.taskId, "keep");
      expect((await result(engine, run.taskId)).state).toBe("done");
      expect(fakes.prompts()).toHaveLength(2); expect(fakes.prompts()[1]).toContain("Also inspect the guest view.");
      expect(engine.tracking.log.turns({ taskId: run.taskId }).at(-1)?.effortRan).toBe("medium");
    } finally { await engine.shutdown(); removeDir(world.dir); }
  });
  it("answers an ordinary maintenance question without a settings decision when settings match", async () => {
    const { world, fakes, start } = setup("matching-question", { question: true }); const engine = start();
    try {
      const run = await create(engine, world.clone); engine.setPoolPaused(false);
      const asking = await result(engine, run.taskId);
      expect(asking.maintenance?.settingsDecision).toBeUndefined();
      const question = engine.getState().inbox.find(item => item.taskId === run.taskId && item.kind === "question")!;
      expect(question).toBeDefined(); engine.answer(question.id, "Yes");
      expect((await result(engine, run.taskId)).state).toBe("done"); expect(fakes.prompts()).toHaveLength(2);
    } finally { await engine.shutdown(); removeDir(world.dir); }
  });
  it("retains a read-only violation through a kept reply and a second restart while answering", async () => {
    const { world, fakes, start } = setup("read-only-question", { mismatchReply: "question", readOnlyWrite: true }); let engine = start();
    try {
      const run = await create(engine, world.clone); engine.setPoolPaused(false);
      const held = await result(engine, run.taskId); const copy = held.worktree!;
      expect(held.maintenance?.readOnlyWrites).toBe(true);
      await engine.shutdown(); engine = start();
      fakes.scenario({ maintenance: {} }); engine.resolveMaintenanceSettings(run.taskId, "keep"); engine.setPoolPaused(false);
      const asking = await result(engine, run.taskId);
      expect(asking.maintenance?.readOnlyWrites).toBe(true); expect(existsSync(join(copy, "maintenance.txt"))).toBe(false);
      await engine.shutdown(); engine = start();
      const question = engine.getState().inbox.find(item => item.taskId === run.taskId && item.kind === "question")!;
      engine.answer(question.id, "Yes"); engine.setPoolPaused(false);
      const failed = await result(engine, run.taskId);
      expect(failed.state).toBe("failed"); expect(failed.error).toContain("read-only"); expect(failed.maintenance?.noProductChanges).not.toBe(true);
      await engine.retry(engine.getState().inbox.find(item => item.taskId === run.taskId && item.kind === "stuck")!.id);
      expect((await result(engine, run.taskId)).state).toBe("done");
    } finally { await engine.shutdown(); removeDir(world.dir); }
  });
  for (const reply of ["final", "question"] as const) it(`keeps Stop cancelled across an interrupted save after a ${reply} reply`, async () => {
    const { world, fakes, start } = setup(`stop-save-${reply}`, reply === "final" ? { mismatch: true } : { mismatchReply: "question" }); let engine = start();
    try {
      const run = await create(engine, world.clone); engine.setPoolPaused(false);
      expect((await result(engine, run.taskId)).maintenance?.settingsDecision).toBeDefined();
      const save = engine.store.save.bind(engine.store);
      engine.store.save = (...args) => {
        save(...args);
        engine.store.save = save;
        throw new Error("Interrupted after the first saved Stop decision");
      };
      expect(() => engine.resolveMaintenanceSettings(run.taskId, "stop")).toThrow("Interrupted after the first saved Stop decision");
      await engine.shutdown(); engine = start();
      const stopped = engine.taskDetails(run.taskId)!;
      expect(stopped.state).toBe("cancelled"); expect(stopped.maintenance?.settingsDecision?.choice).toBe("stop");
      expect(engine.getState().inbox.some(item => item.taskId === run.taskId)).toBe(false);
      fakes.scenario({ maintenance: {} });
      const control = await create(engine, world.clone); engine.setPoolPaused(false);
      expect((await result(engine, control.taskId)).state).toBe("done");
      expect(engine.taskDetails(run.taskId)!.state).toBe("cancelled"); expect(fakes.prompts()).toHaveLength(2);
    } finally { await engine.shutdown(); removeDir(world.dir); }
  });
  it("recovers interrupted read-only cleanup before accepting a held result, then allows a fresh retry", async () => {
    const { world, fakes, start } = setup("read-only-recovery", { mismatch: true, readOnlyWrite: true }); let engine = start();
    try {
      const run = await create(engine, world.clone); engine.setPoolPaused(false);
      const held = await result(engine, run.taskId);
      const copy = held.worktree!;
      await engine.shutdown();
      // Recreate the persisted boundary between saving the hold and finishing read-only cleanup.
      writeFileSync(join(copy, "maintenance.txt"), "Interrupted read-only write\n");
      engine = start(); engine.resolveMaintenanceSettings(run.taskId, "keep"); engine.setPoolPaused(false);
      const failed = await result(engine, run.taskId);
      expect(failed.state).toBe("failed"); expect(failed.error).toContain("read-only");
      expect(existsSync(join(copy, "maintenance.txt"))).toBe(false);
      expect(failed.maintenance?.noProductChanges).not.toBe(true);
      fakes.scenario({ maintenance: {} });
      await engine.retry(engine.getState().inbox.find(i => i.taskId === run.taskId && i.kind === "stuck")!.id);
      expect((await result(engine, run.taskId)).state).toBe("done");
    } finally { await engine.shutdown(); removeDir(world.dir); }
  });
  it("uses two independent reviewer conversations when only one tool is available", async () => {
    const { world, fakes, start } = setup("one-tool", { change: true }); const engine = start("codex");
    try {
      await engine.checkTools();
      const run = await create(engine, world.clone, "maintenance-dead-code"); engine.setPoolPaused(false);
      const task = await result(engine, run.taskId);
      expect(task.error).toBeUndefined(); expect(task.state).toBe("needs-you");
      const reviews = fakes.received("code reviewer");
      expect(reviews).toHaveLength(2); expect(reviews[0]!.session).not.toBe(reviews[1]!.session);
      for (const review of reviews) expect(fakes.opens().find(open => open.session === review.session)?.tool).toBe("codex");
    } finally { await engine.shutdown(); removeDir(world.dir); }
  });

  for (const issue of ["repository missing", "tool failure"] as const) it(`keeps ${issue} visible without successful completion or another occurrence`, async () => {
    const { world, fakes, start } = setup(issue, {}); const engine = start();
    try {
      const run = await create(engine, world.clone);
      if (issue === "repository missing") removeDir(world.clone);
      else fakes.scenario({ maintenance: {}, failure: { role: "bug finder", message: "Investigation unavailable", httpStatus: 500 } });
      engine.setPoolPaused(false);
      const task = await result(engine, run.taskId);
      expect(task.state).toBe("failed"); expect(task.error).toBeTruthy(); expect(task.maintenance?.noProductChanges).not.toBe(true);
      engine.pollRoutines(run.due + 86_400_000);
      expect(engine.getState().routines![0]!.blockingTaskId).toBe(run.taskId);
      expect(engine.getState().tasks.filter(t => t.maintenance)).toHaveLength(1);
    } finally { await engine.shutdown(); removeDir(world.dir); }
  });
  it("rolls back interrupted admission before retrying and respects drain admission", async () => {
    const { world, fakes, start } = setup("atomic-save", {}); let engine = start();
    try {
      const run = await create(engine, world.clone);
      engine.cancel(run.taskId);
      engine.store.database.run("CREATE TEMP TRIGGER fail_admission BEFORE INSERT ON active_tasks BEGIN SELECT RAISE(ABORT, 'interrupted admission'); END");
      const now = run.due + 86_400_000;
      expect(() => engine.pollRoutines(now)).toThrow("interrupted admission");
      expect(engine.getState().routines![0]!.latestTaskId).toBe(run.taskId);
      engine.store.database.run("DROP TRIGGER fail_admission");
      await engine.shutdown(); engine = start();
      engine.draining = true;
      engine.pollRoutines(now); engine.schedule();
      const taskId = engine.getState().routines![0]!.latestTaskId!;
      expect(taskId).not.toBe(run.taskId); expect(engine.taskDetails(taskId)!.state).toBe("queued");
      expect(fakes.prompts()).toHaveLength(0);
      engine.pollRoutines(now); expect(engine.getState().tasks.filter(t => t.maintenance && t.state === "queued")).toHaveLength(1);
      engine.draining = false; engine.setPoolPaused(false);
      expect((await result(engine, taskId)).state).toBe("done");
    } finally { await engine.shutdown(); removeDir(world.dir); }
  });

  for (const issue of ["unsupported", "unconfirmed"] as const) it(`waits for ${issue} settings without sending maintenance instructions or substituting`, async () => {
    const { world, fakes, start } = setup(issue, { [issue]: true }); const engine = start();
    try {
      const run = await create(engine, world.clone); engine.setPoolPaused(false);
      const task = await result(engine, run.taskId);
      expect(task.state).toBe("needs-you"); expect(task.error).toContain("could not be confirmed");
      expect(task.maintenance!.noProductChanges).not.toBe(true); expect(fakes.prompts()).toHaveLength(0);
      const count = fakes.opens().length;
      engine.schedule(); engine.pollRoutines(run.due + 86_400_000);
      expect(fakes.opens()).toHaveLength(count);
      expect(engine.getState().routines![0]!.blockingTaskId).toBe(run.taskId);
      fakes.scenario({ maintenance: {} });
      const item = engine.getState().inbox.find(i => i.taskId === run.taskId && i.kind === "stuck")!;
      await engine.retry(item.id);
      expect((await result(engine, run.taskId)).state).toBe("done");
    } finally { await engine.shutdown(); removeDir(world.dir); }
  });

  it("waits on the exact saved profile after a usage limit", async () => {
    const { world, fakes, start } = setup("usage", {}); const engine = start();
    fakes.scenario({ maintenance: {}, limited: [{ model: "gpt-6.1-sol", role: "bug finder" }] });
    try {
      const run = await create(engine, world.clone); engine.setPoolPaused(false);
      await until(engine, state => state.tasks.find(t => t.id === run.taskId)?.statusLine.includes("Waiting for usage") === true, () => {});
      expect(fakes.received().every(r => r.role === "bug finder")).toBe(true);
      expect(engine.taskDetails(run.taskId)!.maintenance!.profile.id).toBe("sol-medium");
      engine.pollRoutines(run.due + 86_400_000);
      expect(engine.getState().routines![0]!.blockingTaskId).toBe(run.taskId);
    } finally { await engine.shutdown(); removeDir(world.dir); }
  });
  it("keeps changed work at Medium risk behind checks, two fresh reviewers and delivery approval", async () => {
    const { world, fakes, start } = setup("changed", { change: true }); const engine = start();
    try {
      const custom = engine.addRole({ ...draftOf(MAINTENANCE_ROLES[0]!), name: "Repository caretaker" });
      const run = await create(engine, world.clone, custom);
      engine.removeRole(custom);
      engine.removeRoutine(run.routineId);
      engine.setPoolPaused(false);
      const task = await result(engine, run.taskId);
      expect(task.error).toBeUndefined(); expect(task.state).toBe("needs-you");
      expect(task.risk?.level).toBe("medium");
      expect(task.checks?.results.every(check => check.ok)).toBe(true);
      const reviewers = fakes.received("code reviewer");
      expect(reviewers).toHaveLength(2); expect(new Set(reviewers.map(r => r.session)).size).toBe(2);
      const reviewInputs = task.journey!.filter(step => step.roleId === "code-reviewer").flatMap(step => step.agentInputs ?? []);
      expect(reviewInputs).toHaveLength(2);
      expect(reviewInputs.every(input => input.assignment?.by === "engine" && input.assignment.reason === "Selected for independent review of maintenance changes." && input.selectionReason && input.confirmedSettings?.model)).toBe(true);
      expect(fakes.received().some(r => ["planner", "builder", "security reviewer"].includes(r.role))).toBe(false);
      expect(engine.getState().inbox.some(i => i.taskId === run.taskId && i.kind === "delivery")).toBe(true);
      expect(world.github().calls.some(call => /push|create/.test(JSON.stringify(call)))).toBe(false);
      expect(task.maintenance!.noProductChanges).not.toBe(true);
    } finally { await engine.shutdown(); removeDir(world.dir); }
  });

  it("returns failed checks to the frozen maintenance agent and completes withdrawn changes without review", async () => {
    const { world, fakes, start } = setup("check-repair", { change: true }); const engine = start();
    try {
      const run = await create(engine, world.clone, "maintenance-dead-code");
      engine.setProductChecks(run.productId, [{ name: "Confirmed repair", command: `${process.execPath} -e 'process.exit(1)'` }]);
      // Change the fake's next turn after the first result has been produced, at check preparation.
      const unsubscribe = engine.subscribe(() => {
        if (engine.taskDetails(run.taskId)?.stageIndex === 1) fakes.scenario({ maintenance: { withdraw: true } });
      });
      engine.setPoolPaused(false);
      const task = await result(engine, run.taskId); unsubscribe();
      expect(task.error).toBeUndefined(); expect(task.state).toBe("done");
      expect(task.maintenance!.noProductChanges).toBe(true);
      expect(fakes.received("dead-code cleanup")).toHaveLength(2);
      expect(fakes.received("code reviewer")).toHaveLength(0);
      expect(task.checks?.results.some(check => !check.ok)).toBe(true);
      expect(engine.getState().inbox.some(i => i.taskId === run.taskId && i.kind === "delivery")).toBe(false);
    } finally { await engine.shutdown(); removeDir(world.dir); }
  });

  for (const choice of ["keep", "stop"] as const) it(`persists a settings decision across restart and can ${choice} the actual turn`, async () => {
    const { world, fakes, start } = setup(`mismatch-${choice}`, { change: true, mismatch: true }); let engine = start();
    try {
      const run = await create(engine, world.clone, "maintenance-dead-code"); engine.setPoolPaused(false);
      const held = await result(engine, run.taskId);
      expect(held.maintenance?.settingsDecision?.actual).toContain("high");
      expect(held.checks).toBeUndefined();
      const count = fakes.received("dead-code cleanup").length;
      await engine.shutdown(); engine = start();
      expect(engine.getState().inbox.some(i => i.kind === "maintenance-settings")).toBe(true);
      engine.resolveMaintenanceSettings(run.taskId, choice); engine.setPoolPaused(false);
      const task = await result(engine, run.taskId);
      expect(task.error).toBeUndefined(); expect(task.state).toBe(choice === "stop" ? "cancelled" : "needs-you");
      expect(task.maintenance?.settingsDecision?.choice).toBe(choice);
      expect(fakes.received("dead-code cleanup")).toHaveLength(count);
      expect(engine.getState().routines![0]!.profileId).toBe("sol-medium");
      if (choice === "keep") {
        const delivery = engine.getState().inbox.find(i => i.taskId === run.taskId && i.kind === "delivery")!;
        expect(delivery).toBeDefined();
        fakes.scenario({ maintenance: { withdraw: true } });
        engine.requestChanges(delivery.id, "Withdraw the change and retain the findings.");
        expect((await result(engine, run.taskId)).state).toBe("done");
        const nextTurn = fakes.received("dead-code cleanup").at(-1)!;
        expect(fakes.settings(nextTurn.session)).toContain("reasoning_effort=medium");
        expect(engine.taskDetails(run.taskId)!.maintenance!.profile.id).toBe("sol-medium");
      }
    } finally { await engine.shutdown(); removeDir(world.dir); }
  });

  it("uses the saved maintenance role for review send-backs and update conflicts", async () => {
    const { world, fakes, start } = setup("review-repair", { change: true }); const engine = start();
    fakes.scenario({ maintenance: { change: true }, reviewer: "important-twice" });
    try {
      const custom = engine.addRole({ ...draftOf(MAINTENANCE_ROLES[0]!), name: "Focused caretaker" });
      const run = await create(engine, world.clone, custom); engine.removeRole(custom);
      engine.setPoolPaused(false);
      const task = await result(engine, run.taskId);
      expect(task.error).toBeUndefined(); expect(task.state).toBe("needs-you");
      expect(fakes.received("focused caretaker").length).toBeGreaterThan(1);
      expect(task.findings.some(finding => finding.verification)).toBe(true);
      const before = fakes.received("focused caretaker").length;
      writeFileSync(join(world.clone, "maintenance.txt"), "Default branch moved\n");
      git(world.clone, "add", "maintenance.txt"); git(world.clone, "commit", "-m", "Change maintenance file");
      git(world.clone, "push", world.remote, "main");
      fakes.scenario({ maintenance: { change: true } });
      const item = engine.getState().inbox.find(i => i.taskId === run.taskId && i.kind === "delivery")!;
      engine.approve(item.id);
      await until(engine, () => fakes.received("focused caretaker").length > before || engine.taskDetails(run.taskId)?.state === "failed", () => {});
      expect(engine.taskDetails(run.taskId)!.error).toBeUndefined();
      expect(fakes.received("focused caretaker").length).toBeGreaterThan(before);
      expect(fakes.received().some(r => r.role === "builder")).toBe(false);
    } finally { await engine.shutdown(); removeDir(world.dir); }
  });
  it("queues while paused, rejects all workflow roles, and preserves exact intent after edits, deletion and restart", async () => {
    const { world, fakes, start } = setup("saved-intent", {}); let engine = start();
    try {
      const run = await create(engine, world.clone);
      const task = engine.taskDetails(run.taskId)!;
      expect(task.state).toBe("queued"); expect(task.stageIndex).toBe(0); expect(fakes.prompts()).toHaveLength(0);
      for (const role of engine.getState().roles.filter(r => r.category !== "maintenance")) {
        const before = JSON.stringify(engine.getState().routines);
        expect(() => engine.saveRoutine({ ...run.draft, roleId: role.id }, run.routineId)).toThrow("maintenance role");
        expect(JSON.stringify(engine.getState().routines)).toBe(before);
      }
      const before = JSON.stringify(task.maintenance);
      engine.saveRoutine({ ...run.draft, zone: "Asia/Tokyo", focus: "New focus", profileId: "astra-ultra" }, run.routineId);
      engine.saveRole(run.draft.roleId, { ...draftOf(engine.getState().roles.find(r => r.id === run.draft.roleId)!), instructions: "Different future wording" });
      engine.removeRoutine(run.routineId);
      await engine.shutdown(); engine = start();
      expect(JSON.stringify(engine.taskDetails(run.taskId)!.maintenance)).toBe(before);
      engine.setPoolPaused(false);
      const completed = await result(engine, run.taskId);
      expect(completed.error).toBeUndefined(); expect(completed.state).toBe("done"); expect(completed.maintenance!.noProductChanges).toBe(true);
      expect(completed.handedBack?.[0]?.summary).toContain("Investigated");
      expect(completed.checks).toBeUndefined(); expect(completed.findings).toEqual([]);
      expect(fakes.received().map(r => r.role)).toEqual(["bug finder"]);
      expect(fakes.prompts()[0]).toContain("Inspect checkout behavior"); expect(fakes.prompts()[0]).not.toContain("Different future wording");
      expect(fakes.opens().some(o => o.tool === "codex")).toBe(true);
      expect(completed.journey?.some(step => step.agentInputs?.some(input => input.sections.some(section => section.body.includes("Inspect checkout behavior"))))).toBe(true);
      const input = completed.journey!.find(step => step.roleId === run.draft.roleId)!.agentInputs![0]!;
      expect(input.requestedProfileId).toBe("sol-medium"); expect(input.profileId).toBe("sol-medium");
      expect(input.assignment).toEqual({ profileId: "sol-medium", by: "coordinator", reason: "Chosen in the saved maintenance routine." });
      expect(input.selectionReason).toBe("Kept the profile saved in the maintenance routine.");
      expect(input.confirmedSettings).toEqual(expect.objectContaining({ model: "gpt-6.1-sol", effort: "medium" }));
    } finally { await engine.shutdown(); removeDir(world.dir); }
  });

  it("saves admission atomically, coalesces restart catch-up and does not overlap unfinished work", async () => {
    const { world, start } = setup("admission", {}); let engine = start();
    try {
      const run = await create(engine, world.clone);
      engine.pollRoutines(run.due); engine.pollRoutines(run.due - 86_400_000);
      expect(engine.getState().tasks.filter(t => t.maintenance)).toHaveLength(1);
      engine.pollRoutines(run.due + 20 * 86_400_000);
      expect(engine.getState().routines![0]!.blockingTaskId).toBe(run.taskId);
      engine.cancel(run.taskId);
      await engine.shutdown(); engine = start();
      engine.pollRoutines(run.due + 20 * 86_400_000);
      expect(engine.getState().routines![0]!.latestTaskId).toBe(run.taskId);
      engine.pollRoutines(run.due + 30 * 86_400_000);
      const next = engine.getState().routines![0]!.latestTaskId!;
      expect(next).not.toBe(run.taskId); expect(engine.taskDetails(next)!.maintenance!.catchUp).toContain("latest missed");
      engine.setRoutineEnabled(run.routineId, false);
      engine.pollRoutines(run.due + 40 * 86_400_000);
      expect(engine.getState().routines![0]!.latestTaskId).toBe(next);
      engine.removeRoutine(run.routineId);
      engine.pollRoutines(run.due + 50 * 86_400_000);
      expect(engine.getState().routines).toEqual([]);
    } finally { await engine.shutdown(); removeDir(world.dir); }
  });

  for (const profileId of ["astra-ultra", "sol-ultra", "sol-medium"]) it(`executes the saved ${profileId} profile and finishes writable investigations without changes`, async () => {
    const { world, fakes, start } = setup(profileId, {}); const engine = start();
    try {
      const run = await create(engine, world.clone, "maintenance-dead-code", profileId);
      engine.setPoolPaused(false);
      const completed = await result(engine, run.taskId);
      expect(completed.error).toBeUndefined(); expect(completed.state).toBe("done"); expect(completed.maintenance!.noProductChanges).toBe(true);
      expect(completed.report?.summary).toContain("Investigated"); expect(completed.checks).toBeUndefined();
      expect(fakes.received().map(r => r.role)).toEqual(["dead-code cleanup"]);
      const configured = readFileSync(join(fakes.dir, "config.jsonl"), "utf8");
      expect(configured).toContain(completed.maintenance!.profile.modelId!); expect(configured).toContain(completed.maintenance!.profile.effort);
    } finally { await engine.shutdown(); removeDir(world.dir); }
  });

  for (const [name, behavior] of [["incomplete", { incomplete: true }], ["read-only writes", { readOnlyWrite: true }]] as const) it(`does not call ${name} a successful empty investigation`, async () => {
    const { world, start } = setup(name, behavior); const engine = start();
    try {
      const run = await create(engine, world.clone); engine.setPoolPaused(false);
      const task = await result(engine, run.taskId);
      expect(task.error).toContain(name === "incomplete" ? "incomplete" : "read-only"); expect(task.state).toBe("failed"); expect(task.maintenance!.noProductChanges).not.toBe(true);
      if (behavior.readOnlyWrite && task.worktree) expect(existsSync(join(task.worktree, "maintenance.txt"))).toBe(false);
    } finally { await engine.shutdown(); removeDir(world.dir); }
  });

  it("excludes maintenance from actual planner descriptions and every ordinary stage position", async () => {
    const { world, fakes, start } = setup("isolation", {}); const engine = start();
    try {
      const productId = await engine.addProduct(world.clone);
      const ordinary = engine.addTask({ productId, title: "Plan an ordinary task", approvePlan: true });
      engine.setPoolPaused(false);
      await until(engine, () => !!engine.taskDetails(ordinary)?.plan || engine.taskDetails(ordinary)?.state === "failed", () => {});
      expect(engine.taskDetails(ordinary)?.error).toBeUndefined();
      const actualInput = fakes.prompts("planner")[0]!;
      expect(actualInput).toContain("builder");
      for (const role of MAINTENANCE_ROLES) expect(actualInput).not.toContain(role.id);
      const roles = engine.getState().roles, maintenance = MAINTENANCE_ROLES[0]!;
      expect(plannerRoles(roles)).not.toContain(maintenance.id);
      const plan = normalizePlan({ task: { id: "attempt", delivery: "local", approveDelivery: true }, roles, profiles: engine.getState().profiles, plannerProfileId: "sol-medium", releaseManagerProfileId: "opus-high", result: { rationale: "Try forbidden roles", stages: [
        { kind: "do", title: "Forbidden standalone", roleId: maintenance.id, profileIds: ["sol-medium"] },
        { kind: "converge", title: "Forbidden author", roleId: maintenance.id, profileIds: ["sol-medium"], reviewerRoleId: "design-reviewer" },
        { kind: "converge", title: "Forbidden design reviewer", roleId: "architect", profileIds: ["sol-medium"], reviewerRoleId: maintenance.id },
        { kind: "review-chain", title: "Forbidden review", roleId: maintenance.id, roleIds: [maintenance.id], profileIds: ["sol-medium"] },
      ] } });
      expect(plan.stages.every(s => s.roleId !== maintenance.id && s.reviewerRoleId !== maintenance.id && !s.roleIds?.includes(maintenance.id))).toBe(true);
      expect(plan.rationale).toContain("maintenance role");
    } finally { await engine.shutdown(); removeDir(world.dir); }
  });
});
