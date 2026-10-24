import { afterAll, expect, it } from "bun:test";
import { join } from "node:path";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { journeyView, MAINTENANCE_ROLES, type InboxKind } from "@petrina/core";
import { Engine } from "./engine.js";
import { executionFor } from "@petrina/orchestrator";
import { Coordination } from "../src/coordination.js";
import { coordinator, Fakes, itemOf, makeProduct, removeDir, tempDir, until } from "./support.js";
import { commandText } from "../src/checks.js";
import { Context } from "../src/context.js";
import type { GuideKeeper } from "../src/guide-keeper.js";

const roots: string[] = [];
afterAll(() => roots.forEach(removeDir));

// Start at round completion: this decision must precede delivery preparation, not replay a whole task.
for (const following of ["gate", "agent"] as const) it(`asks about exhausted review before the following ${following}, and continuing approves no delivery`, async () => {
  const root = tempDir("petrina-review-decision-"); roots.push(root);
  const engine = new Engine(join(root, "data"), { agentCommand: () => undefined, terminals: () => [] });
  engine.schedule = () => {};
  engine.setPoolPaused(true);
  try {
    const repo = await makeProduct(root);
    const productId = await engine.addProduct(repo);
    const task = engine.task(engine.addTask({ productId, title: "A bounded review" }))!;
    const work = executionFor(task).work;
    work.worktree = repo;
    task.plan = { rationale: "Fixture", plannerProfileId: "opus-high", stages: [
      { id: "build", title: "Build", kind: "do", roleId: "builder", profileIds: ["sol-high"] },
      { id: "review", title: "Review", kind: "review-chain", roleId: "code-reviewer", profileIds: ["sol-high"], maxRounds: 1 },
      following === "gate" ? { id: "delivery", title: "Delivery", kind: "gate", gate: "delivery", roleId: "coordinator", profileIds: [] }
        : { id: "test", title: "Test", kind: "do", roleId: "tester", profileIds: ["sol-high"] },
      { id: "ship", title: "Ship", kind: "do", roleId: "release-manager", profileIds: ["sol-high"] },
    ] };
    task.stageIndex = 1; task.rounds = { review: 5 };
    task.findings = [{ id: "bug", text: "Confirmed failure", severity: "blocking", status: "open", raisedBy: "sol-high", confirmedBy: ["opus-high"] }];
    const review = task.plan.stages[1]!;
    const result = await engine["reviews"]["closeReviewRound"](task, review, 5, "1 important");
    expect(result).toBe("stop");
    expect(task.stageIndex).toBe(2);
    // It names the open Important findings it is about; this fixture's copy has no recorded base, so its own change is unreadable.
    expect(task.reviewDecision).toEqual({ stageId: "review", round: 5, accepted: false, covers: ["bug"], at: expect.any(Number), versions: { [productId]: "unavailable" } });
    expect(task.state).toBe("needs-you"); expect(task.agent).toBeUndefined();
    expect(work.checkedSha).toBeUndefined(); expect(work.approvedSha).toBeUndefined();
    const decision = engine.s.inbox.find(item => item.taskId === task.id)!;
    expect(decision.body).toContain("Continuing approves no delivery");
    expect(task.journey!.at(-1)!.work).toBe("review-decision");
    const view = journeyView(engine.taskDetails(task.id)!, { roles: engine.s.roles, profiles: engine.s.profiles, tasks: [], inbox: engine.s.inbox });
    expect(view.nodes.find(node => node.id === task.journey!.at(-1)!.id)!.name).toBe("Your review decision");
    const c = new Coordination(engine);
    const inspected = await c.call("inbox.inspect", { itemId: decision.id });
    expect((await c.call("inbox.approve", { itemId: decision.id, revision: inspected.revision, requestId: "continue-review" })).outcome).toBe("completed");
    expect(task.reviewDecision!.accepted).toBe(true);
    expect(task.stageIndex).toBe(2); expect(task.rounds.review).toBe(5);
    expect(work.approvedSha).toBeUndefined(); expect(work.approvedFor).toBeUndefined();
    expect(task.findings[0]!.status).toBe("open");
    task.risk = { level: "low", why: "Fixture" };
    engine.s.products.find(product => product.id === productId)!.shipLowRisk = true;
    const findings = task.findings;
    task.findings = [];
    expect(engine["driver"]["shipsUnasked"](task)).toBe(false);
    task.findings = findings;
    // The actual delivery approval remains a different decision, after preparation.
    work.checkedSha = "final-code"; work.checkedPatch = "final-patch";
    task.stageIndex = 2;
    engine.gate(task, "delivery");
    const final = engine.s.inbox.find(item => item.taskId === task.id)!;
    expect(final.id).not.toBe(decision.id);
    expect(task.journey!.at(-1)!.work).not.toBe("review-decision");
    engine.approve(final.id);
    expect(work.approvedSha).toBe("final-code");
  } finally { await engine.shutdown(); }
});

