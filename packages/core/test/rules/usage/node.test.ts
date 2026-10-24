import { describe, expect, it } from "vitest";
import { continuingAgentTurn, turnTokens } from "../../../src/worklog.js";
import { agent, fixture } from "../../fixtures/node-usage.js";

describe("exact step usage", () => {
  it("separates j27 and j32 despite the same review stage and round", () => {
    const f = fixture([agent("j27", 10, 20), agent("j32", 30, 40)]);
    f.turn("first", { sessionId: "review-one" });
    f.turn("second", { startedAt: 31, endedAt: 39, sessionId: "review-two", tokens: { total: 900 } });
    expect(f.view("j27").tokens.value).toBe(100);
    expect(f.view("j32").tokens.value).toBe(900);
  });

  it("separates builder jobs in one native conversation, including starts within a step", () => {
    const ids = ["j10", "j12", "j14", "j16", "j21", "j25", "j30"];
    const f = fixture(ids.map((id, i) => agent(id, i * 10, i * 10 + 10, { stageId: "build", roleId: "builder", usageTracked: true })));
    ids.forEach((id, i) => f.turn(id, { journeyId: id, agentRunId: `start-${i}`, roleId: "builder", stageId: "build", startedAt: i * 10 + 1, endedAt: i * 10 + 2, tokens: { total: i + 1 } }));
    f.turn("answer", { journeyId: "j30", agentRunId: "start-6", reason: "answer", tokens: { total: 20 } });
    f.turn("restart", { journeyId: "j30", agentRunId: "restarted", tokens: { total: 50 } });
    expect(ids.map(id => f.view(id).tokens.value)).toEqual([1, 2, 3, 4, 5, 6, 77]);
    expect(f.view("j30").runs.map(run => run.tokens.value)).toEqual([27, 50]);
    expect(f.view("j30", true)).toEqual(f.view("j30"));
  });

  it("keeps actual seats and replacement starts separate even when profiles match", () => {
    const f = fixture([agent("j1", 10, 80, { usageTracked: true })]);
    for (const [id, seat, run, total, tool] of [["a", "0", "a1", 100, "codex"], ["b", "1", "b1", 200, "codex"], ["c", "0", "a2", 300, "grok"]] as const) f.turn(id, { journeyId: "j1", agentRunId: run, agentSeat: seat, toolId: tool, modelRan: tool === "grok" ? "grok-4.7" : "sol", tokens: { total } });
    expect(f.view().tokens.value).toBe(600);
    expect(f.view().runs.map(run => [run.seat, run.start, run.toolId, run.model, run.tokens.value])).toEqual([[1, 1, "codex", "sol", 100], [2, 1, "codex", "sol", 200], [1, 2, "grok", "Grok 4.7", 300]]);
  });

  it("uses the latest report once, counts cache once and replaces prior model lines", () => {
    const f = fixture([agent("j1", 10, 50, { usageTracked: true })]);
    f.turn("turn", { journeyId: "j1", tokens: undefined, end: undefined, endedAt: undefined });
    const count = (input: number) => turnTokens({ toolId: "claude-code", report: { main: { total: 9000 }, models: [{ model: "opus", counts: { input, output: 20, cacheRead: 200, cacheWrite: 30 } }] } });
    for (const input of [10, 40, 40]) {
      const report = count(input);
      f.log.endTurn("turn", { tokens: report.tokens, end: "finished", endedAt: 20 }, report.lines);
    }
    expect(f.view().tokens).toEqual({ value: 290, atLeast: false });
    expect(f.view().detail.cacheRead.value).toBe(200);
    expect(f.view().runs[0]!.models).toEqual([{ label: "opus", tokens: 290 }]);
  });

  it("marks a breakdown as partial when one reported model omits that part", () => {
    const f = fixture([agent("j1", 10, 50, { usageTracked: true })]);
    f.turn("turn", { journeyId: "j1", tokens: undefined });
    const report = turnTokens({ toolId: "claude-code", report: { models: [
      { model: "opus", counts: { input: 10, output: 20, cacheRead: 100 } },
      { model: "haiku", counts: { total: 150 } },
    ] } });
    f.log.endTurn("turn", { tokens: report.tokens }, report.lines);
    expect(f.view().tokens).toEqual({ value: 280, atLeast: false });
    expect(f.view().detail.input).toEqual({ value: 10, atLeast: true });
    expect(f.view().detail.cacheWrite.value).toBeUndefined();
  });

  it("shows pending, missing, partial and reported-zero evidence without inventing parts", () => {
    const f = fixture([agent("j1", 10, undefined, { usageTracked: true })]);
    expect(f.view().empty).toBe("pending");
    f.turn("live", { journeyId: "j1", end: undefined, endedAt: undefined, tokens: undefined });
    expect(f.view().tokens.value).toBeUndefined();
    expect(f.view().empty).toBe("pending");
    f.log.endTurn("live", { end: "finished", endedAt: 25, tokens: { total: 100 } });
    expect(f.view().tokens.value).toBe(100);
    expect(f.view().detail.input.value).toBeUndefined();
    f.turn("missing", { journeyId: "j1", tokens: undefined });
    expect(f.view().tokens).toEqual({ value: 100, atLeast: true });
    expect(f.view().explanation).not.toContain("At least");
    expect(f.view().explanation).not.toContain("turn sent no token report");
    f.log.endTurn("missing", { tokens: { total: 0, output: 0 } });
    expect(f.view().tokens).toEqual({ value: 100, atLeast: false });
    expect(f.view().detail.output).toEqual({ value: 0, atLeast: true });
  });

  it("excludes old turns outside a step or overlapping steps, while retaining safe controls", () => {
    const f = fixture([agent("j1", 10, 30), agent("j2", 20, 40), agent("j3", 50, 60), agent("old", 70, 80)]);
    f.turn("safe", { startedAt: 11, endedAt: 15 });
    f.turn("overlap", { startedAt: 21, endedAt: 25, tokens: { total: 1000 } });
    f.turn("crossing", { startedAt: 49, endedAt: 55 });
    f.turn("other-task", { taskId: "other", startedAt: 51, endedAt: 59 });
    expect(f.view("j1").tokens).toEqual({ value: 100, atLeast: true });
    for (const id of ["j2", "j3", "old"]) expect(f.view(id).empty).toBe("unavailable");
  });

  it("leaves partially overlapping old turns and contradictory rounds unassigned", () => {
    const f = fixture([agent("j1", 10, 30), agent("j2", 20, 40), agent("j3", 50, 60)]);
    f.turn("overlaps-later", { startedAt: 11, endedAt: 25 });
    f.turn("wrong-round", { startedAt: 51, endedAt: 59, round: 2 });
    expect(f.view("j1").empty).toBe("unavailable");
    expect(f.view("j2").empty).toBe("unavailable");
    expect(f.view("j3").empty).toBe("unavailable");
  });

  it("keeps interleaved legacy conversations together without inventing parallel seats", () => {
    const f = fixture([agent("j1", 10, 50, { team: ["sol-high", "opus-high"] })]);
    f.turn("a", { sessionId: "a", startedAt: 11, endedAt: 15 });
    f.turn("b", { sessionId: "b", startedAt: 12, endedAt: 16 });
    f.turn("a-answer", { sessionId: "a", reason: "answer", startedAt: 21, endedAt: 25 });
    f.turn("b-answer", { sessionId: "b", reason: "answer", startedAt: 22, endedAt: 26 });
    expect(f.view().runs.map(run => [run.tokens.value, run.seat])).toEqual([[200, undefined], [200, undefined]]);
  });

  it("never assigns numbers to checks, publishing, checkpoints, waits or missing steps", () => {
    for (const kind of ["petrina", "you", "wait"] as const) {
      const f = fixture([agent("j1", 10, 30, { kind })]);
      f.turn("unrelated");
      expect(f.view().empty).toBe("no-agent");
      expect(f.view().tokens.value).toBeUndefined();
      expect(f.view("future").tokens.value).toBeUndefined();
    }
  });

  
});

