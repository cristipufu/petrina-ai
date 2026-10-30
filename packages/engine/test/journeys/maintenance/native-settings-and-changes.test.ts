import { installPreparedProduct, acmeDemoProduct } from "../../fixtures/prepared-product.js";
import { fakeEngineSettings } from "../../fixtures/fake-agent-sessions.js";
import { installSharedWorkflowFastPaths } from "../../fixtures/shared-preparation.js";
import { afterAll, describe, expect, it } from "bun:test";
import { join } from "node:path";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { commandInputText, draftOf, MAINTENANCE_ROLES, type RoutineDraft, type Task } from "@petrina/core";
import { Fakes, until, removeDir } from "../../support.js";
import type { Engine } from "../../engine.js";
import { nativeWorldFixtures, type NativeWorld } from "../../fixtures/native-worlds.js";
import { privateWorldToolProbe } from "../../fixtures/world-tool-probe.js";
import { git } from "../../fixtures.js";
import { Coordination } from "../../../src/coordination.js";

type MaintenancePhase = (engine: Engine) => Promise<void | MaintenancePhase>;
interface MaintenanceContext { world: NativeWorld; fakes: Fakes; start(body: MaintenancePhase, onlyTool?: "codex"): Promise<void | MaintenancePhase> }
const fixtures = nativeWorldFixtures();
afterAll(fixtures.close);
async function setup(name: string, behavior: Parameters<Fakes["scenario"]>[0]["maintenance"], body: (fixture: MaintenanceContext) => Promise<void>, objectFormat?: "sha1" | "sha256") {
  return fixtures.world(`maintenance-${name}`, async ({ world, engine: ownedEngine }) => {
    const fakes = new Fakes(join(world.dir, "agents"));
    fakes.scenario({ maintenance: behavior });
    const start = (run: MaintenancePhase, onlyTool?: "codex") => ownedEngine(async engine => {
      if ((objectFormat ?? "sha1") === "sha1") {
        installSharedWorkflowFastPaths(engine, {
          skipDriverPrepare: true,
          skipUpToDate: true,
          skipPrepareChecks: true,
          skipReviewCopies: true,
          skipReviewInputDiffs: true,
          fastCheckCapture: true,
          fastCleanup: true,
        });
      }
      engine.setPoolPaused(true);
      await engine.waitUntilReady(); engine.stopRequested.signal.throwIfAborted();
      return run(engine);
    }, { ...fakeEngineSettings(fakes, { recordTool: true, flags: (toolId) => (onlyTool && onlyTool !== toolId ? ["--logged-out"] : []) }),
      ...(onlyTool ? { toolProbe: privateWorldToolProbe(world, [onlyTool]) } : {}) });
    return body({ world, fakes, start });
  }, { objectFormat });
}
async function create(engine: Engine, clone: string, roleId = "maintenance-bug-finder", profileId = "sol-medium", checks = false) {
  return createRoutine(engine, installPreparedProduct(engine, acmeDemoProduct(clone)), roleId, profileId, checks);
}
async function createRoutine(engine: Engine, productId: string, roleId = "maintenance-bug-finder", profileId = "sol-medium", checks = false) {
  engine.setProductChecks(productId, checks ? [{ name: "Tests", command: commandInputText([process.execPath, "-e", "process.exit(0)"]) }] : null);
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
    await setup(`committed-${format}`, { change: true, commit: true }, async ({ world, fakes, start }) => {
      const phase: MaintenancePhase = async (engine: Engine) => {


        const run = await create(engine, world.clone, "maintenance-dead-code", "sol-medium", true); engine.setPoolPaused(false);
        const task = await result(engine, run.taskId);
        expect(task.error).toBeUndefined(); expect(task.state).toBe("needs-you");
        expect(task.baseSha).toHaveLength(format === "sha256" ? 64 : 40);
        expect(task.maintenance?.noProductChanges).not.toBe(true);
        expect(task.checks?.results.every(check => check.ok)).toBe(true);
        expect(fakes.received("code reviewer")).toHaveLength(2);
        expect(engine.getState().inbox.some(item => item.taskId === run.taskId && item.kind === "delivery")).toBe(true);
        expect(readFileSync(join(task.worktree!, "maintenance.txt"), "utf8")).toContain("Confirmed maintenance change");


      };
      let next = await start(phase);
      if (next) next = await start(next);
      if (next) await start(next);
    }, format);
  });
    it(`undoes a reports-only agent's committed writes in a ${format} product`, async () => {
    await setup(`read-only-commit-${format}`, { readOnlyWrite: true, commit: true }, async ({ world, start }) => {
      const phase: MaintenancePhase = async (engine: Engine) => {


        const run = await create(engine, world.clone); engine.setPoolPaused(false);
        const task = await result(engine, run.taskId);
        expect(task.state).toBe("failed"); expect(task.error).toContain("read-only");
        expect(task.maintenance?.noProductChanges).not.toBe(true);
        expect(await git(task.worktree!, "rev-parse", "HEAD")).toBe(task.baseSha!);
        expect(existsSync(join(task.worktree!, "maintenance.txt"))).toBe(false);
        expect(await git(task.worktree!, "status", "--porcelain")).toBe("");


      };
      let next = await start(phase);
      if (next) next = await start(next);
      if (next) await start(next);
    }, format);
  });
    it(`finishes an unchanged reports-only investigation in a ${format} product`, async () => {
    await setup(`read-only-empty-${format}`, {}, async ({ world, fakes, start }) => {
      const phase: MaintenancePhase = async (engine: Engine) => {


        const run = await create(engine, world.clone); engine.setPoolPaused(false);
        const task = await result(engine, run.taskId);
        expect(task.error).toBeUndefined(); expect(task.state).toBe("done"); expect(task.maintenance?.noProductChanges).toBe(true);
        expect(task.handedBack?.[0]?.summary).toContain("Investigated");
        expect(task.maintenance?.readOnlyWrites).not.toBe(true); expect(task.checks).toBeUndefined();
        expect(fakes.received("code reviewer")).toHaveLength(0);
        expect(task.timeline.some(line => line.text.startsWith("Undid"))).toBe(false);
        expect(engine.getState().inbox.some(item => item.taskId === run.taskId)).toBe(false);


      };
      let next = await start(phase);
      if (next) next = await start(next);
      if (next) await start(next);
    }, format);
  });
  }
  for (const [fresh, queued] of [[false, true], [true, false], [true, true]] as const) it(`keeps a held question with a ${fresh ? "replacement" : "resumed"} conversation ${queued ? "and queued instructions" : "without queued instructions"}`, async () => {
    await setup(`kept-question-${fresh}-${queued}`, { mismatchReply: "question" }, async ({ world, fakes, start }) => {
      const phase: MaintenancePhase = async (engine: Engine) => {

    const questionText = "Should I investigate the guest view?", instruction = "Also inspect the account view.";

      const run = await create(engine, world.clone); engine.setPoolPaused(false);
      expect((await result(engine, run.taskId)).maintenance?.pendingReply).toBeDefined();
      if (queued) engine.sendMessage(run.taskId, instruction);
      await engine.shutdown();
      if (fresh) fakes.forgetConversations();

return async (engine: Engine) => {
 fakes.scenario({ maintenance: {} });
      // One variant replays the held reply as a tool that did not stream it, with words before its question.
      const spoken = "I looked at checkout first.";
      const held = engine.task(run.taskId)!.maintenance!.pendingReply!;
      if (fresh && !queued) { delete held.streamed; held.text = `${spoken}\n\n${held.text}`; }
      engine.resolveMaintenanceSettings(run.taskId, "keep"); engine.setPoolPaused(false);
      const asking = await result(engine, run.taskId);
      const question = engine.getState().inbox.find(item => item.taskId === run.taskId && item.kind === "question");
      expect(question).toBeDefined(); expect(question!.title).toBe(questionText);
      expect(asking.session.filter(line => line.from === "agent" && line.text === questionText)).toHaveLength(1);
      // Its saved words name the start that wrote them, so the asking agent has one current message while it waits.
      const live = engine.task(run.taskId)!, asked = live.session.findLast(line => line.from === "agent" && line.text === questionText)!;
      const node = live.journey!.find(step => step.id === asked.step)!;
      expect(node.agentInputs![asked.inputIndex!]).toMatchObject({ roleId: asked.roleId, profileId: asked.profileId });
      expect(((await new Coordination(engine).call("task.conversation", { taskId: run.taskId, nodeId: node.id })).activeMessages as { id: string }[]).map(message => message.id)).toEqual([asked.id]);
      if (fresh && !queued) expect(live.session.find(line => line.from === "agent" && line.text.startsWith(spoken))?.inputIndex).toBe(asked.inputIndex);
      expect(fakes.prompts()).toHaveLength(1);
      if (queued) expect(asking.queued.some(message => message.text === instruction)).toBe(true);

const continueWithCurrent: MaintenancePhase = async (engine: Engine) => {

      engine.answer(question!.id, "Yes"); engine.setPoolPaused(false);
      const completed = await result(engine, run.taskId);
      expect(completed.error).toBeUndefined(); expect(completed.state).toBe("done");
      const later = fakes.prompts().slice(1);
      expect(later.some(text => text.includes(questionText) && text.includes("Yes"))).toBe(true);
      if (fresh) expect(later.some(text => text.includes("Inspect checkout behavior"))).toBe(true);
      if (queued) expect(later.some(text => text.includes(instruction))).toBe(true);
      expect(engine.tracking.log.turns({ taskId: run.taskId }).every(turn => turn.modelAsked === "gpt-6.1-sol" && turn.effortAsked === "medium")).toBe(true);
      expect(completed.maintenance?.profile.id).toBe("sol-medium");


};
if (fresh && queued) { await engine.shutdown(); return continueWithCurrent; }
return continueWithCurrent(engine);

};

      };
      let next = await start(phase);
      if (next) next = await start(next);
      if (next) await start(next);
    });
  });
  for (const reply of ["question", "validation"] as const) it(`holds changed settings before continuing a ${reply} reply`, async () => {
    await setup(`intermediate-${reply}`, { mismatchReply: reply, mismatchSetting: reply === "validation" ? "model" : "effort" }, async ({ world, fakes, start }) => {
      const phase: MaintenancePhase = async (engine: Engine) => {


      const run = await create(engine, world.clone); engine.setPoolPaused(false);
      const held = await result(engine, run.taskId);
      expect(held.error).toBeUndefined(); expect(held.state).toBe("needs-you");
      expect(held.stepClock?.since).toBeUndefined();
      expect(held.maintenance?.settingsDecision?.actual).toContain(reply === "validation" ? "gpt-6-astra" : "high");
      expect(held.maintenance?.pendingReply).toBeDefined();
      expect(engine.getState().inbox.filter(item => item.taskId === run.taskId).map(item => item.kind)).toEqual(["maintenance-settings"]);
      expect(held.screen).toBeUndefined(); expect(fakes.prompts()).toHaveLength(1);
      await engine.shutdown();
return async (engine: Engine) => {

      if (reply === "validation") fakes.forgetConversations();
      fakes.scenario({ maintenance: {} });
      engine.resolveMaintenanceSettings(run.taskId, "keep"); engine.setPoolPaused(false);
      if (reply === "question") {
        const asking = await result(engine, run.taskId);
        expect(asking.maintenance?.settingsDecision?.choice).toBe("keep");
        const question = engine.getState().inbox.find(item => item.taskId === run.taskId && item.kind === "question")!;
        expect(question.title).toBe("Should I investigate the guest view?");
        expect(fakes.prompts()).toHaveLength(1);
        engine.answer(question.id, "Yes");
      }
      const completed = await result(engine, run.taskId);
      expect(completed.error).toBeUndefined(); expect(completed.state).toBe("done");
      expect(engine.getState().routines![0]!.profileId).toBe("sol-medium");
      const turns = engine.tracking.log.turns({ taskId: run.taskId });
      expect(turns.every(turn => turn.modelAsked === "gpt-6.1-sol" && turn.effortAsked === "medium")).toBe(true);
      expect(fakes.prompts()).toHaveLength(2);
      if (reply === "validation") expect(fakes.prompts()[1]).toContain("Inspect checkout behavior");
      expect(turns.at(-1)?.modelRan).toBe("gpt-6.1-sol"); expect(turns.at(-1)?.effortRan).toBe("medium");
      expect(completed.maintenance?.pendingReply).toBeUndefined();


};

      };
      let next = await start(phase);
      if (next) next = await start(next);
      if (next) await start(next);
    });
  });
  it("retains queued instructions behind a settings decision and sends them only on the saved profile", async () => {
    await setup("mismatch-message", { mismatch: true }, async ({ world, fakes, start }) => {
      const phase: MaintenancePhase = async (engine: Engine) => {

    fakes.scenario({ maintenance: { mismatch: true }, controlled: true });

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


      };
      let next = await start(phase);
      if (next) next = await start(next);
      if (next) await start(next);
    });
  });
  it("answers an ordinary maintenance question without a settings decision when settings match", async () => {
    await setup("matching-question", { question: true }, async ({ world, fakes, start }) => {
      const phase: MaintenancePhase = async (engine: Engine) => {


      const run = await create(engine, world.clone); engine.setPoolPaused(false);
      const asking = await result(engine, run.taskId);
      expect(asking.maintenance?.settingsDecision).toBeUndefined();
      const question = engine.getState().inbox.find(item => item.taskId === run.taskId && item.kind === "question")!;
      expect(question).toBeDefined(); engine.answer(question.id, "Yes");
      expect((await result(engine, run.taskId)).state).toBe("done"); expect(fakes.prompts()).toHaveLength(2);


      };
      let next = await start(phase);
      if (next) next = await start(next);
      if (next) await start(next);
    });
  });
  it("retains a read-only violation through a kept reply and a second restart while answering", async () => {
    await setup("read-only-question", { mismatchReply: "question", readOnlyWrite: true }, async ({ world, fakes, start }) => {
      const phase: MaintenancePhase = async (engine: Engine) => {


      const run = await create(engine, world.clone); engine.setPoolPaused(false);
      const held = await result(engine, run.taskId); const copy = held.worktree!;
      expect(held.maintenance?.readOnlyWrites).toBe(true);
      await engine.shutdown();
return async (engine: Engine) => {

      fakes.scenario({ maintenance: {} }); engine.resolveMaintenanceSettings(run.taskId, "keep"); engine.setPoolPaused(false);
      const asking = await result(engine, run.taskId);
      expect(asking.maintenance?.readOnlyWrites).toBe(true); expect(existsSync(join(copy, "maintenance.txt"))).toBe(false);
      await engine.shutdown();
return async (engine: Engine) => {

      const question = engine.getState().inbox.find(item => item.taskId === run.taskId && item.kind === "question")!;
      engine.answer(question.id, "Yes"); engine.setPoolPaused(false);
      const failed = await result(engine, run.taskId);
      expect(failed.state).toBe("failed"); expect(failed.error).toContain("read-only"); expect(failed.maintenance?.noProductChanges).not.toBe(true);
      await engine.retry(engine.getState().inbox.find(item => item.taskId === run.taskId && item.kind === "stuck")!.id);
      expect((await result(engine, run.taskId)).state).toBe("done");


};

};

      };
      let next = await start(phase);
      if (next) next = await start(next);
      if (next) await start(next);
    });
  });
  for (const reply of ["final", "question"] as const) it(`keeps Stop cancelled across an interrupted save after a ${reply} reply`, async () => {
    await setup(`stop-save-${reply}`, reply === "final" ? { mismatch: true } : { mismatchReply: "question" }, async ({ world, fakes, start }) => {
      const phase: MaintenancePhase = async (engine: Engine) => {


      const run = await create(engine, world.clone); engine.setPoolPaused(false);
      expect((await result(engine, run.taskId)).maintenance?.settingsDecision).toBeDefined();
      const save = engine.store.save.bind(engine.store);
      engine.store.save = (...args) => {
        save(...args);
        engine.store.save = save;
        throw new Error("Interrupted after the first saved Stop decision");
      };
      expect(() => engine.resolveMaintenanceSettings(run.taskId, "stop")).toThrow("Interrupted after the first saved Stop decision");
      await engine.shutdown();
return async (engine: Engine) => {

      const stopped = engine.taskDetails(run.taskId)!;
      expect(stopped.state).toBe("cancelled"); expect(stopped.maintenance?.settingsDecision?.choice).toBe("stop");
      expect(engine.getState().inbox.some(item => item.taskId === run.taskId)).toBe(false);
      fakes.scenario({ maintenance: {} });
      const control = await createRoutine(engine, run.productId); engine.setPoolPaused(false);
      expect((await result(engine, control.taskId)).state).toBe("done");
      expect(engine.taskDetails(run.taskId)!.state).toBe("cancelled"); expect(fakes.prompts()).toHaveLength(2);


};

      };
      let next = await start(phase);
      if (next) next = await start(next);
      if (next) await start(next);
    });
  });
  it("recovers interrupted read-only cleanup before accepting a held result, then allows a fresh retry", async () => {
    await setup("read-only-recovery", { mismatch: true, readOnlyWrite: true }, async ({ world, fakes, start }) => {
      const phase: MaintenancePhase = async (engine: Engine) => {


      const run = await create(engine, world.clone); engine.setPoolPaused(false);
      const held = await result(engine, run.taskId);
      const copy = held.worktree!;
      await engine.shutdown();
      // Recreate the persisted boundary between saving the hold and finishing read-only cleanup.
      writeFileSync(join(copy, "maintenance.txt"), "Interrupted read-only write\n");

return async (engine: Engine) => {
 engine.resolveMaintenanceSettings(run.taskId, "keep"); engine.setPoolPaused(false);
      const failed = await result(engine, run.taskId);
      expect(failed.state).toBe("failed"); expect(failed.error).toContain("read-only");
      expect(existsSync(join(copy, "maintenance.txt"))).toBe(false);
      expect(failed.maintenance?.noProductChanges).not.toBe(true);
      fakes.scenario({ maintenance: {} });
      await engine.retry(engine.getState().inbox.find(i => i.taskId === run.taskId && i.kind === "stuck")!.id);
      expect((await result(engine, run.taskId)).state).toBe("done");


};

      };
      let next = await start(phase);
      if (next) next = await start(next);
      if (next) await start(next);
    });
  });
  it("uses two independent reviewer conversations when only one tool is available", async () => {
    await setup("one-tool", { change: true }, async ({ world, fakes, start }) => {
      const phase: MaintenancePhase = async (engine: Engine) => {


      await engine.checkTools(); engine.stopRequested.signal.throwIfAborted();
      const run = await create(engine, world.clone, "maintenance-dead-code"); engine.setPoolPaused(false);
      const task = await result(engine, run.taskId);
      expect(task.error).toBeUndefined(); expect(task.state).toBe("needs-you");
      const reviews = fakes.received("code reviewer");
      expect(reviews).toHaveLength(2); expect(reviews[0]!.session).not.toBe(reviews[1]!.session);
      for (const review of reviews) expect(fakes.opens().find(open => open.session === review.session)?.tool).toBe("codex");


      };
      let next = await start(phase, "codex");
      if (next) next = await start(next);
      if (next) await start(next);
    });
  });

  for (const issue of ["repository missing", "tool failure"] as const) it(`keeps ${issue} visible without successful completion or another occurrence`, async () => {
    await setup(issue, {}, async ({ world, fakes, start }) => {
      const phase: MaintenancePhase = async (engine: Engine) => {


      const run = await create(engine, world.clone);
      if (issue === "repository missing") removeDir(world.clone);
      else fakes.scenario({ maintenance: {}, failure: { role: "bug finder", message: "Investigation unavailable", httpStatus: 500 } });
      engine.setPoolPaused(false);
      const task = await result(engine, run.taskId);
      expect(task.state).toBe("failed"); expect(task.error).toBeTruthy(); expect(task.maintenance?.noProductChanges).not.toBe(true);
      engine.pollRoutines(run.due + 86_400_000);
      expect(engine.getState().routines![0]!.blockingTaskId).toBe(run.taskId);
      expect(engine.getState().tasks.filter(t => t.maintenance)).toHaveLength(1);


      };
      let next = await start(phase);
      if (next) next = await start(next);
      if (next) await start(next);
    });
  });
  it("rolls back interrupted admission before retrying and respects drain admission", async () => {
    await setup("atomic-save", {}, async ({ world, fakes, start }) => {
      const phase: MaintenancePhase = async (engine: Engine) => {


      const run = await create(engine, world.clone);
      engine.cancel(run.taskId);
      engine.store.database.run("CREATE TEMP TRIGGER fail_admission BEFORE INSERT ON active_tasks BEGIN SELECT RAISE(ABORT, 'interrupted admission'); END");
      const now = run.due + 86_400_000;
      expect(() => engine.pollRoutines(now)).toThrow("interrupted admission");
      expect(engine.getState().routines![0]!.latestTaskId).toBe(run.taskId);
      engine.store.database.run("DROP TRIGGER fail_admission");
      await engine.shutdown();
return async (engine: Engine) => {

      engine.draining = true;
      engine.pollRoutines(now); engine.schedule();
      const taskId = engine.getState().routines![0]!.latestTaskId!;
      expect(taskId).not.toBe(run.taskId); expect(engine.taskDetails(taskId)!.state).toBe("queued");
      expect(fakes.prompts()).toHaveLength(0);
      engine.pollRoutines(now); expect(engine.getState().tasks.filter(t => t.maintenance && t.state === "queued")).toHaveLength(1);
      engine.draining = false; engine.setPoolPaused(false);
      expect((await result(engine, taskId)).state).toBe("done");


};

      };
      let next = await start(phase);
      if (next) next = await start(next);
      if (next) await start(next);
    });
  });

  for (const issue of ["unsupported", "unconfirmed"] as const) it(`waits for ${issue} settings without sending maintenance instructions or substituting`, async () => {
    await setup(issue, { [issue]: true }, async ({ world, fakes, start }) => {
      const phase: MaintenancePhase = async (engine: Engine) => {


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


      };
      let next = await start(phase);
      if (next) next = await start(next);
      if (next) await start(next);
    });
  });

  it("waits on the exact saved profile after a usage limit", async () => {
    await setup("usage", {}, async ({ world, fakes, start }) => {
      const phase: MaintenancePhase = async (engine: Engine) => {

    fakes.scenario({ maintenance: {}, limited: [{ model: "gpt-6.1-sol", role: "bug finder" }] });

      const run = await create(engine, world.clone); engine.setPoolPaused(false);
      await until(engine, state => state.tasks.find(t => t.id === run.taskId)?.statusLine.includes("Waiting for usage") === true, () => {});
      expect(fakes.received().every(r => r.role === "bug finder")).toBe(true);
      expect(engine.taskDetails(run.taskId)!.maintenance!.profile.id).toBe("sol-medium");
      engine.pollRoutines(run.due + 86_400_000);
      expect(engine.getState().routines![0]!.blockingTaskId).toBe(run.taskId);


      };
      let next = await start(phase);
      if (next) next = await start(next);
      if (next) await start(next);
    });
  });
  it("keeps changed work at Medium risk behind checks, two fresh reviewers and delivery approval", async () => {
    await setup("changed", { change: true }, async ({ world, fakes, start }) => {
      const phase: MaintenancePhase = async (engine: Engine) => {


      const custom = engine.addRole({ ...draftOf(MAINTENANCE_ROLES[0]!), name: "Repository caretaker" });
      const run = await create(engine, world.clone, custom, "sol-medium", true);
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


      };
      let next = await start(phase);
      if (next) next = await start(next);
      if (next) await start(next);
    });
  });

  it("returns failed checks to the frozen maintenance agent and completes withdrawn changes without review", async () => {
    await setup("check-repair", { change: true }, async ({ world, fakes, start }) => {
      const phase: MaintenancePhase = async (engine: Engine) => {


      const run = await create(engine, world.clone, "maintenance-dead-code");
      engine.setProductChecks(run.productId, [{ name: "Confirmed repair", command: commandInputText([process.execPath, "-e", "process.exit(1)"]) }]);
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


      };
      let next = await start(phase);
      if (next) next = await start(next);
      if (next) await start(next);
    });
  });

  for (const choice of ["keep", "stop"] as const) it(`persists a settings decision across restart and can ${choice} the actual turn`, async () => {
    await setup(`mismatch-${choice}`, { change: true, mismatch: true }, async ({ world, fakes, start }) => {
      const phase: MaintenancePhase = async (engine: Engine) => {


      const run = await create(engine, world.clone, "maintenance-dead-code"); engine.setPoolPaused(false);
      const held = await result(engine, run.taskId);
      expect(held.maintenance?.settingsDecision?.actual).toContain("high");
      expect(held.checks).toBeUndefined();
      const count = fakes.received("dead-code cleanup").length;
      await engine.shutdown();
return async (engine: Engine) => {

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


};

      };
      let next = await start(phase);
      if (next) next = await start(next);
      if (next) await start(next);
    });
  });

  it("uses the saved maintenance role for review send-backs and update conflicts", async () => {
    await setup("review-repair", { change: true }, async ({ world, fakes, start }) => {
      const phase: MaintenancePhase = async (engine: Engine) => {

    fakes.scenario({ maintenance: { change: true }, reviewer: "important-twice" });

      const custom = engine.addRole({ ...draftOf(MAINTENANCE_ROLES[0]!), name: "Focused caretaker" });
      const run = await create(engine, world.clone, custom); engine.removeRole(custom);
      engine.setPoolPaused(false);
      const task = await result(engine, run.taskId);
      expect(task.error).toBeUndefined(); expect(task.state).toBe("needs-you");
      expect(fakes.received("focused caretaker").length).toBeGreaterThan(1);
      expect(task.findings.some(finding => finding.verification)).toBe(true);
      const before = fakes.received("focused caretaker").length;
      writeFileSync(join(world.clone, "maintenance.txt"), "Default branch moved\n");
      await git(world.clone, "add", "maintenance.txt"); await git(world.clone, "commit", "-m", "Change maintenance file");
      await git(world.clone, "push", world.remote, "main");
      fakes.scenario({ maintenance: { change: true } });
      const item = engine.getState().inbox.find(i => i.taskId === run.taskId && i.kind === "delivery")!;
      engine.approve(item.id);
      await until(engine, () => fakes.received("focused caretaker").length > before || engine.taskDetails(run.taskId)?.state === "failed", () => {});
      expect(engine.taskDetails(run.taskId)!.error).toBeUndefined();
      expect(fakes.received("focused caretaker").length).toBeGreaterThan(before);
      expect(fakes.received().some(r => r.role === "builder")).toBe(false);


      };
      let next = await start(phase);
      if (next) next = await start(next);
      if (next) await start(next);
    });
  });
  it("queues while paused, rejects all workflow roles, and preserves exact intent after edits, deletion and restart", async () => {
    await setup("saved-intent", {}, async ({ world, fakes, start }) => {
      const phase: MaintenancePhase = async (engine: Engine) => {


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
      await engine.shutdown();
return async (engine: Engine) => {

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


};

      };
      let next = await start(phase);
      if (next) next = await start(next);
      if (next) await start(next);
    });
  });



  for (const profileId of ["astra-ultra", "sol-ultra", "sol-medium"]) it(`executes the saved ${profileId} profile and finishes writable investigations without changes`, async () => {
    await setup(profileId, {}, async ({ world, fakes, start }) => {
      const phase: MaintenancePhase = async (engine: Engine) => {


      const run = await create(engine, world.clone, "maintenance-dead-code", profileId);
      engine.setPoolPaused(false);
      const completed = await result(engine, run.taskId);
      expect(completed.error).toBeUndefined(); expect(completed.state).toBe("done"); expect(completed.maintenance!.noProductChanges).toBe(true);
      expect(completed.report?.summary).toContain("Investigated"); expect(completed.checks).toBeUndefined();
      expect(fakes.received().map(r => r.role)).toEqual(["dead-code cleanup"]);
      const configured = readFileSync(join(fakes.dir, "config.jsonl"), "utf8");
      expect(configured).toContain(completed.maintenance!.profile.modelId!); expect(configured).toContain(completed.maintenance!.profile.effort);


      };
      let next = await start(phase);
      if (next) next = await start(next);
      if (next) await start(next);
    });
  });

  for (const [name, behavior] of [["incomplete", { incomplete: true }], ["read-only writes", { readOnlyWrite: true }]] as const) it(`does not call ${name} a successful empty investigation`, async () => {
    await setup(name, behavior, async ({ world, start }) => {
      const phase: MaintenancePhase = async (engine: Engine) => {


      const run = await create(engine, world.clone); engine.setPoolPaused(false);
      const task = await result(engine, run.taskId);
      expect(task.error).toContain(name === "incomplete" ? "incomplete" : "read-only"); expect(task.state).toBe("failed"); expect(task.maintenance!.noProductChanges).not.toBe(true);
      if (behavior.readOnlyWrite && task.worktree) expect(existsSync(join(task.worktree, "maintenance.txt"))).toBe(false);


      };
      let next = await start(phase);
      if (next) next = await start(next);
      if (next) await start(next);
    });
  });

  it("excludes maintenance from actual planner descriptions and every ordinary stage position", async () => {
    await setup("isolation", {}, async ({ world, fakes, start }) => {
      const phase: MaintenancePhase = async (engine: Engine) => {


      const productId = installPreparedProduct(engine, acmeDemoProduct(world.clone));
      const ordinary = engine.addTask({ productId, title: "Plan an ordinary task", approvePlan: true });
      engine.setPoolPaused(false);
      await until(engine, () => !!engine.taskDetails(ordinary)?.plan || engine.taskDetails(ordinary)?.state === "failed", () => {});
      expect(engine.taskDetails(ordinary)?.error).toBeUndefined();
      const actualInput = fakes.prompts("planner")[0]!;
      expect(actualInput).toContain("builder");
      for (const role of MAINTENANCE_ROLES) expect(actualInput).not.toContain(role.id);



      };
      let next = await start(phase);
      if (next) next = await start(next);
      if (next) await start(next);
    });
  });
});