it("keeps the early decision through restart, then runs changed checks and acceptance before a separate approval", async () => {
  const root = tempDir("petrina-review-final-verification-"); roots.push(root);
  const fakes = new Fakes(join(root, "fake"));
  fakes.scenario({ planner: "tester-after", builder: "plain", reviewer: "important" });
  const options = { agentCommand: () => [process.execPath, join(import.meta.dir, "fake-agent.ts"), fakes.dir] };
  let engine = new Engine(join(root, "data"), options);
  const log = join(root, "check-runs");
  const check = join(root, "check.ts");
  writeFileSync(check, `import { appendFileSync } from "node:fs"; appendFileSync(process.argv[2], process.argv[3] + "\\n");`);
  const definitions = (name: string) => [{ name: "Tests", command: commandText([process.execPath, check, log, name]) }];
  try {
    const productId = await engine.addProduct(await makeProduct(root));
    engine.setProductDelivery(productId, "local", true);
    engine.setProductChecks(productId, definitions("before decision"));
    const id = engine.addTask({ productId, title: "A reviewed greeting", description: "[no-check]" });
    const first = await until(engine, state => !!itemOf(state, id, "delivery"), coordinator(["plan"]));
    const item = itemOf(first, id, "delivery")!;
    expect(engine.task(id)!.reviewDecision?.accepted).toBe(false);
    expect(fakes.openings("tester")).toHaveLength(0);
    expect(readFileSync(log, "utf8")).toBe("before decision\n");
    engine.setPoolPaused(true);
    await engine.shutdown();
    engine = new Engine(join(root, "data"), options);
    expect(engine.task(id)!.reviewDecision?.accepted).toBe(false);
    expect(engine.s.inbox.find(entry => entry.id === item.id)).toBeDefined();
    engine.setProductChecks(productId, definitions("after decision"));
    appendFileSync(log, "decision\n");
    engine.approve(item.id);
    expect(executionFor(engine.task(id)!).work.approvedSha).toBeUndefined();
    engine.setPoolPaused(false);
    const final = await until(engine, state => !!itemOf(state, id, "delivery"));
    expect(itemOf(final, id, "delivery")!.id).not.toBe(item.id);
    expect(readFileSync(log, "utf8")).toBe("before decision\ndecision\nafter decision\n");
    expect(fakes.openings("tester")).toHaveLength(1);
    expect(engine.task(id)!.acceptancePassed).toBe(true);
    expect(engine.task(id)!.findings.some(finding => finding.severity === "blocking" && finding.status === "open")).toBe(true);
    expect(executionFor(engine.task(id)!).work.approvedSha).toBeUndefined();
    engine.requestChanges(itemOf(final, id, "delivery")!.id, "Repair the confirmed defect and review it again");
    engine.setPoolPaused(true);
    expect(engine.task(id)!.reviewDecision).toBeUndefined();
    expect(engine.task(id)!.fixing).toBe(true);
    expect(engine.task(id)!.plan!.stages[engine.task(id)!.stageIndex]!.roleId).toBe("builder");
  } finally { await engine.shutdown(); }
});

