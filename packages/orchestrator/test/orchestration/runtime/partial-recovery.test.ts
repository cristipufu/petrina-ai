import { expect, it } from "vitest";
import { beginAgentStep, openStep, stepKey } from "@petrina/core";
import { partialRecoveryFixture } from "../../fixtures/partial-recovery.js";

const scenarios = [
  { timing: "after failure", how: "clear", dirty: true },
  { timing: "after failure", how: "landed", dirty: true },
  { timing: "startup", how: "clear", dirty: true },
  { timing: "startup", how: "landed", dirty: true },
  { timing: "after failure", how: "clear", dirty: false },
  { timing: "startup", how: "landed", dirty: false },
  { timing: "during attempt", how: "clear", dirty: true },
  { timing: "during attempt", how: "landed", dirty: true },
  { timing: "during attempt", how: "clear", dirty: false },
  { timing: "during attempt", how: "none", dirty: true },
] as const;

for (const scenario of scenarios) it(`retains the editable attempt through repeated failure: ${scenario.timing}, ${scenario.how}, dirty=${scenario.dirty}`, async () => {
  const f = partialRecoveryFixture();
  const released = () => { if (scenario.how !== "none") { f.hold(); f.release(scenario.how); } };
  try {
    if (scenario.timing === "startup") f.holdStartup();
    const first = f.start();
    if (scenario.timing === "startup") {
      await f.entered(0, true);
      expect(f.scope.work.editAttempt).toEqual({ step: stepKey(f.task) });
      expect(f.attempts[0]!.admitted).toBe(false);
      expect(f.scope.work.conversation).toBeUndefined();
      released();
      expect(f.ownership.refreshDue(f.task)).toBe(false);
      f.releaseStartup(0);
    }
    await f.entered(0);
    if (scenario.timing === "during attempt") released();
    if (scenario.dirty) f.writePartial("First partial observation");
    f.reply(0, "fail"); await first;
    expect(f.task.state).toBe("failed");
    expect(f.scope.work.editAttempt).toEqual({ step: stepKey(f.task), failed: true });
    if (scenario.timing === "after failure") released();
    expect(f.scope.work.baseSha).toBe("supplied:initial");
    if (scenario.how !== "none") expect(f.task.runtimeWait?.refreshPending).toBe(true);

    const recovery = { base: scenario.how !== "none" && !scenario.dirty ? "supplied:latest" : "supplied:initial",
      partial: scenario.dirty ? "First partial observation" : undefined };
    const second = f.start(); await f.entered(1);
    expect(f.attempts[1]).toMatchObject(recovery); expect(f.reviewed).toEqual([]);
    if (scenario.dirty) f.writePartial("Second partial observation");
    f.reply(1, "fail"); await second;
    expect(f.task.state).toBe("failed"); expect(f.scope.work.editAttempt?.failed).toBe(true);

    const last = f.start(); await f.entered(2);
    expect(f.attempts[2]).toMatchObject({ ...recovery, partial: scenario.dirty ? "Second partial observation" : undefined });
    f.reply(2, "pass"); await last;
    expect(f.task.error).toBeUndefined();
    expect(f.reviewed).toEqual([{ base: scenario.how === "none" ? "supplied:initial" : "supplied:latest", partial: scenario.dirty ? "Second partial observation" : undefined }]);
    expect(f.scope.work.editAttempt).toBeUndefined(); expect(f.task.runtimeWait?.refreshPending).toBeUndefined();
    expect(f.task.rounds).toEqual({}); expect(f.attempts).toHaveLength(3);
    expect(f.turn.events.filter(event => event.kind === "attempt")).toHaveLength(3);
    expect(f.task.journey!.filter(step => step.kind === "agent").map(step => step.end)).toEqual(["failed", "failed", "done"]);
    if (scenario.how !== "none") expect(f.task.runtimeWait?.changes).toHaveLength(scenario.how === "clear" ? 2 : 1);
  } finally { await f.close(); }
});

for (const stale of ["stage", "round", "session"] as const) it(`does not let a stale ${stale} defer a newly owed source refresh`, async () => {
  const f = partialRecoveryFixture();
  try {
    f.hold(); f.release("clear");
    const stage = f.task.plan!.stages[0]!;
    if (stale === "session") f.scope.work.conversation = { step: "old-stage:1", roleId: "builder", profileId: "sol-high", toolId: "codex", model: "supplied", sessionId: "supplied:old", startedAt: 1, briefed: true };
    else {
      const step = beginAgentStep(f.task, "builder", "sol-high", f.scheduler.clock.now(), f.scheduler.state.roles);
      step.agentResults = [{ roleId: "builder", profileId: "sol-high", at: 1, value: { summary: "Supplied prior report" } }];
      if (stale === "stage") step.stageId = "earlier";
      else f.task.rounds[stage.id] = 2;
    }
    f.task.runtimeWait!.refreshAfterStep = stepKey(f.task);
    expect(f.ownership.started(f.task)).toBe(false); expect(f.ownership.refreshDue(f.task)).toBe(true);
    await f.source.run(f.task, new AbortController().signal);
    expect(f.calls).toContain("update"); expect(f.scope.work.baseSha).toBe("supplied:latest");
  } finally { await f.close(); }
});

it("uses result kind for interrupted delivery history and retains the originally captured editable step", async () => {
  const f = partialRecoveryFixture();
  try {
    const delivery = { ...f.scheduler.state.roles.find(role => role.result === "delivery")!, id: "custom-publisher", name: "Custom publisher" };
    f.scheduler.state.roles.push(delivery);
    f.task.plan!.stages[0]!.roleId = delivery.id;
    beginAgentStep(f.task, delivery.id, "sol-high", 1, f.scheduler.state.roles);
    openStep(f.task)!.agentResults = [{ roleId: delivery.id, profileId: "sol-high", at: 1, value: { summary: "Supplied interrupted release notes" } }];
    f.hold(); f.release("clear"); f.task.runtimeWait!.refreshAfterStep = stepKey(f.task);
    expect(f.ownership.started(f.task)).toBe(false); expect(f.ownership.refreshDue(f.task)).toBe(true);
    const captured = stepKey(f.task); f.task.stageIndex = 1;
    f.ownership.admitEditable(f.scope, captured); f.ownership.failed(f.scope);
    expect(f.scope.work.editAttempt).toEqual({ step: captured });
    expect(f.ownership.started(f.task)).toBe(false); expect(f.ownership.refreshDue(f.task)).toBe(true);
  } finally { await f.close(); }
});