it.each([false, true])("keeps fixed reviewer seats when the second seat starts first: %s", reverse => {
  const f = fixture([agent("j1", 10, 80, { usageTracked: true })]);
  for (const [id, seat, total, time] of [["first", "0", 100, reverse ? 20 : 11], ["second", "1", 200, reverse ? 11 : 20]] as const) {
    f.turn(id, { journeyId: "j1", agentRunId: id, agentSeat: seat, startedAt: time, tokens: { total } });
  }
  f.turn("replacement", { journeyId: "j1", agentRunId: "replacement", agentSeat: "0", startedAt: 40, tokens: { total: 300 } });
  expect(f.view().runs.map(run => [run.seat, run.start, run.tokens.value]).sort((a,b) => Number(a[2]) - Number(b[2]))).toEqual([[1,1,100],[2,1,200],[1,2,300]]);
});

it("uses plain missing-report states and keeps a pending turn out of completed breakdowns", () => {
  const f = fixture([agent("j1", 10, undefined, { usageTracked: true })]);
  f.turn("first", { journeyId: "j1", end: undefined, endedAt: undefined, tokens: undefined });
  expect(f.view().empty).toBe("pending");
  f.log.endTurn("first", { end: "finished", endedAt: 20 });
  expect(f.view().empty).toBe("unreported");
  const tokens = { input: 10, output: 20, cacheRead: 30, cacheWrite: 40, total: 100 };
  f.log.endTurn("first", { tokens });
  f.turn("second", { journeyId: "j1", end: undefined, endedAt: undefined, tokens: undefined });
  expect(f.view().tokens).toEqual({ value: 100, atLeast: true });
  expect(Object.values(f.view().detail).every(figure => !figure.atLeast)).toBe(true);
  expect(f.view().breakdownIncomplete).toBe(false);
  expect(f.view().explanation).toContain("not reported yet");
  f.log.endTurn("second", { end: "finished", endedAt: 30 });
  expect(f.view().explanation).not.toContain("At least");
    expect(f.view().explanation).not.toContain("turn sent no token report");
  expect(f.view().breakdownIncomplete).toBe(false);
  f.log.endTurn("second", { tokens: { total: 200 } });
  expect(f.view().breakdownIncomplete).toBe(true);
});