it("records a change request at the review decision it answers, beside ordinary checkpoint and live-note origins", async () => {
  const root = tempDir("petrina-review-decision-origin-"); roots.push(root);
  const engine = new Engine(join(root, "data"), { agentCommand: () => undefined, terminals: () => [] });
  engine.schedule = () => {};
  engine.setPoolPaused(true);
  const guide = { pendingPoints: async () => [] } as unknown as GuideKeeper;
  type Task = NonNullable<ReturnType<Engine["task"]>>;
  const notesFor = async (task: Task, roleId: string) => (await new Context(engine, guide).sectionsFor(executionFor(task), roleId)).find((section) => section.title.startsWith("The coordinator's notes"))!.background;
  const offer = (task: Task, kind: InboxKind) => {
    const id = engine.id("inbox");
    engine.s.inbox.push({ id, kind, taskId: task.id, title: `A ${kind} check`, at: Date.now(), blocking: false });
    return id;
  };
  try {
    const repo = await makeProduct(root);
    const productId = await engine.addProduct(repo);
    const task = engine.task(engine.addTask({ productId, title: "A bounded review" }))!;
    executionFor(task).work.worktree = repo;
    task.plan = { rationale: "Fixture", plannerProfileId: "opus-high", stages: [
      { id: "build", title: "Build", kind: "do", roleId: "builder", profileIds: ["sol-high"] },
      { id: "review", title: "Independent review", kind: "review-chain", roleId: "code-reviewer", profileIds: ["sol-high"], maxRounds: 1 },
      { id: "security", title: "Security review", kind: "review-chain", roleId: "security-reviewer", profileIds: ["sol-high"], maxRounds: 1 },
      { id: "delivery", title: "Your delivery check", kind: "gate", gate: "delivery", roleId: "release-manager", profileIds: [] },
      { id: "ship", title: "Ship", kind: "do", roleId: "release-manager", profileIds: ["sol-high"] },
    ] };
    task.stageIndex = 1; task.rounds = { review: 5 };
    task.findings = [{ id: "bug", text: "Confirmed failure", severity: "blocking", status: "open", raisedBy: "sol-high", confirmedBy: ["opus-high"] }];
    expect(await engine["reviews"]["closeReviewRound"](task, task.plan.stages[1]!, 5, "1 important")).toBe("stop");
    // The flow already stands at the next stage, which has not run.
    expect(task.plan.stages[task.stageIndex]!.id).toBe("security");
    const decision = engine.s.inbox.find((item) => item.taskId === task.id)!;
    expect(decision.stageId).toBe("review");
    // A decision raised before checks recorded their stage: the pending review decision still names it.
    delete decision.stageId;
    engine.requestChanges(decision.id, "Repair the confirmed failure");
    const note = task.notes!.at(-1)!;
    expect(note.origin).toEqual({ stageId: "review", stageTitle: "Independent review", roleName: "Code reviewer", kind: "delivery" });
    expect(task.queued.at(-1)).toEqual(expect.objectContaining({ id: note.id, text: "Repair the confirmed failure" }));
    expect(task.stepNotes!.at(-1)).toEqual(expect.objectContaining({ id: note.id, kind: "changes", text: "Repair the confirmed failure" }));
    // The Builder it returns to hears it as the review's note.
    expect(task.plan.stages[task.stageIndex]!.roleId).toBe("builder");
    expect(await notesFor(task, "builder")).toContain("Recorded during “Independent review” (Code reviewer):\nRepair the confirmed failure");
    expect(await notesFor(task, "builder")).not.toContain("Security review");

    // Controls: a live note names the step at work; an ordinary delivery check names its own stage.
    task.agent = { roleId: "builder", profileId: "sol-high", since: Date.now(), step: 0 };
    engine.sendMessage(task.id, "Keep the old page");
    expect(task.notes!.at(-1)!.origin).toEqual({ stageId: "build", stageTitle: "Build", roleName: "Builder" });
    delete task.agent;
    task.stageIndex = 3;
    engine.gate(task, "delivery");
    engine.requestChanges(engine.s.inbox.find((item) => item.taskId === task.id && item.kind === "delivery")!.id, "Shorten the summary");
    expect(task.notes!.at(-1)!.origin).toEqual({ stageId: "delivery", stageTitle: "Your delivery check", roleName: "Release Manager", kind: "delivery" });
    expect(task.notes!.map((entry) => entry.text)).toEqual(["Repair the confirmed failure", "Keep the old page", "Shorten the summary"]);
    engine.commitNow();
    expect(engine.store.loadActive()!.tasks.find((entry) => entry.id === task.id)!.notes).toEqual(task.notes);

    // A design check, a task-owned role and planning keep their own origins.
    const other = engine.task(engine.addTask({ productId, title: "A designed routine" }))!;
    other.plan = { rationale: "Fixture", plannerProfileId: "opus-high", stages: [
      { id: "design", title: "Design it", kind: "converge", roleId: "architect", profileIds: ["sol-high"], reviewerRoleId: "design-reviewer", reviewerProfileIds: ["sol-high"] },
      { id: "design-check", title: "Your design check", kind: "gate", gate: "design", roleId: "architect", profileIds: [] },
      { id: "care", title: "Look after it", kind: "do", roleId: "saved-caretaker", profileIds: ["sol-high"] },
    ] };
    other.stageIndex = 1;
    engine.requestChanges(offer(other, "design"), "Name the fallback");
    expect(other.notes!.at(-1)!.origin).toEqual({ stageId: "design-check", stageTitle: "Your design check", roleName: "Architect", kind: "design" });
    other.maintenance = { routineId: "daily", routineName: "Daily", scheduledAt: 1, queuedAt: 1, zone: "UTC", focus: "Care", input: "Care", role: { ...MAINTENANCE_ROLES.find((role) => role.result === "build")!, id: "saved-caretaker", name: "Saved caretaker" }, profile: engine.profile("opus-high")!, product: engine.s.products[0]! };
    other.stageIndex = 2;
    engine.sendMessage(other.id, "Only the greeting");
    expect(other.notes!.at(-1)!.origin).toEqual({ stageId: "care", stageTitle: "Look after it", roleName: "Saved caretaker" });
    other.stageIndex = -1;
    engine.requestChanges(offer(other, "plan"), "Plan one product only");
    expect(other.notes!.at(-1)!.origin).toEqual({ stageTitle: other.startedAt === undefined ? "Before work started" : "Planning", kind: "plan" });
    // A decided stage missing from the plan stays unrecorded rather than renamed.
    engine.remember(other, "An unplaced decision", "unplaced", "delivery", "removed-stage");
    expect(other.notes!.at(-1)).toEqual({ at: expect.any(Number), text: "An unplaced decision", id: "unplaced" });
  } finally { await engine.shutdown(); }
});

