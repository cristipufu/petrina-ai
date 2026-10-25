import { describe, expect, it } from "vitest";

import { JOURNEY_WORDS as W, stepName } from "../../../src/journey.js";
import { BUILT_IN_ROLES } from "../../../src/library.js";

import type { JourneyStep } from "../../../src/model.js";

describe("step names", () => {
  const step = (fields: Partial<JourneyStep>): JourneyStep => ({ id: "j", kind: "agent", round: 1, sub: 0, startedAt: 0, ...fields });

  const name = (fields: Partial<JourneyStep>, earlier: Partial<JourneyStep>[] = []) => stepName(step(fields), earlier.map(step), BUILT_IN_ROLES);

  it("say what each repeat is, never a counter", () => {
    expect(name({ roleId: "architect", stageId: "d", round: 2 })).toBe("Architect (round 2)");
    expect(name({ roleId: "design-reviewer", stageId: "d", round: 2, sub: 1 })).toBe("Design reviewer (round 2)");
    expect(name({ roleId: "architect", stageId: "d", call: true })).toBe("Architect (your call)");
    const firstFix = { roleId: "builder", stageId: "b", fixing: true, endedAt: 5, end: "done" as const };
    expect(name({ roleId: "builder", stageId: "b", fixing: true })).toBe("Builder (fixes)");
    expect(name({ roleId: "builder", stageId: "b", fixing: true }, [firstFix])).toBe("Builder (fixes 2)");
    expect(name({ roleId: "builder", stageId: "b", fixing: true }, [{ ...firstFix, end: "failed" }])).toBe("Builder (fixes, again)");
    expect(name({ roleId: "builder", stageId: "b" }, [{ roleId: "builder", stageId: "b", endedAt: 5, end: "failed" }])).toBe("Builder (again)");
    expect(name({ kind: "you", waitsFor: "delivery" })).toBe("Your delivery check");
    expect(name({ kind: "wait" })).toBe("Waiting for others");
    expect(name({ roleId: "code-reviewer", round: 2, team: ["a", "b"] })).toBe("Code reviewers (round 2)");
    expect(name({ roleId: "builder", stageId: "b", update: true })).toBe("Builder (update)");
    expect(name({ kind: "petrina", work: "checks", stageId: "r", round: 2 })).toBe("Automated checks (round 2)");
    expect(name({ kind: "petrina", work: "delivery", stageId: "s" }, [{ kind: "petrina", work: "delivery", stageId: "s", endedAt: 5 }])).toBe("Publish delivery (again)");
    expect(name({ kind: "petrina", work: "update" })).toBe("Update branch");
    expect(name({ kind: "petrina", work: "update", stageId: "r", round: 2 })).toBe("Update branch");
    expect(name({ roleId: "code-reviewer", stageId: "r", round: 2, port: true }, [{ roleId: "code-reviewer", stageId: "r", round: 2, endedAt: 5 }])).toBe("Code reviewer (port)");
    expect(name({ kind: "petrina", work: "checks", stageId: "r", round: 2, port: true })).toBe("Automated checks (port)");
  });

  it("put the words on the arrows", () => {
    expect([W.blocking(2), W.sentBack(3), W.checksFailed(2), W.landed(["Guest checkout"]), W.landed(["A", "B"]), W.othersCancelled(["A"])]).toEqual([
      "2 blocking objections",
      "sent back: 3 important",
      "2 checks failed",
      "“Guest checkout” landed",
      "“A” and “B” landed",
      "“A” did not land: cancelled",
    ]);
    expect([W.youApproved, W.changesAsked, W.yourCall, W.youSided, W.tryAgain, W.noLongerWaits]).toEqual(["you approved", "changes asked", "your call", "you sided with the architect", "you asked to try again", "no longer waits"]);
  });
});
