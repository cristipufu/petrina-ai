import { executionFor } from "@petrina/orchestrator";
import { afterAll, describe, expect, it } from "bun:test";

import { requestRevision } from "../../../src/coordination.js";

import { coordinatorApiFixtures } from "../../fixtures/coordinator-api.js";
const owners = coordinatorApiFixtures();
afterAll(() => owners.close());

describe("focused coordination and durable decisions", () => {
it("binds checkpoint approval to source and all assignments, while unrelated activity stays valid", async () => {
  return owners.use(async ({ e, c, taskId, offer, inspect }) => {

    const t = e.task(taskId)!;
    executionFor(t).work.source = {
      product: { id: "product", name: "Example", repo: "local/example" },
      start: { kind: "default", branch: "main" },
      destination: { mode: "local", repo: "local/example", branch: "main", kind: "branch" },
      confirmed: true,
    };
    t.plan = {
      stages: [{ id: "build", title: "Build", kind: "do", roleId: "builder", profileIds: ["opus-high"] }],
      rationale: "Do the work",
      plannerProfileId: "opus-high",
    };
    const itemId = offer("plan"),
      first = await inspect(itemId);
    t.plan.stages[0]!.profileIds[0] = "sol-xhigh";
    expect((await c.call("inbox.approve", { itemId, revision: first.revision, requestId: "old-plan" })).outcome).toBe("changed");
    expect(e.s.inbox.some((i) => i.id === itemId)).toBe(true);
    const second = await inspect(itemId);
    t.workChoice = { productId: "product", startFrom: { kind: "branch", name: "feature" }, delivery: "local" };
    expect((await c.call("inbox.approve", { itemId, revision: second.revision, requestId: "old-source" })).outcome).toBe("changed");
    const third = await inspect(itemId);
    e.say(t, "activity", "An unrelated clock tick");
    const args = { itemId, revision: third.revision, requestId: "approve-once" };
    expect((await c.call("inbox.approve", args)).outcome).toBe("completed");
    expect(await c.call("inbox.approve", args)).toEqual(await c.call("inbox.approve", args));
    expect((await c.call("inbox.approve", { ...args, requestId: "already-gone" })).outcome).toBe("handled");
  });
});
});

describe("focused coordination and durable decisions", () => {
it("serializes app plan edits with decisions and returns the saved outcome after a lost reply", async () => {
  return owners.use(async ({ e, c, taskId, offer, inspect }) => {

    e.task(taskId)!.plan = {
      stages: [{ id: "build", title: "Build", kind: "do", roleId: "builder", profileIds: ["opus-high"] }],
      rationale: "",
      plannerProfileId: "opus-high",
    };
    const itemId = offer("plan"),
      read = await inspect(itemId);
    const { dispatch } = await import("../../../src/server.js");
    const edit = dispatch(e, { name: "setStageProfile", args: [taskId, "build", "profileIds", 0, "sol-xhigh"] });
    const approve = c.call("inbox.approve", { itemId, revision: read.revision, requestId: "raced" });
    await edit;
    expect((await approve).outcome).toBe("changed");
  });
});
});