it("keeps a review decision's stage for notes while it waits and on the same check raised again for shared products", async () => {
  const root = tempDir("petrina-review-decision-raised-again-"); roots.push(root);
  const engine = new Engine(join(root, "data"), { agentCommand: () => undefined, terminals: () => [] });
  engine.schedule = () => {};
  engine.setPoolPaused(true);
  try {
    const shop = await engine.addProduct(await makeProduct(join(root, "shop"))), api = await engine.addProduct(await makeProduct(join(root, "api")), "API");
    const task = engine.task(engine.addTask({ productId: shop, title: "A shared review" }))!;
    task.repositories = [shop, api].map((productId) => ({ productId, delivery: "pull-request" as const, completedStages: [] }));
    // The product owning the remaining finding is already published, so no Builder can take it.
    task.repositories[1]!.landed = { branch: "main", sha: "published" };
    task.plan = { rationale: "Fixture", plannerProfileId: "opus-high", stages: [
      { id: "build", title: "Build", kind: "do", roleId: "builder", profileIds: ["sol-high"] },
      { id: "review", title: "Independent review", kind: "review-chain", roleId: "code-reviewer", profileIds: ["sol-high"], maxRounds: 1 },
      { id: "security", title: "Security review", kind: "review-chain", roleId: "security-reviewer", profileIds: ["sol-high"], maxRounds: 1 },
      { id: "delivery", title: "Your delivery check", kind: "gate", gate: "delivery", roleId: "release-manager", profileIds: [] },
    ] };
    task.stageIndex = 1; task.rounds = { review: 5 };
    task.findings = [{ id: "bug", text: "The API drops the greeting", productIds: [api], severity: "blocking", status: "open", raisedBy: "sol-high", confirmedBy: ["opus-high"] }];
    expect(await engine["reviews"]["closeReviewRound"](task, task.plan.stages[1]!, 5, "1 important")).toBe("stop");
    const review = { stageId: "review", stageTitle: "Independent review", roleName: "Code reviewer" };
    const latest = () => task.notes!.at(-1)!.origin;
    const waiting = () => engine.s.inbox.filter((item) => item.taskId === task.id && item.kind === "delivery");
    // A plain message while the decision waits belongs to the review, not the security review that has not run.
    engine.sendMessage(task.id, "Also check the sign-out path");
    expect(latest()).toEqual(review);
    const decision = waiting()[0]!;
    engine.requestChanges(decision.id, "Repair the API greeting");
    expect(latest()).toEqual({ ...review, kind: "delivery" });
    // Nobody can take the finding: the same check is raised again at the next stage, without a review decision.
    expect(task.reviewDecision).toBeUndefined();
    expect(task.plan.stages[task.stageIndex]!.id).toBe("security");
    const again = waiting();
    expect(again).toHaveLength(1);
    expect(again[0]!.id).not.toBe(decision.id);
    expect(again[0]!.stageId).toBe("review");
    engine.sendMessage(task.id, "Leave the shop unchanged");
    expect(latest()).toEqual(review);
    engine.requestChanges(again[0]!.id, "Try the API repair once more");
    expect(latest()).toEqual({ ...review, kind: "delivery" });
    // Routing is unchanged: the check stands at the same stage again, still deciding the review, through a restart.
    expect(task.plan.stages[task.stageIndex]!.id).toBe("security");
    expect(waiting().map((item) => item.stageId)).toEqual(["review"]);
    engine.commitNow();
    expect(engine.store.loadActive()!.inbox.find((item) => item.id === waiting()[0]!.id)!.stageId).toBe("review");
    expect(task.notes!.map((note) => note.text)).toEqual(["Also check the sign-out path", "Repair the API greeting", "Leave the shop unchanged", "Try the API repair once more"]);
    expect(task.queued.map((message) => message.text)).toEqual(task.notes!.map((note) => note.text));
  } finally { await engine.shutdown(); }
});

