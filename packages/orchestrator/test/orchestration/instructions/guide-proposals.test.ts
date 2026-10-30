import { expect, it } from "vitest";
import { GUIDE_POINT, guideProposalsFixture } from "../../fixtures/guide-proposals.js";

it("leaves the guide alone when the coordinator says not this time", async () => {
  const f = guideProposalsFixture(); f.sendBack(); await f.propose();
  f.controller.decline(f.offers[0]!.id);
  expect(f.offers).toHaveLength(1);
  expect(f.logs).toContain("You left the review guide as it is");
  expect(f.product.reviewGuide).toBeUndefined();
});

it("offers nothing when the note was a change of mind", async () => {
  const f = guideProposalsFixture();
  f.reply({ missed: false, line: "", why: "The note asks for a new colour: a change of mind, not a miss." });
  f.sendBack(); await f.propose();
  expect(f.offers).toEqual([]);
  expect(f.logs).toContain("Nothing for the review guide: The note asks for a new colour: a change of mind, not a miss.");
});

it("is not a miss when blocking findings remain: the Guide keeper proposes nothing", async () => {
  const f = guideProposalsFixture();
  f.task.findings.push({ id: "important", text: "The greeting is missing on the welcome page.", severity: "blocking", status: "open", raisedBy: "code-reviewer", confirmedBy: [] });
  f.sendBack(); await f.propose();
  expect(f.offers).toEqual([]);
  expect(f.logs).not.toContain("Guide keeper started");
  expect(f.turns).toEqual([]);
  expect(f.reads).toEqual([]);
  expect(f.task.miss).toBeUndefined();
});

it("offers without blocking and restores the Builder before consuming the miss", async () => {
  const f = guideProposalsFixture(); f.sendBack(); f.task.state = "running";
  const main = { step: "build", roleId: "builder", profileId: "opus-high", toolId: "claude-code", model: "opus", sessionId: "builder", startedAt: 1, briefed: true };
  f.scope.work.conversation = main; f.scope.work.stepAttempts = 3; f.task.todo = "Finish the greeting";
  f.respond(async () => {
    f.scope.work.conversation = { ...main, roleId: "guide-keeper", sessionId: "guide" };
    f.scope.work.stepAttempts = 1; f.task.todo = "Propose the point";
    return { missed: true, line: GUIDE_POINT, why: "The greeting was missed." };
  });
  await f.propose();
  expect(f.offers).toMatchObject([{ blocking: false, body: GUIDE_POINT }]);
  expect(f.task.state).toBe("running");
  expect(f.scope.work.conversation).toEqual(main);
  expect(f.scope.work.stepAttempts).toBe(3); expect(f.task.todo).toBe("Finish the greeting");
  expect(f.scope.work.sideStep).toBeUndefined(); expect(f.task.miss).toBeUndefined();
  expect(f.released).toEqual([f.task.id]);
  expect(f.checkpoints.at(-1)?.miss).toBeUndefined();
  f.controller.accept(f.offers[0]!.id);
  expect(f.product.reviewGuide).toEqual([{ text: GUIDE_POINT, at: 300, fromTask: f.task.id }]);
  expect(f.logs).toContain(`You added to the review guide: ${GUIDE_POINT}`);
});

it("does not propose an already covered point or duplicate an accepted instruction", async () => {
  const f = guideProposalsFixture(); f.sendBack(); f.guide(`- ${GUIDE_POINT}\n`);
  await f.propose();
  expect(f.offers).toEqual([]);
  expect(f.logs).toContain("The review guide already has that point");
  expect(f.turns[0]?.guide).toBe(`- ${GUIDE_POINT}\n`);
  f.guide(""); f.sendBack(); await f.propose();
  const item = f.offers[0]!;
  f.controller.accept(item.id);
  f.state.inbox.push({ ...item, id: "again" }); f.controller.accept("again");
  expect(f.product.reviewGuide).toHaveLength(1);
  expect(f.state.inbox).toEqual([]);
});

it("fresh acceptance restores a previously incorporated rule with a new delivery owner", async () => {
  const f = guideProposalsFixture(); f.sendBack(); await f.propose();
  f.product.reviewGuide = [{ text: GUIDE_POINT, at: 1, fromTask: "old", writtenOn: "old", incorporatedOn: "old-version" }];
  f.controller.accept(f.offers[0]!.id);
  expect(f.product.reviewGuide).toEqual([{ text: GUIDE_POINT, at: 300, fromTask: f.task.id }]);
  expect(f.checkpoints).toHaveLength(3);
});

it("records an unusable Guide's actual profile and carries on without an offer", async () => {
  const f = guideProposalsFixture(), error = new Error("The supplied result was unusable");
  f.sendBack(); f.respond(async () => { throw error; }); await f.propose();
  expect(f.failures).toEqual([{ error, profileId: "sol-high" }]);
  expect(f.offers).toEqual([]);
  expect(f.logs).toContain("The Guide keeper could not finish, so nothing was proposed for the review guide");
  expect(f.task.miss).toBeUndefined(); expect(f.scope.work.sideStep).toBeUndefined();
  expect(f.task.journey?.at(-1)?.end).toBe("done");
});

for (const kind of ["usage", "source"] as const) it(`restores the caller and retains the miss for a deferred ${kind} wait`, async () => {
  const f = guideProposalsFixture(), error = new Error(kind); f.sendBack();
  f.scope.work.stepAttempts = 3; f.task.todo = "Resume the Builder";
  f.deferred.add(error); f.respond(async () => { f.scope.work.stepAttempts = 1; f.task.todo = "Internal"; throw error; });
  await expect(f.propose()).rejects.toBe(error);
  expect(f.scope.work.stepAttempts).toBe(3); expect(f.task.todo).toBe("Resume the Builder");
  expect(f.scope.work.sideStep).toBeUndefined(); expect(f.task.miss).toBeDefined();
  expect(f.released).toEqual([f.task.id]); expect(f.failures).toEqual([]); expect(f.offers).toEqual([]);
  expect(f.checkpoints).toHaveLength(1);
});

for (const kind of ["screen", "abort"] as const) it(`retains the unfinished internal turn after ${kind} interruption`, async () => {
  const f = guideProposalsFixture(), error = new Error(kind); f.sendBack();
  f.scope.work.stepAttempts = 3;
  if (kind === "screen") f.interrupted.add(error);
  f.respond(async () => { f.scope.work.stepAttempts = 1; if (kind === "abort") f.signal.abort(); throw error; });
  await expect(f.propose()).rejects.toBe(error);
  expect(f.scope.work.sideStep?.stepAttempts).toBe(3); expect(f.scope.work.stepAttempts).toBe(1);
  expect(f.task.miss).toBeDefined(); expect(f.released).toEqual([]); expect(f.failures).toEqual([]);
  expect(f.checkpoints).toHaveLength(1);
});
