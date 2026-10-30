import { expect, it } from "bun:test";
import { sourceParticipantInput } from "../../fixtures/source-participant-input.js";

it("keeps each conflict-dropped conversation's reason with its own stage and seat until that seat starts", async () => {
  const f = sourceParticipantInput();
  try { await f.input.run(async () => {
    const later = { ...f.stage, id: "later", title: "Review once more" }; f.task.plan!.stages.push(later);
    await f.round(1);
    // The saved input is an actual completed scripted conversation, as in the native case.
    f.task.reviewSessions = { ...f.task.reviewSessions, later: { "1": structuredClone(f.task.reviewSessions![f.stage.id]!["1"]!) } };
    const why = "main conflicted with the change, so the Builder had to port it";
    await f.begin();
    expect(f.task.reviewSessions).toBeUndefined();
    expect(f.task.reviewFreshReasons).toEqual({ [f.stage.id]: { "0": why, "1": why }, later: { "1": why } });
    f.task.stageIndex = f.task.plan!.stages.indexOf(later);
    const choose = (key: string) => f.scheduler.selection.selection.choose(later.profileIds[Number(key)]!, f.scope, later.roleId, () => true, key);
    expect(choose("0")).not.toHaveProperty("freshReason"); expect(choose("1")).toMatchObject({ freshReason: why });
    await f.drive();
    const round2 = await f.round(2); expect(round2).toHaveLength(2);
    for (const result of round2) expect(result.input).toMatchObject({ mode: "fresh", freshReason: why });
    expect(f.task.reviewFreshReasons).toEqual({ later: { "1": why } });
    await f.begin(); await f.drive();
    expect(f.task.reviewFreshReasons).toEqual({ [f.stage.id]: { "0": why, "1": why }, later: { "1": why } });
    const round3 = await f.round(3); expect(round3).toHaveLength(2);
    for (const result of round3) expect(result.input).toMatchObject({ mode: "fresh", freshReason: why });
    const round4 = await f.round(4); expect(round4).toHaveLength(2);
    for (const result of round4) { expect(result.input.mode).toBe("continued"); expect(result.input.freshReason).toBeUndefined(); }
    expect(f.task.reviewFreshReasons).toEqual({ later: { "1": why } });
  }); } finally { await f.close(); }
});