it("leaves a note's origin unrecorded when an older check raised again recorded no stage, beside recorded and delivery-stage controls", async () => {
  const root = tempDir("petrina-review-decision-unknown-origin-"); roots.push(root);
  const engine = new Engine(join(root, "data"), { agentCommand: () => undefined, terminals: () => [] });
  engine.schedule = () => {};
  engine.setPoolPaused(true);
  try {
    const shop = await engine.addProduct(await makeProduct(join(root, "shop"))), api = await engine.addProduct(await makeProduct(join(root, "api")), "API");
    const task = engine.task(engine.addTask({ productId: shop, title: "An older shared review" }))!;
    task.repositories = [shop, api].map((productId) => ({ productId, delivery: "pull-request" as const, completedStages: [] }));
    task.repositories[1]!.landed = { branch: "main", sha: "published" };
    task.plan = { rationale: "Fixture", plannerProfileId: "opus-high", stages: [
      { id: "build", title: "Build", kind: "do", roleId: "builder", profileIds: ["sol-high"] },
      { id: "review", title: "Independent review", kind: "review-chain", roleId: "code-reviewer", profileIds: ["sol-high"], maxRounds: 1 },
      { id: "test", title: "Check every acceptance item", kind: "do", roleId: "tester", profileIds: ["sol-high"] },
      { id: "security", title: "Security review", kind: "review-chain", roleId: "security-reviewer", profileIds: ["sol-high"], maxRounds: 1 },
      { id: "delivery", title: "Your delivery check", kind: "gate", gate: "delivery", roleId: "release-manager", profileIds: [] },
    ] };
    task.findings = [{ id: "bug", text: "The API drops the greeting", productIds: [api], severity: "blocking", status: "open", raisedBy: "sol-high", confirmedBy: ["opus-high"] }];
    const waiting = () => engine.s.inbox.filter((item) => item.taskId === task.id && item.kind === "delivery");
    const latest = () => task.notes!.at(-1)!;
    // An older engine raised this check again after its review decision: neither the check nor the task records the review.
    task.stageIndex = 3;
    engine.gate(task, "delivery");
    delete waiting()[0]!.stageId;
    expect(task.reviewDecision).toBeUndefined();
    engine.sendMessage(task.id, "Also check the sign-out path");
    expect(latest().origin).toBeUndefined();
    engine.requestChanges(waiting()[0]!.id, "Repair the API greeting");
    expect(latest()).toEqual(expect.objectContaining({ text: "Repair the API greeting", id: expect.any(String) }));
    expect(latest().origin).toBeUndefined();
    // Raised again, it keeps saying its stage is unknown rather than the Security review the flow stands at.
    expect(task.plan.stages[task.stageIndex]!.id).toBe("security");
    expect(waiting().map((item) => item.stageId)).toEqual([null]);
    engine.sendMessage(task.id, "Leave the shop unchanged");
    expect(latest().origin).toBeUndefined();
    const guide = { pendingPoints: async () => [] } as unknown as GuideKeeper;
    const notes = (await new Context(engine, guide).sectionsFor(executionFor(task), "builder")).find((section) => section.title.startsWith("The coordinator's notes"))!.background;
    expect(notes).toContain("Earlier note (original step not recorded):\nRepair the API greeting");
    expect(notes).not.toContain("Security review");
    expect(task.queued.map((message) => message.text)).toEqual(task.notes!.map((note) => note.text));

    // Controls: a new check problem records the stage it stopped at; an older check at the delivery check names it.
    engine.takeItem(waiting()[0]!.id);
    task.stageIndex = 2;
    engine.gate(task, "delivery", "Checks failed while testing");
    expect(waiting().map((item) => item.stageId)).toEqual(["test"]);
    engine.sendMessage(task.id, "Look at the failing check first");
    expect(latest().origin).toEqual({ stageId: "test", stageTitle: "Check every acceptance item", roleName: "Tester" });
    engine.takeItem(waiting()[0]!.id);
    task.stageIndex = 4;
    engine.gate(task, "delivery");
    delete waiting()[0]!.stageId;
    engine.sendMessage(task.id, "Ship it after one more look");
    expect(latest().origin).toEqual({ stageId: "delivery", stageTitle: "Your delivery check", roleName: "Release Manager" });
  } finally { await engine.shutdown(); }
});