it("recovers a continuation only from the same saved step, seat, tool, profile and native session", () => {
  const f = fixture([agent("j1", 10, 80, { usageTracked: true })]);
  const original = f.turn("first", { journeyId: "j1", agentRunId: "start", agentSeat: "1" });
  const scope = { taskId: original.taskId, journeyId: original.journeyId, agentSeat: original.agentSeat, roleId: original.roleId, toolId: original.toolId, profileId: original.profileId, sessionId: original.sessionId };
  const turns = f.log.turns({ taskId: "task" });
  expect(continuingAgentTurn(turns, scope)?.agentRunId).toBe("start");
  for (const field of ["taskId", "journeyId", "agentSeat", "roleId", "toolId", "profileId", "sessionId"] as const) expect(continuingAgentTurn(turns, { ...scope, [field]: "other" })).toBeUndefined();
});


it.each(["before tracking", "overlapping work"])("keeps complete reports distinct from omitted %s", reason => {
  const f = fixture([agent("j1", reason === "before tracking" ? 0 : 10, 30), agent("j2", 20, 40)]);
  f.turn("counted", { startedAt: 11, endedAt: 15, tokens: { input: 10, output: 20, cacheRead: 30, cacheWrite: 40, total: 100 } });
  if (reason === "overlapping work") f.turn("ambiguous", { startedAt: 21, endedAt: 25 });
  const view = f.view();
  expect(view.tokens).toEqual({ value: 100, atLeast: true });
  expect(Object.values(view.detail).every(part => part.atLeast)).toBe(true);
  expect(view.breakdownIncomplete).toBe(false);
  expect(view.explanation).toContain(reason === "before tracking" ? "Earlier work is not included" : "could not be separated");
});