describe("focused coordination and durable decisions", () => {
it("separates questions, once-only permissions, checkpoints, lessons and review-guide proposals", async () => {
  return owners.use(async ({ e, c, taskId, offer, inspect }) => {

    for (const kind of ["maintenance-settings", "question", "permission", "learnings", "guide", "screen", "stuck", "driving"] as const) {
      const itemId = offer(kind, "- First useful lesson\n- Second useful lesson"),
        read = await inspect(itemId);
      expect((await c.call("inbox.approve", { itemId, revision: read.revision, requestId: `wrong-${kind}` })).outcome).toBe("invalid");
      expect(e.s.inbox.some((i) => i.id === itemId)).toBe(true);
    }
    const maintTask = e.task(taskId)!;
    const maintenanceRun = {
      routineId: "routine-1",
      routineName: "Nightly audit",
      scheduledAt: 1,
      queuedAt: 1,
      zone: "UTC",
      focus: "Security",
      role: e.s.roles[0]!,
      profile: e.s.profiles[0]!,
      input: "Audit",
      product: e.s.products[0]!,
      settingsDecision: { requested: "high", actual: "medium", at: 1 },
    };
    maintTask.state = "needs-you";
    maintTask.maintenance = maintenanceRun;
    const maint = e.s.inbox.find((i) => i.kind === "maintenance-settings")!;
    const maintRead = await inspect(maint.id);
    expect(maintRead.decisions).toEqual(["inbox.maintenance-settings"]);
    expect(
      (
        await c.call("inbox.maintenance-settings", {
          itemId: maint.id,
          revision: maintRead.revision,
          choice: "keep",
          requestId: "maint-keep",
        })
      ).outcome,
    ).toBe("completed");
    expect(maintTask.maintenance?.settingsDecision?.choice).toBe("keep");
    maintTask.state = "needs-you";
    maintTask.maintenance = { ...maintenanceRun, settingsDecision: { requested: "high", actual: "medium", at: 2 } };
    const appMaint = offer("maintenance-settings");
    e.approve(appMaint);
    expect(maintTask.maintenance?.settingsDecision?.choice).toBe("keep");
    const question = e.s.inbox.find((i) => i.kind === "question")!;
    const qa = { itemId: question.id, revision: requestRevision(e, question), answer: "Blue", requestId: "answer-once" };
    const answered = await c.call("inbox.answer", qa);
    expect(answered.outcome).toBe("completed");
    expect(await c.call("inbox.answer", qa)).toEqual(answered);
    const permission = e.s.inbox.find((i) => i.kind === "permission")!,
      permissionRead = await inspect(permission.id);
    const allow = { itemId: permission.id, revision: permissionRead.revision, requestId: "allow-once" };
    expect((await c.call("inbox.allow", allow)).outcome).toBe("completed");
    expect((await c.call("inbox.allow", allow)).outcome).toBe("completed");
    const learning = e.s.inbox.find((i) => i.kind === "learnings")!,
      read = await inspect(learning.id),
      base = { itemId: learning.id, revision: read.revision };
    expect((await c.call("learning.accept", { ...base, positions: [], requestId: "empty" })).outcome).toBe("invalid");
    expect((await c.call("learning.accept", { ...base, positions: [2], requestId: "outside" })).outcome).toBe("invalid");
    expect(e.s.inbox.some((i) => i.id === learning.id)).toBe(true);
    expect((await c.call("learning.accept", { ...base, positions: [0], requestId: "selected" })).outcome).toBe("completed");
    expect(e.s.products[0]!.learnings).toHaveLength(1);
    expect(e.s.products[0]!.learningsDeclined).toContain("Second useful lesson");
    const guide = e.s.inbox.find((i) => i.kind === "guide")!;
    expect((await c.call("review-guide.accept", { itemId: guide.id, revision: (await inspect(guide.id)).revision, requestId: "guide-yes" })).outcome).toBe(
      "completed",
    );
    // Keep the app's existing review-guide acceptance button working too.
    const appGuide = offer("guide", "Check another nearby case");
    e.approve(appGuide);
    expect(e.s.products[0]!.reviewGuide).toHaveLength(2);
    const declined = offer("learnings", "- A third lesson");
    expect((await c.call("learning.decline", { itemId: declined, revision: (await inspect(declined)).revision, requestId: "declined" })).outcome).toBe(
      "completed",
    );
  });
});
});

it("exposes every saved disagreement objection and its answer through paged inspection and design reads", async () => {
  return owners.use(async ({ e, c, taskId, task }) => {

  task.brief = { summary: "Proposed design", forUsers: [], areas: [], acceptance: [], risks: [] };
  task.objections = [{ id: "objection", round: 1, text: "Blocking objection\n" + "Full available evidence\n".repeat(1000), blocking: true, raisedBy: "sol-xhigh", status: "open", answer: "Recorded answer" }];
  e.s.inbox.push({ id: "disagreement", taskId, kind: "disagreement", title: "Decide the disagreement", body: "Choose how to proceed", at: 1, blocking: false });
  let page = await c.call("inbox.inspect", { itemId: "disagreement" });
  expect(page.shortened).toBe(true);
  const revision = page.revision;
  let full = String(page.text);
  while (page.next) { page = await c.call("inbox.inspect", { itemId: "disagreement", cursor: page.next }); full += page.text; }
  expect(JSON.parse(full).objections).toEqual(task.objections);
  page = await c.call("task.read", { taskId, section: "design" });
  full = String(page.text);
  while (page.next) { page = await c.call("task.read", { taskId, section: "design", cursor: page.next }); full += page.text; }
  expect(JSON.parse(full).objections).toEqual(task.objections);
  task.objections[0]!.answer = "A changed answer";
  expect((await c.call("inbox.approve", { itemId: "disagreement", revision, requestId: "old-evidence" })).outcome).toBe("changed");
  expect(e.s.inbox).toHaveLength(1);
  });
});
