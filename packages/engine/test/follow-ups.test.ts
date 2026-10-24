import { executionFor } from "../src/repository-context.js";
import { afterAll, expect, it, spyOn } from "bun:test";
import * as fileIO from "node:fs/promises";
import { chmodSync, existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { followUpKey, type DeepMutable, type Finding, type MatchAnswer } from "@petrina/core";
import { Engine } from "./engine.js";
import { ReviewResult } from "../src/roles.js";
import { checkReviewEvidence } from "../src/review.js";
import { Coordination } from "../src/coordination.js";
import { coordinationCli } from "../src/coordination-cli.js";
import { mcpRequest, mcpTools } from "../src/mcp.js";
import type { EngineClient } from "./client.js";
import { dispatch } from "../src/server.js";
import * as gitOps from "../src/git.js";
import { Fakes, makeProduct, removeDir, tempDir, waitFor } from "./fixtures.js";

const roots: string[] = [];
afterAll(() => roots.forEach(removeDir));

const STEPS = "Open the page and choose About.";
const EVIDENCE = "The same retired page opened on the previous version.";
const STAGE = { id: "review", kind: "review-chain" as const, title: "Review", roleId: "code-reviewer", profileIds: ["opus-high", "sol-high"], maxRounds: 2 };

function older(id: string, text: string, extra: Partial<Finding> = {}): DeepMutable<Finding> {
  return {
    id,
    text,
    severity: "pre-existing",
    status: "open",
    raisedBy: "opus-high",
    roleId: "code-reviewer",
    confirmedBy: [],
    steps: STEPS,
    evidence: EVIDENCE,
    ...extra,
  } as DeepMutable<Finding>;
}

function keysOf(prompt: string): string[] {
  return [...prompt.matchAll(/^- Report \[([^\]]+)\]/gm)].map((match) => match[1]!);
}

/** Reports that name the same bug share one card. A card is used only while it is still open. */
function groupByBug(prompt: string): MatchAnswer {
  const reports = [...prompt.matchAll(/^- Report \[([^\]]+)\]\n  Problem: (.*)$/gm)];
  const cards = [...prompt.matchAll(/^- Card \[([^\]]+)\]: (.*)$/gm)];
  const bugOf = (text: string) => /^bug-([a-z0-9]+)/.exec(text)?.[1];
  const grouped = new Map<string, string[]>();
  for (const match of reports) {
    const bug = bugOf(match[2] ?? "");
    if (!bug) continue;
    grouped.set(bug, [...(grouped.get(bug) ?? []), match[1]!]);
  }
  return {
    groups: [...grouped].map(([bug, keys]) => {
      const card = cards.find((entry) => bugOf(entry[2] ?? "") === bug);
      return card ? { keys, cardId: card[1]! } : { keys };
    }),
  };
}

interface World {
  engine: Engine;
  data: string;
  root: string;
  shop: string;
  notes: string;
  prompts: string[];
  answer: (prompt: string) => MatchAnswer | Promise<MatchAnswer>;
}

async function open(answer: World["answer"] = groupByBug, withNotes = false): Promise<World> {
  const root = tempDir("petrina-follow-up-");
  roots.push(root);
  const fakes = new Fakes(join(root, "agents"));
  const prompts: string[] = [];
  const data = join(root, "data");
  const options = {
    agentCommand: () => [process.execPath, join(import.meta.dir, "fake-agent.ts"), fakes.dir] as const,
    matchFollowUps: async (prompt: string) => {
      prompts.push(prompt);
      return answer(prompt);
    },
  };
  const engine = new Engine(data, options);
  engine.setPoolPaused(true);
  await engine.waitUntilReady();
  await engine["followUps"].catchUp();
  await Promise.all([...engine.backgroundWork]);
  const shop = await engine.addProduct(await makeProduct(root), "Shop");
  const notes = withNotes ? await engine.addProduct(await makeProduct(join(root, "other")), "Notes") : "";
  const world: World = { engine, data, root, shop, notes, prompts, answer };
  return world;
}

async function reopen(world: World, match = true): Promise<void> {
  await world.engine.shutdown();
  world.engine = new Engine(world.data, {
    agentCommand: () => [process.execPath, join(import.meta.dir, "fake-agent.ts"), join(world.root, "agents")],
    ...(match ? { matchFollowUps: async (prompt: string) => { world.prompts.push(prompt); return world.answer(prompt); } } : {}),
  });
  world.engine.setPoolPaused(true);
  await world.engine.waitUntilReady();
  await world.engine["followUps"].catchUp();
  await Promise.all([...world.engine.backgroundWork]);
}

function taskOf(engine: Engine, productId: string, title: string, findings: DeepMutable<Finding>[]) {
  const id = engine.addTask({ productId, title, description: "Look at an older bug", backlog: true });
  const task = engine.task(id)!;
  task.findings = findings;
  task.rounds = { review: 1 };
  return task;
}

async function finish(engine: Engine, task: ReturnType<Engine["task"]> & object): Promise<void> {
  task.state = "done";
  task.column = "done";
  task.finishedAt = Date.now();
  await engine["followUps"].noteDone(task);
}

function cards(engine: Engine) {
  return engine.s.tasks.filter((task) => task.followUp);
}

it("reuses a coordinator's Backlog bug with current wording, preserving its request, products and links through restart", async () => {
  const world = await open(groupByBug, true);
  try {
    const engine = world.engine;
    const id = engine.addTask({ productId: world.shop, kind: "bug", title: "bug-manual: Fix the remaining variant", description: "Current request, edited by the coordinator.", backlog: true });
    const manual = engine.task(id)!;
    const unrelated = engine.addTask({ productId: world.notes, kind: "bug", title: "bug-manual: Separate product", description: "Another scope", backlog: true });
    const feature = engine.addTask({ productId: world.shop, title: "bug-manual: A feature", description: "Do not turn features into bug follow-ups", backlog: true });
    const source = taskOf(engine, world.shop, "Report the remaining issue", [older("remaining", "bug-manual: A confirmed current defect")]);
    await finish(engine, source);
    expect(source.findings[0]!.tracking).toEqual({ taskId: id });
    expect(manual.followUp?.preserveRequest).toBe(true);
    expect(manual.description).toBe("Current request, edited by the coordinator.");
    expect(manual.followUp?.reports).toHaveLength(1);
    expect(manual.state).toBe("backlog");
    expect(engine.task(unrelated)!.followUp).toBeUndefined();
    expect(engine.task(feature)!.followUp).toBeUndefined();
    expect(world.prompts[0]).toContain("Current request, edited by the coordinator.");
    await reopen(world);
    expect(world.engine.task(id)!.followUp?.reports).toHaveLength(1);
    // A withdrawn source credit cannot rewrite a coordinator-created request or its products.
    const loaded = world.engine.task(source.id)!;
    loaded.findings[0]!.status = "fixed";
    world.engine.saveArchivedTask(loaded);
    world.engine.s.followUpPending = [{ keys: [followUpKey(source.id, "remaining")], cardId: id }];
    await world.engine["followUps"].catchUp();
    expect(world.engine.task(id)!.description).toBe("Current request, edited by the coordinator.");
    expect(world.engine.task(id)!.productId).toBe(world.shop);
    expect(world.engine.task(id)!.followUp?.reports).toHaveLength(0);
  } finally { await world.engine.shutdown(); }
});

it("settles an incidental older-bug repair only from current explicit proof, retaining unknown and contested reports", async () => {
  const world = await open();
  try {
    const engine = world.engine;
    const task = taskOf(engine, world.shop, "Incidental repair", [older("fixed", "bug-fixed: A repaired bug"), older("unknown", "bug-unknown: Not checked"), older("contested", "bug-contested: Still broken")]);
    task.plan = { rationale: "Review current evidence", plannerProfileId: "sol-high", stages: [STAGE] }; task.stageIndex = 0;
    const work = executionFor(task).work;
    work.worktree = engine.productOf(task)!.path!;
    work.baseSha = await gitOps.head(work.worktree);
    work.base = "main";
    task.hunt = { stageId: STAGE.id, round: 1, reported: {}, findings: 3 };
    await engine["reviews"]["input"](task, new AbortController().signal);
    const evidence = "Repeated the exact original reproduction on the current commit; About now opens the current page, and the neighbouring Home control still passes.";
    const resolved = ReviewResult.parse({ verdict: "pass", findings: [{ text: "bug-remaining: A distinct remaining variant", severity: "pre-existing", steps: STEPS, evidence: EVIDENCE }], resolves: [{ id: "fixed", evidence }, { id: "contested", evidence }] });
    expect(checkReviewEvidence(task.findings, resolved)).toBeUndefined();
    expect(checkReviewEvidence(task.findings, ReviewResult.parse({ verdict: "pass", resolves: [{ id: "not-shown", evidence }] }))).toContain("not shown");
    expect(checkReviewEvidence(task.findings, ReviewResult.parse({ verdict: "pass", resolves: [{ id: "fixed", evidence }], confirms: ["fixed"] }))).toContain("without also");
    await engine["reviews"]["applyReview"](executionFor(task), STAGE, resolved, "opus-high", "code-reviewer", "0");
    task.hunt.reported["0"] = true;
    engine["reviews"]["settleReviews"](task, STAGE);
    expect(task.findings[0]!.status).toBe("open"); // The blind peer has not finished.
    await engine["reviews"]["applyReview"](executionFor(task), STAGE, ReviewResult.parse({ verdict: "pass", confirms: [{ id: "contested", evidence: "Current reproduction still fails for the other account." }] }), "sol-high", "code-reviewer", "1");
    task.hunt.reported["1"] = true;
    const input = task.hunt.input;
    delete task.hunt.input;
    engine["reviews"]["settleReviews"](task, STAGE);
    expect(task.findings[0]!.status).toBe("open"); // No code binding is not proof.
    task.hunt.input = input;
    engine["reviews"]["settleReviews"](task, STAGE);
    expect(task.findings.map(finding => finding.status)).toEqual(["fixed", "open", "open", "open"]);
    expect(task.findings[0]!.resolution).toMatchObject({ by: "opus-high", evidence, versions: { [world.shop]: work.baseSha } });
    await finish(engine, task);
    expect(task.findings[0]!.tracking).toBeUndefined();
    expect(task.findings[1]!.tracking).toHaveProperty("taskId");
    expect(task.findings[2]!.tracking).toHaveProperty("taskId");
    expect(cardFor(engine, "remaining")[0]!.title).toBe("bug-remaining: A distinct remaining variant");
    // A later current reproduction reopens the original identity and retains its repair proof as history.
    task.hunt = { stageId: STAGE.id, round: 2, reported: {}, findings: 3 };
    await engine["reviews"]["applyReview"](executionFor(task), STAGE, ReviewResult.parse({ verdict: "fail", confirms: [{ id: "fixed", evidence: "The exact reproduction fails again on a later commit." }] }), "sol-high", "code-reviewer", "1");
    expect(task.findings[0]!.status).toBe("open");
    expect(task.findings[0]!.resolution).toBeUndefined();
    expect(task.findings[0]!.earlierReviews?.at(-1)?.resolution?.evidence).toBe(evidence);
  } finally { await world.engine.shutdown(); }
});

it("keeps a manual bug queued while matching as the destination, without changing its request", async () => {
  let queue = () => {};
  const world = await open(prompt => { queue(); return groupByBug(prompt); });
  try {
    const engine = world.engine;
    const id = engine.addTask({ productId: world.shop, kind: "bug", title: "bug-race: Existing manual bug", description: "Do not change this queued request", backlog: true });
    queue = () => { queue = () => {}; engine.queueTask(id); };
    const source = taskOf(engine, world.shop, "New sighting", [older("race", "bug-race: The same underlying bug")]);
    await finish(engine, source);
    const manual = engine.task(id)!;
    expect(manual.state).toBe("queued");
    expect(manual.followUp).toMatchObject({ preserveRequest: true, reports: [{ taskId: source.id, findingId: "race" }] });
    expect(manual.description).toBe("Do not change this queued request");
    expect(source.findings[0]!.tracking).toEqual({ taskId: id });
    expect(cards(engine).map(task => task.id)).toEqual([id]);
  } finally { await world.engine.shutdown(); }
});

it("reuses an already queued manual bug and a running one held mid-turn, leaving their live work and other requests alone", async () => {
  let mode: "down" | "same" = "down";
  const world = await open(prompt => mode === "down" ? "unavailable" : groupByBug(prompt), true);
  const { engine } = world;
  const fakes = new Fakes(join(world.root, "agents"));
  fakes.scenario({ controlled: true });
  try {
    // Requests with the same words that are not candidates: another product, a feature, finished and cancelled work.
    const controls = [
      engine.addTask({ productId: world.notes, kind: "bug", title: "bug-running: The same words on Notes", backlog: true }),
      engine.addTask({ productId: world.shop, title: "bug-running: A feature with the same words", backlog: true }),
      engine.addTask({ productId: world.shop, kind: "bug", title: "bug-queued: A finished earlier fix", backlog: true }),
      engine.addTask({ productId: world.shop, kind: "bug", title: "bug-queued: A cancelled request", backlog: true }),
    ];
    const holds = controls.slice(2).map(id => engine.holdFollowUp(id));
    Object.assign(engine.task(controls[2]!)!, { state: "done", column: "done", finishedAt: Date.now() });
    engine.cancel(controls[3]!);
    const runningId = engine.addTask({ productId: world.shop, kind: "bug", title: "bug-running: Keep the publication check", description: "The coordinator's running request", backlog: true });
    engine.queueTask(runningId);
    engine.setPoolPaused(false);
    // A recorded prompt precedes the agent's plan notification. Snapshot only after the engine
    // consumed that notification, so ordinary in-flight activity cannot be mistaken for a follow-up edit.
    await waitFor(() => fakes.received().length === 1 && engine.task(runningId)!.state === "running" && engine.task(runningId)!.agent?.roleId === "planner" && engine.task(runningId)!.todo === "planner is working", "the coordinator's fix and its recorded plan to hold mid-turn");
    engine.setPoolPaused(true);
    const queuedId = engine.addTask({ productId: world.shop, kind: "bug", title: "bug-queued: Keep planned reviews", description: "The coordinator's queued request", backlog: true });
    engine.queueTask(queuedId);
    const running = engine.task(runningId)!;
    const queued = engine.task(queuedId)!;
    const live = (task: typeof running) => structuredClone({ title: task.title, description: task.description, state: task.state, products: task.selectedProducts, plan: task.plan, stage: task.stageIndex, agent: task.agent, approvals: [task.approvePlan, task.approveDelivery], priority: task.priority, journey: task.journey?.map(step => step.id), rounds: task.rounds, timeline: task.timeline.length, session: task.session.map(line => line.id) });
    const before = { running: live(running), queued: live(queued), driver: engine.drivers.get(runningId), prompts: fakes.received().length };
    const source = taskOf(engine, world.shop, "A later finished task", [
      older("queued", "bug-queued: Publication skips the planned review"),
      older("running", "bug-running: The publication check is skipped after repairs run out"),
      older("fresh", "bug-fresh: An unrelated older bug"),
      older("unsure", "Possibly the same publication problem"),
    ]);
    plant(engine, source.id, source.findings[1]!.text);
    await finish(engine, source);
    // Matching needs a free agent slot. Until it can run, nothing is linked, even though the fix is already active.
    const findings = () => engine.task(source.id)!.findings;
    expect(findings().map(finding => finding.tracking)).toEqual(Array(4).fill({ reason: "unavailable", retry: true }));
    expect([running.followUp, queued.followUp, cards(engine)]).toEqual([undefined, undefined, []]);
    mode = "same";
    await engine["followUps"].catchUp();
    const fresh = cardFor(engine, "fresh");
    expect(findings().map(finding => finding.tracking)).toEqual([{ taskId: queuedId }, { taskId: runningId }, { taskId: fresh[0]!.id }, { reason: "unmatched" }]);
    expect(cards(engine).map(task => task.id).sort()).toEqual([queuedId, runningId, fresh[0]!.id].sort());
    for (const control of controls) {
      expect(engine.task(control)!.followUp).toBeUndefined();
      expect(world.prompts.some(prompt => prompt.includes(`Card [${control}]`))).toBe(false);
    }
    expect(world.prompts.at(-1)).toContain("The coordinator's running request");
    // Only the report credit and its picture are added. The request, plan, stage, agent and queue place stay.
    expect(running.followUp).toMatchObject({ preserveRequest: true, reports: [{ taskId: source.id, findingId: "running", text: source.findings[1]!.text, steps: STEPS, evidence: EVIDENCE }] });
    expect(queued.followUp).toMatchObject({ preserveRequest: true, reports: [{ taskId: source.id, findingId: "queued" }] });
    const added = running.session.filter(line => !before.running.session.includes(line.id));
    expect(added.map(line => [line.from, line.text, line.images?.map(image => image.from)])).toEqual([["system", "Kept from the original report", [{ taskId: source.id, imageId: "pic" }]]]);
    expect(live(running)).toEqual({ ...before.running, session: running.session.map(line => line.id) });
    expect(live(queued)).toEqual(before.queued);
    expect(engine.drivers.get(runningId)).toBe(before.driver);
    expect(fakes.received()).toHaveLength(before.prompts);
    expect(fakes.marked(`release-${fakes.received()[0]!.session}`)).toBe(false);
    // Matching again finds every link already saved: no extra credit, picture or question.
    const asked = world.prompts.length;
    await engine["followUps"].catchUp();
    expect([world.prompts.length, running.followUp!.reports.length, queued.followUp!.reports.length, running.session.length, cards(engine).length]).toEqual([asked, 1, 1, before.running.session.length + 1, 3]);
    holds.forEach(release => release());
  } finally { await world.engine.shutdown(); }
});

it("leaves a manual fix untouched and opens a card when it finishes, is cancelled, changes products or leaves the board during matching", async () => {
  let during = () => {};
  const world = await open(prompt => { during(); during = () => {}; return groupByBug(prompt); }, true);
  const { engine } = world;
  try {
    for (const variant of ["finish", "cancel", "scope", "gone"] as const) {
      const fixId = engine.addTask({ productId: world.shop, kind: "bug", title: `bug-${variant}: The coordinator's fix`, description: "The unchanged request", backlog: true });
      engine.queueTask(fixId);
      const fix = engine.task(fixId)!;
      const release = variant === "gone" ? () => {} : engine.holdFollowUp(fixId);
      during = () => {
        if (variant === "finish" || variant === "gone") Object.assign(fix, { state: "done", column: "done", finishedAt: Date.now() });
        if (variant === "gone") engine.save();
        if (variant === "cancel") engine.cancel(fixId);
        if (variant === "scope") fix.selectedProducts = [...fix.selectedProducts!, { productId: world.notes, startFrom: { kind: "default" }, delivery: "pull-request" }];
      };
      const before = structuredClone({ title: fix.title, description: fix.description, products: fix.selectedProducts });
      const source = taskOf(engine, world.shop, `Matched while the fix ${variant}`, [older("old", `bug-${variant}: A later sighting`)]);
      await finish(engine, source);
      expect(world.prompts.at(-1), variant).toContain(`Card [${fixId}]`);
      expect(engine.s.tasks.some(task => task.id === fixId), variant).toBe(variant !== "gone");
      const after = engine.task(fixId)!;
      expect([after.followUp, after.title, after.description], variant).toEqual([undefined, before.title, before.description]);
      const opened = cardFor(engine, variant).filter(task => task.id !== fixId);
      expect(opened.map(task => task.followUp!.reports.map(report => report.findingId)), variant).toEqual([["old"]]);
      expect(opened[0]!.state, variant).toBe("backlog");
      expect(source.findings[0]!.tracking, variant).toEqual({ taskId: opened[0]!.id });
      release();
    }
  } finally { await world.engine.shutdown(); }
});

it("leaves an unfinished task's report waiting when the fix it matched finishes during matching, then places it once that task is done", async () => {
  let during = () => {};
  const world = await open(prompt => { during(); during = () => {}; return groupByBug(prompt); });
  const { engine } = world;
  try {
    const fixId = engine.addTask({ productId: world.shop, kind: "bug", title: "bug-early: The coordinator's fix", backlog: true });
    engine.queueTask(fixId);
    const fix = engine.task(fixId)!;
    const release = engine.holdFollowUp(fixId);
    const running = taskOf(engine, world.shop, "Still running", [older("early", "bug-early: Seen before its task finished")]);
    running.state = "running";
    const done = taskOf(engine, world.shop, "Finished first", [older("other", "bug-other: A different bug")]);
    during = () => Object.assign(fix, { state: "done", column: "done", finishedAt: Date.now() });
    await finish(engine, done);
    expect(world.prompts[0]).toContain(`Card [${fixId}]`);
    expect([fix.followUp, running.findings[0]!.tracking, cardFor(engine, "early")]).toEqual([undefined, undefined, []]);
    expect(engine.s.followUpPending?.some(group => group.keys.includes(followUpKey(running.id, "early")))).toBe(false);
    expect(cardFor(engine, "other")).toHaveLength(1);
    release();
    await finish(engine, running);
    const card = cardFor(engine, "early");
    expect(card.map(task => task.followUp!.reports.map(report => report.findingId))).toEqual([["early"]]);
    expect(engine.task(running.id)!.findings[0]!.tracking).toEqual({ taskId: card[0]!.id });
  } finally { await world.engine.shutdown(); }
});

it("finishes a credited report's picture copy on a manual fix whose products changed, adding no product or card", async () => {
  const world = await open(groupByBug, true);
  const { engine } = world;
  try {
    const fixId = engine.addTask({ productId: world.shop, kind: "bug", title: "bug-moved: The coordinator's fix", backlog: true });
    engine.queueTask(fixId);
    const fix = engine.task(fixId)!;
    const source = taskOf(engine, world.shop, "A pictured sighting", [older("old", "bug-moved: A later sighting")]);
    plant(engine, source.id, source.findings[0]!.text);
    const copy = spyOn(fileIO, "copyFile").mockRejectedValue(new Error("Copy refused"));
    try { await finish(engine, source); } finally { copy.mockRestore(); }
    expect(fix.followUp!.reports.map(report => report.findingId)).toEqual(["old"]);
    fix.selectedProducts = [{ productId: world.notes, startFrom: { kind: "default" }, delivery: "pull-request" }];
    const products = structuredClone(fix.selectedProducts);
    await engine["followUps"].catchUp();
    expect(engine.task(source.id)!.findings[0]!.tracking).toEqual({ taskId: fixId });
    expect(fix.session.flatMap(line => line.images ?? []).map(image => image.from)).toEqual([{ taskId: source.id, imageId: "pic" }]);
    expect([fix.selectedProducts, fix.followUp!.alsoReported, fix.followUp!.reports.length, cards(engine).length]).toEqual([products, undefined, 1, 1]);
    expect(world.prompts).toHaveLength(1);
  } finally { await world.engine.shutdown(); }
});

it("keeps an unfinished source's picture while its report's link is copied, even when that task is cancelled", async () => {
  const world = await open();
  const { engine } = world;
  try {
    const fixId = engine.addTask({ productId: world.shop, kind: "bug", title: "bug-held: The coordinator's fix", backlog: true });
    engine.queueTask(fixId);
    const running = taskOf(engine, world.shop, "Still running", [older("early", "bug-held: Seen while its task runs")]);
    running.state = "running";
    plant(engine, running.id, running.findings[0]!.text);
    const original = join(engine.dataDir, "captures", running.id, "pic.png");
    const done = taskOf(engine, world.shop, "Finished", [older("late", "bug-held: The same bug, finished")]);
    const originalCopy = fileIO.copyFile;
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    let copying!: () => void;
    const started = new Promise<void>(resolve => { copying = resolve; });
    const copy = spyOn(fileIO, "copyFile").mockImplementation(async (...args) => { copying(); await held; return originalCopy(...args); });
    try {
      const finishing = finish(engine, done);
      await started;
      engine.cancel(running.id);
      await engine["cleanup"].removeCaptures(running.id);
      expect(existsSync(original)).toBe(true);
      release();
      await finishing;
    } finally { release(); copy.mockRestore(); }
    const fix = engine.task(fixId)!;
    expect(fix.followUp!.reports.map(report => report.findingId).sort()).toEqual(["early", "late"]);
    expect(fix.session.flatMap(line => line.images ?? []).map(image => image.from)).toEqual([{ taskId: running.id, imageId: "pic" }]);
    expect(engine.task(running.id)!.findings[0]!.tracking).toEqual({ taskId: fixId });
    await engine["cleanup"].removeCaptures(running.id);
    expect(existsSync(original)).toBe(false);
  } finally { await world.engine.shutdown(); }
});

it("keeps a saved link and its picture when the manual fix finishes or is cancelled during the copy, then follows the closed-target rules", async () => {
  const world = await open();
  const { engine } = world;
  try {
    for (const [end, copied] of [["finish", true], ["cancel", true], ["finish", false]] as const) {
      const label = `${end}${copied ? "copied" : "refused"}`;
      const fixId = engine.addTask({ productId: world.shop, kind: "bug", title: `bug-${label}: The coordinator's fix`, description: "The unchanged request", backlog: true });
      engine.queueTask(fixId);
      const fix = engine.task(fixId)!;
      const source = taskOf(engine, world.shop, `Copying while the fix ends: ${end}`, [older("old", `bug-${label}: A later sighting`)]);
      plant(engine, source.id, source.findings[0]!.text);
      const key = followUpKey(source.id, "old");
      const original = join(engine.dataDir, "captures", source.id, "pic.png");
      const originalCopy = fileIO.copyFile;
      let release!: () => void;
      const held = new Promise<void>(resolve => { release = resolve; });
      let copying!: () => void;
      const started = new Promise<void>(resolve => { copying = resolve; });
      const copy = spyOn(fileIO, "copyFile").mockImplementation(async (...args) => {
        copying();
        await held;
        if (!copied) throw new Error("Copy refused");
        return originalCopy(...args);
      });
      try {
        const finishing = finish(engine, source);
        await started;
        // The destination and the report were saved before copying began.
        expect(fix.followUp!.reports.map(report => report.findingId)).toEqual(["old"]);
        expect(engine.s.followUpPending).toContainEqual({ keys: [key], cardId: fixId });
        if (end === "finish") Object.assign(fix, { state: "done", column: "done", finishedAt: Date.now() });
        else engine.cancel(fixId);
        fix.session.push({ id: `during-${label}`, from: "agent", text: "Activity while the copy runs", at: Date.now() });
        // Both tasks stay on the board, with their pictures, while the link is saved.
        engine.save();
        expect([engine.s.tasks.includes(fix), engine.s.tasks.includes(source)]).toEqual([true, true]);
        await engine["cleanup"].removeCaptures(source.id);
        await engine["cleanup"].removeCaptures(fixId);
        expect(existsSync(original)).toBe(true);
        expect(existsSync(join(engine.dataDir, "captures", fixId))).toBe(true);
        release();
        await finishing;
      } finally { release(); copy.mockRestore(); }
      const after = engine.task(fixId)!;
      expect(after.state).toBe(end === "finish" ? "done" : "cancelled");
      expect(after.followUp!.reports.map(report => report.findingId)).toEqual(["old"]);
      expect(after.session.some(line => line.id === `during-${label}`)).toBe(true);
      expect(after.session.flatMap(line => line.images ?? [])).toHaveLength(copied ? 1 : 0);
      expect(engine.task(source.id)!.findings[0]!.tracking).toEqual(copied ? { taskId: fixId } : { reason: "pictures", retry: true });
      expect(engine.s.followUpPending).toEqual(copied ? [] : [{ keys: [key], cardId: fixId }]);
      // Released, the closed fix leaves the board. Recovery neither reopens it nor opens another card, and
      // the original picture goes with the source's cleanup, as for any finished or cancelled destination.
      engine.save();
      expect(engine.s.tasks.some(task => task.id === fixId)).toBe(false);
      await engine["followUps"].catchUp();
      expect(cardFor(engine, label)).toEqual([]);
      expect(engine.task(fixId)!.state).toBe(after.state);
      expect(engine.task(fixId)!.followUp!.reports).toHaveLength(1);
      await engine["cleanup"].removeCaptures(source.id);
      await engine["cleanup"].removeCaptures(fixId);
      expect([existsSync(original), existsSync(join(engine.dataDir, "captures", fixId))]).toEqual([false, false]);
    }
    expect(world.prompts).toHaveLength(3);
  } finally { await world.engine.shutdown(); }
});

it("retries a queued manual fix's picture across source retirement and restart, adding only the missing copy and one credit", async () => {
  const world = await open();
  try {
    const { engine } = world;
    const fixId = engine.addTask({ productId: world.shop, kind: "bug", title: "bug-retry: The coordinator's fix", description: "The unchanged request", backlog: true });
    engine.queueTask(fixId);
    const source = taskOf(engine, world.shop, "A pictured sighting", [older("old", "bug-retry: A later sighting")]);
    plant(engine, source.id, source.findings[0]!.text);
    const original = join(engine.dataDir, "captures", source.id, "pic.png");
    const copy = spyOn(fileIO, "copyFile").mockRejectedValue(new Error("Copy refused"));
    try {
      await finish(engine, source);
      expect(source.findings[0]!.tracking).toEqual({ reason: "pictures", retry: true });
      expect(engine.task(fixId)!.followUp!.reports.map(report => report.findingId)).toEqual(["old"]);
      engine.save();
      expect(engine.s.tasks.some(task => task.id === source.id)).toBe(false);
      await engine["cleanup"].removeCaptures(source.id);
      expect(existsSync(original)).toBe(true);
    } finally { copy.mockRestore(); }
    await reopen(world);
    const fix = world.engine.task(fixId)!;
    expect([fix.state, fix.description]).toEqual(["queued", "The unchanged request"]);
    expect(world.engine.task(source.id)!.findings[0]!.tracking).toEqual({ taskId: fixId });
    expect(fix.followUp!.reports).toHaveLength(1);
    await world.engine["followUps"].catchUp();
    expect(fix.session.flatMap(line => line.images ?? []).map(image => image.from)).toEqual([{ taskId: source.id, imageId: "pic" }]);
    await world.engine["cleanup"].removeCaptures(source.id);
    expect(existsSync(original)).toBe(false);
    expect(cards(world.engine).map(task => task.id)).toEqual([fixId]);
    expect(world.prompts).toHaveLength(1);
  } finally { await world.engine.shutdown(); }
});

function cardFor(engine: Engine, bug: string) {
  return cards(engine).filter((task) => task.title.startsWith(`bug-${bug}`));
}

function plant(engine: Engine, taskId: string, text: string): void {
  const dir = join(engine.dataDir, "captures", taskId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "pic.png"), "png");
  const task = engine.task(taskId)!;
  task.journey = [{
    id: `${taskId}-review`,
    kind: "agent",
    round: 1,
    sub: 0,
    startedAt: 1,
    agentResults: [{ roleId: "code-reviewer", profileId: "opus-high", at: 1, value: { findings: [{ text }] }, images: [{ id: "pic", caption: "The retired page" }] }],
  }];
}

it("does not start an identity agent while scheduling is paused", async () => {
  const world = await open();
  try {
    const source = taskOf(world.engine, world.shop, "A paused follow-up", [
      older("paused", "bug-paused: An older page is broken."),
      older("peer", "bug-paused: The same older page cannot open.", { raisedBy: "sol-high" }),
    ]);
    world.engine.commitNow();
    await reopen(world, false);
    await finish(world.engine, world.engine.task(source.id)!);
    const fakes = new Fakes(join(world.root, "agents"));
    expect(fakes.received().filter((entry) => entry.text.includes("Which older reports are the same bug?"))).toHaveLength(0);
    expect(cards(world.engine)).toHaveLength(0);
    expect(world.engine.task(source.id)!.findings[0]!.tracking).toEqual({ reason: "unavailable", retry: true });
  } finally { await world.engine.shutdown(); }
});

it("keeps one backlog card for a confirmed older bug and leaves everything else on the task", async () => {
  const world = await open();
  const { engine } = world;
  try {
    const inbox = engine.s.inbox.length;
    const kept = taskOf(engine, world.shop, "Footer links", [
      older("kept", "bug-kept: The footer opens a retired page."),
      older("nit", "A quieter footer would be nicer.", { severity: "suggestion" }),
      older("caused", "This change sends About to a missing page.", { severity: "blocking" }),
      older("dismissed", "bug-dismissed: An old footer note.", { status: "dismissed" }),
      older("check", "Check failed: the suite", { raisedBy: "petrina" }),
      older("acceptance", "Failed acceptance check: the footer still loads."),
      older("unverified", "Could not verify acceptance check: the footer", { status: "unverified" }),
      older("steps", "bug-steps: The footer has no steps.", { steps: undefined }),
      older("evidence", "bug-evidence: The footer has no evidence.", { evidence: undefined }),
    ]);
    const waiting = taskOf(engine, world.shop, "Still open", [older("pull", "bug-pull: The footer opens a retired page.")]);
    waiting.state = "pr-open";
    await engine["followUps"].noteDone(waiting);
    await engine["followUps"].catchUp();
    expect(cards(engine)).toHaveLength(0);

    await finish(engine, kept);
    const card = cardFor(engine, "kept");
    expect(card).toHaveLength(1);
    expect(card[0]!.state).toBe("backlog");
    expect(card[0]!.kind).toBe("bug");
    expect(card[0]!.startedAt).toBeUndefined();
    expect(card[0]!.approvePlan).toBe(false);
    expect(card[0]!.selectedProducts?.map((choice) => choice.productId)).toEqual([world.shop]);
    expect(card[0]!.description).toContain(STEPS);
    expect(card[0]!.description).toContain(EVIDENCE);
    expect(card[0]!.description).toContain("Found on Footer links.");
    expect(card[0]!.followUp!.reports.map((report) => report.findingId)).toEqual(["kept"]);
    expect(card[0]!.timeline.map((entry) => entry.text)).toContain("Kept as future work");
    const finding = kept.findings.find((entry) => entry.id === "kept")!;
    expect(finding.tracking).toEqual({ taskId: card[0]!.id });
    expect(kept.findings.find((entry) => entry.id === "steps")!.tracking).toEqual({ reason: "missing-steps" });
    expect(kept.findings.find((entry) => entry.id === "evidence")!.tracking).toEqual({ reason: "missing-evidence" });
    for (const id of ["nit", "caused", "dismissed", "check", "acceptance", "unverified"]) expect(kept.findings.find((entry) => entry.id === id)!.tracking).toBeUndefined();
    expect(kept.state).toBe("done");
    expect(kept.rounds).toEqual({ review: 1 });
    expect(engine.s.inbox.length).toBe(inbox);
    expect(waiting.findings[0]!.tracking).toBeUndefined();

    engine.setPoolPaused(false);
    engine.schedule();
    expect(card[0]!.state).toBe("backlog");
    expect(card[0]!.startedAt).toBeUndefined();
    expect(engine.drivers.size).toBe(0);
    engine.setPoolPaused(true);

    await engine["followUps"].catchUp();
    expect(cards(engine)).toHaveLength(1);
    expect(cardFor(engine, "pull")).toHaveLength(0);
    expect(waiting.findings[0]!.tracking).toBeUndefined();
  } finally { await engine.shutdown(); }
});

it("credits every matching report on one card, in either order, and again after a restart", async () => {
  const world = await open();
  const { engine } = world;
  try {
    const savedFirst = taskOf(engine, world.shop, "First wording", [older("one", "bug-saved: The footer opens a retired page.", { raisedBy: "opus-high", roleId: "code-reviewer" })]);
    const savedSecond = taskOf(engine, world.shop, "Second wording", [older("two", "bug-saved: Choosing About still lands on the old page.", { raisedBy: "sol-high", roleId: "security-reviewer" })]);
    await finish(engine, savedFirst);
    expect(cardFor(engine, "saved")).toHaveLength(1);
    expect(cardFor(engine, "saved")[0]!.followUp!.reports.map((report) => report.taskId).sort()).toEqual([savedFirst.id, savedSecond.id].sort());
    expect(savedSecond.findings[0]!.tracking).toEqual({ taskId: cardFor(engine, "saved")[0]!.id });
    await finish(engine, savedSecond);
    expect(cardFor(engine, "saved")).toHaveLength(1);
    expect(savedSecond.findings[0]!.roleId).toBe("security-reviewer");

    const later = taskOf(engine, world.shop, "Later wording", []);
    const early = taskOf(engine, world.shop, "Early wording", [older("early", "bug-later: The footer opens a retired page.", { roleId: "layout-reviewer" })]);
    await finish(engine, early);
    expect(cardFor(engine, "later")[0]!.followUp!.reports).toHaveLength(1);
    later.findings = [older("late", "bug-later: The about page in the footer is retired.")];
    await finish(engine, later);
    expect(cardFor(engine, "later")).toHaveLength(1);
    expect(cardFor(engine, "later")[0]!.followUp!.reports.map((report) => report.findingId).sort()).toEqual(["early", "late"]);
    expect(later.findings[0]!.tracking).toEqual({ taskId: cardFor(engine, "later")[0]!.id });
    expect(early.findings[0]!.tracking).toEqual({ taskId: cardFor(engine, "later")[0]!.id });

    const left = taskOf(engine, world.shop, "Left wording", [older("left", "bug-both: The footer opens a retired page.")]);
    const right = taskOf(engine, world.shop, "Right wording", [older("right", "bug-both: About in the footer is the old page.")]);
    left.state = "done";
    right.state = "done";
    await Promise.all([engine["followUps"].noteDone(left), engine["followUps"].noteDone(right)]);
    expect(cardFor(engine, "both")).toHaveLength(1);
    expect(cardFor(engine, "both")[0]!.followUp!.reports.map((report) => report.findingId).sort()).toEqual(["left", "right"]);

    const lone = taskOf(engine, world.shop, "Lone cancelled", [older("lone", "bug-alone: The footer opens a retired page.")]);
    lone.state = "cancelled";
    await engine["followUps"].catchUp();
    expect(cardFor(engine, "alone")).toHaveLength(0);
    const cancelled = taskOf(engine, world.shop, "Cancelled wording", [older("gone", "bug-cancel: The footer opens a retired page.")]);
    const other = taskOf(engine, world.shop, "Other wording", [older("other", "bug-cancel: About in the footer is retired.")]);
    cancelled.state = "cancelled";
    await finish(engine, other);
    expect(cardFor(engine, "cancel")).toHaveLength(1);
    expect(cardFor(engine, "cancel")[0]!.followUp!.reports.map((report) => report.findingId).sort()).toEqual(["gone", "other"]);

    const count = cards(engine).length;
    const ids = cards(engine).map((task) => task.id).sort();
    await reopen(world);
    expect(cards(world.engine).map((task) => task.id).sort()).toEqual(ids);
    expect(cards(world.engine)).toHaveLength(count);
    expect(world.engine.task(savedFirst.id)!.findings[0]!.tracking).toEqual({ taskId: cardFor(world.engine, "saved")[0]!.id });
  } finally { await world.engine.shutdown(); }
});

it("follows a chosen card, keeps a refusal off it, and matches a missing choice", async () => {
  const world = await open();
  const { engine } = world;
  try {
    const known = taskOf(engine, world.shop, "Known footer", [older("known", "bug-known: The footer opens a retired page.")]);
    await finish(engine, known);
    const card = cardFor(engine, "known")[0]!;
    const before = world.prompts.length;
    const pointed = taskOf(engine, world.shop, "Pointed", [older("pointed", "bug-other: Words that do not match the card.", { cardsShown: [card.id], sameBug: card.id })]);
    await finish(engine, pointed);
    expect(pointed.findings[0]!.tracking).toEqual({ taskId: card.id });
    expect(card.followUp!.reports.map((report) => report.findingId)).toContain("pointed");
    expect(world.prompts.length).toBe(before);

    const refused = taskOf(engine, world.shop, "Refused", [older("refused", "bug-fresh: A different footer bug.", { cardsShown: [card.id], sameBug: "none" })]);
    const pair = taskOf(engine, world.shop, "Paired refusal", [older("pair", "bug-fresh: The same different footer bug.", { cardsShown: [card.id], sameBug: "none" })]);
    const silent = taskOf(engine, world.shop, "No choice", [older("silent", "bug-silent: Nobody chose a card.", { cardsShown: [card.id] })]);
    await finish(engine, refused);
    await finish(engine, pair);
    const fresh = cardFor(engine, "fresh");
    expect(fresh).toHaveLength(1);
    expect(fresh[0]!.id).not.toBe(card.id);
    expect(fresh[0]!.followUp!.reports.map((report) => report.findingId).sort()).toEqual(["pair", "refused"]);
    expect(card.followUp!.reports.map((report) => report.findingId)).not.toContain("refused");

    await finish(engine, silent);
    expect(silent.findings[0]!.tracking).toEqual({ taskId: cardFor(engine, "silent")[0]!.id });
    expect(card.followUp!.reports.map(report => report.findingId)).not.toContain("silent");
    const same = taskOf(engine, world.shop, "Skipped same bug", [older("same", "bug-known: Another wording of the known bug", { cardsShown: [card.id] })]);
    await finish(engine, same);
    expect(world.prompts.at(-1)).toContain(`Card [${card.id}]`);
    expect(same.findings[0]!.tracking).toEqual({ taskId: card.id });
    expect(card.followUp!.reports.map(report => report.findingId)).toContain("same");
  } finally { await engine.shutdown(); }
});

it("recovers a skipped choice after the shown card finishes, preserving votes, pictures and one card through restart", async () => {
  const world = await open();
  try {
    const { engine } = world;
    const shown = engine.addTask({ productId: world.shop, kind: "bug", title: "Already finished", backlog: true });
    engine.task(shown)!.state = "done";
    const text = "bug-silent: An accepted confirmed unrelated bug";
    const accepted = ReviewResult.parse({ verdict: "pass", findings: [{ text, severity: "pre-existing", steps: STEPS, evidence: EVIDENCE }] });
    expect(checkReviewEvidence([], accepted)).toBeUndefined();
    const source = taskOf(engine, world.shop, "Finished source", [older("old", text, {
      cardsShown: [shown], tracking: { reason: "no-choice" },
      verification: { by: "sol-high", verdict: "pre-existing", reason: "Three independent voters confirmed base", at: 1 },
      votes: [{ by: "sol-high", toolId: "codex", verdict: "pre-existing", reason: "Base reproduction confirmed" }],
    })]);
    plant(engine, source.id, text);
    const release = engine.holdFollowUp(source.id);
    try {
      source.state = "done";
      source.column = "done";
      engine.save();
      expect(engine.s.tasks.some(task => task.id === source.id)).toBe(true);
      await engine["followUps"].catchUp();
    } finally { release(); }
    const card = cardFor(engine, "silent")[0]!;
    expect(card.state).toBe("backlog");
    expect(card.description).toContain(STEPS);
    expect(card.description).toContain("Three independent voters confirmed base");
    expect(card.description).toContain("Base reproduction confirmed");
    expect(card.followUp!.reports[0]).toMatchObject({ taskId: source.id, findingId: "old", text });
    expect(card.session.flatMap(line => line.images ?? [])).toHaveLength(1);
    expect(engine.task(source.id)!.findings[0]!.tracking).toEqual({ taskId: card.id });
    expect(world.prompts).toEqual([]);
    await reopen(world);
    await world.engine["followUps"].catchUp();
    expect(cardFor(world.engine, "silent")).toHaveLength(1);
    expect(world.engine.task(card.id)!.session.flatMap(line => line.images ?? [])).toHaveLength(1);
  } finally { await world.engine.shutdown(); }
});

function settledSource(engine: Engine, productId: string, extra: Partial<Finding> = {}) {
  const source = taskOf(engine, productId, "A finished report", [older("old", "bug-manual: The confirmed older defect", { tracking: { reason: "no-choice" }, ...extra })]);
  source.state = "done";
  source.column = "done";
  source.finishedAt = Date.now();
  return source;
}

it("records a manual link from archived history to a running request without changing evidence or the request, and retains its receipt", async () => {
  const world = await open();
  try {
    const { engine } = world;
    const source = settledSource(engine, world.shop, { verification: { by: "sol-high", verdict: "pre-existing", reason: "Confirmed on base", at: 1 } });
    engine.save();
    expect(engine.s.tasks.some(task => task.id === source.id)).toBe(false);
    const targetId = engine.addTask({ productId: world.shop, kind: "bug", title: "Coordinator's request", description: "Keep these exact requirements", backlog: true });
    const target = engine.task(targetId)!;
    target.state = "running";
    const request = { title: target.title, description: target.description, products: target.selectedProducts };
    const original = structuredClone(engine.task(source.id)!.findings[0]!);
    const count = engine.getState().tasks.length;
    const args = { taskId: source.id, findingId: "old", targetTaskId: targetId, requestId: "manual-history" };
    const c = new Coordination(engine);
    const result = await c.call("task.track-finding", args);
    expect(result).toEqual({ outcome: "completed", ...args });
    const client = { call: (name: string, args: Record<string, unknown>) => c.call(name, args) } as EngineClient;
    const output = spyOn(console, "log").mockImplementation(() => {});
    try {
      expect(await coordinationCli(["task", "track-finding", "--task-id", source.id, "--finding-id", "old", "--target-task-id", targetId, "--request-id", args.requestId, "--json"], client)).toBe(0);
      expect(JSON.parse(output.mock.calls.at(-1)![0] as string)).toEqual(result);
    } finally { output.mockRestore(); }
    expect(mcpTools().find(tool => tool.name === "petrina_task_track_finding")!.inputSchema.required).toContain("requestId");
    const mcp = await mcpRequest({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "petrina_task_track_finding", arguments: args } }, client);
    expect((mcp!.result as { structuredContent: unknown }).structuredContent).toEqual(result);
    expect((await c.call("task.track-finding", { taskId: source.id, findingId: "old", targetTaskId: targetId })).outcome).toBe("invalid");
    expect(await c.call("task.track-finding", args)).toEqual(result);
    expect((await c.call("task.track-finding", { ...args, targetTaskId: "different" })).outcome).toBe("conflict");
    expect((await c.call("task.track-finding", { ...args, requestId: "already-linked" })).outcome).toBe("completed");
    expect(engine.taskDetails(source.id)!.findings[0]).toEqual({ ...original, tracking: { taskId: targetId } });
    expect((await c.call("task.read", { taskId: source.id, section: "findings", findingId: "old" })).text).toContain(targetId);
    expect(target.followUp!.reports).toHaveLength(1);
    expect(target.followUp!.preserveRequest).toBe(true);
    expect({ title: target.title, description: target.description, products: target.selectedProducts }).toEqual(request);
    expect(engine.getState().tasks).toHaveLength(count);
    expect(world.prompts).toEqual([]);
    expect(new Fakes(join(world.root, "agents")).prompts()).toEqual([]);
    await reopen(world);
    expect(await new Coordination(world.engine).call("task.track-finding", args)).toEqual(result);
    expect(world.engine.task(source.id)!.findings[0]).toEqual({ ...original, tracking: { taskId: targetId } });
    expect(world.engine.task(targetId)!.followUp!.reports).toHaveLength(1);
    expect(world.prompts).toEqual([]);
  } finally { await world.engine.shutdown(); }
});

it("links manually to a finished bug without changing it, but refuses while original pictures remain", async () => {
  const world = await open();
  try {
    const { engine } = world;
    const source = settledSource(engine, world.shop);
    plant(engine, source.id, source.findings[0]!.text);
    const targetId = engine.addTask({ productId: world.shop, kind: "bug", title: "Finished bug", backlog: true });
    engine.task(targetId)!.state = "done";
    engine.save();
    const original = structuredClone(engine.task(targetId)!);
    const c = new Coordination(engine);
    const args = { taskId: source.id, findingId: "old", targetTaskId: targetId, requestId: "finished-pictures" };
    const refused = await c.call("task.track-finding", args);
    expect(refused.outcome).toBe("invalid");
    expect(refused.message).toContain("pictures");
    expect(engine.task(source.id)!.findings[0]!.tracking).toEqual({ reason: "no-choice" });
    await engine["cleanup"].removeCaptures(source.id);
    expect((await c.call("task.track-finding", { ...args, requestId: "finished-link" })).outcome).toBe("completed");
    expect(engine.task(source.id)!.findings[0]!.tracking).toEqual({ taskId: targetId });
    expect(engine.task(targetId)).toEqual(original);
    expect(world.prompts).toEqual([]);
  } finally { await world.engine.shutdown(); }
});

it("copies manual-link pictures before tracking, keeps concurrent messages, and allows source cleanup", async () => {
  const world = await open();
  try {
    const { engine } = world;
    const source = settledSource(engine, world.shop, { tracking: { reason: "unavailable", retry: true } });
    plant(engine, source.id, source.findings[0]!.text);
    const targetId = engine.addTask({ productId: world.shop, kind: "bug", title: "Working on it", backlog: true });
    const target = engine.task(targetId)!;
    target.state = "running";
    engine.s.followUpPending = [{ keys: [followUpKey(source.id, "old")], retry: true }];
    const originalCopy = fileIO.copyFile;
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    let copying!: () => void;
    const started = new Promise<void>(resolve => { copying = resolve; });
    const copy = spyOn(fileIO, "copyFile").mockImplementation(async (...args) => { copying(); await held; return originalCopy(...args); });
    const c = new Coordination(engine);
    const args = { taskId: source.id, findingId: "old", targetTaskId: targetId, requestId: "pictured-link" };
    try {
      const linking = c.call("task.track-finding", args);
      await started;
      expect(source.findings[0]!.tracking).toEqual({ reason: "unavailable", retry: true });
      target.session.push({ id: "during-copy", from: "agent", text: "Still working", at: 1 });
      await engine["cleanup"].removeCaptures(source.id);
      expect(existsSync(join(engine.dataDir, "captures", source.id, "pic.png"))).toBe(true);
      release();
      expect((await linking).outcome).toBe("completed");
    } finally { release(); copy.mockRestore(); }
    expect(engine.task(source.id)!.findings[0]!.tracking).toEqual({ taskId: targetId });
    expect(target.session.some(line => line.id === "during-copy")).toBe(true);
    expect(target.session.flatMap(line => line.images ?? [])).toHaveLength(1);
    expect(readdirSync(join(engine.dataDir, "captures", targetId))).toHaveLength(1);
    expect(engine.s.followUpPending).toEqual([]);
    expect((await c.call("task.track-finding", { ...args, requestId: "pictures-again" })).outcome).toBe("completed");
    await engine["followUps"].catchUp();
    await engine["cleanup"].removeCaptures(source.id);
    expect(existsSync(join(engine.dataDir, "captures", source.id))).toBe(false);
    expect(target.followUp!.reports).toHaveLength(1);
    expect(target.session.flatMap(line => line.images ?? [])).toHaveLength(1);
    await reopen(world);
    expect(world.engine.task(source.id)!.findings[0]!.tracking).toEqual({ taskId: targetId });
    expect(world.prompts).toEqual([]);
  } finally { await world.engine.shutdown(); }
});

it("refuses incomplete, unsettled and ineligible manual links with plain reasons and no changes", async () => {
  const world = await open(undefined, true);
  try {
    const { engine } = world;
    const c = new Coordination(engine);
    const variants: { name: string; finding?: Partial<Finding>; sourceState?: "running" | "cancelled"; target?: "missing" | "cancelled" | "combined" | "feature" | "self" | "product"; pending?: boolean }[] = [
      { name: "fixed", finding: { status: "fixed" } },
      { name: "dismissed", finding: { status: "dismissed" } },
      ...(["not-a-bug", "nit", "real"] as const).map(verdict => ({ name: `judged-${verdict}`, finding: { verification: { by: "sol-high", verdict, reason: "Not confirmed older", at: 1 } } })),
      { name: "nit", finding: { severity: "suggestion" } },
      { name: "Important", finding: { severity: "blocking" } },
      { name: "check", finding: { raisedBy: "petrina", text: "Check failed: tests" } },
      { name: "acceptance", finding: { text: "Failed acceptance check: page" } },
      { name: "steps", finding: { steps: " " } },
      { name: "evidence", finding: { evidence: " " } },
      { name: "elsewhere", finding: { tracking: { taskId: "another-task" } } },
      { name: "no-outcome", finding: { tracking: undefined } },
      { name: "unfinished", sourceState: "running" },
      { name: "cancelled-source", sourceState: "cancelled" },
      { name: "pending", pending: true },
      ...(["missing", "cancelled", "combined", "feature", "self", "product"] as const).map(target => ({ name: target, target })),
      { name: "all-products", finding: { productIds: [world.shop, world.notes] } },
    ];
    for (const variant of variants) {
      const source = settledSource(engine, world.shop, variant.finding);
      if (variant.sourceState) source.state = variant.sourceState;
      const targetId = engine.addTask({ productId: variant.target === "product" ? world.notes : world.shop, kind: variant.target === "feature" ? "feature" : "bug", title: variant.name, backlog: true });
      const target = engine.task(targetId)!;
      if (variant.target === "cancelled" || variant.target === "combined") target.state = "cancelled";
      if (variant.target === "combined") target.combinedInto = "replacement";
      engine.s.followUpPending = variant.pending ? [{ keys: [followUpKey(source.id, "old")], cardId: targetId }] : [];
      engine.save();
      const before = structuredClone([engine.task(source.id), engine.task(targetId), engine.s.followUpPending]);
      const result = await c.call("task.track-finding", { taskId: source.id, findingId: "old", targetTaskId: variant.target === "missing" ? "missing" : variant.target === "self" ? source.id : targetId, requestId: `refuse-${variant.name}` });
      expect(result.outcome, variant.name).toBe("invalid");
      expect(typeof result.message, variant.name).toBe("string");
      expect([engine.task(source.id), engine.task(targetId), engine.s.followUpPending], variant.name).toEqual(before);
    }
    expect(world.prompts).toEqual([]);
  } finally { await world.engine.shutdown(); }
});

it("waits for automatic linking before a manual link, so a report cannot be credited twice", async () => {
  let release!: () => void;
  let matching!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { matching = resolve; });
  const world = await open(async prompt => { matching(); await held; return groupByBug(prompt); });
  try {
    const { engine } = world;
    const automaticId = engine.addTask({ productId: world.shop, kind: "bug", title: "bug-race: Existing bug", backlog: true });
    const manualId = engine.addTask({ productId: world.shop, kind: "bug", title: "Different manual request", backlog: true });
    const source = taskOf(engine, world.shop, "Skipped choice", [older("old", "bug-race: A new sighting", { cardsShown: [automaticId] })]);
    plant(engine, source.id, source.findings[0]!.text);
    const finishing = finish(engine, source);
    await started;
    let replied = false;
    const linking = new Coordination(engine).call("task.track-finding", { taskId: source.id, findingId: "old", targetTaskId: manualId, requestId: "racing-link" }).then(result => { replied = true; return result; });
    await Promise.resolve();
    expect(replied).toBe(false);
    release();
    await finishing;
    const result = await linking;
    expect(result.outcome).toBe("invalid");
    expect(result.message).toContain("another task");
    expect(engine.task(source.id)!.findings[0]!.tracking).toEqual({ taskId: automaticId });
    expect(engine.task(automaticId)!.followUp!.reports).toHaveLength(1);
    expect(engine.task(automaticId)!.session.flatMap(line => line.images ?? [])).toHaveLength(1);
    expect(engine.task(manualId)!.followUp).toBeUndefined();
    await engine["followUps"].catchUp();
    expect(engine.task(manualId)!.followUp).toBeUndefined();
  } finally { release(); await world.engine.shutdown(); }
});

async function failedAssignment(world: World, reason: "unavailable" | "no-choice") {
  const { engine } = world;
  const automaticId = engine.addTask({ productId: world.shop, kind: "bug", title: "bug-reserved: Existing bug", backlog: true });
  const manualId = engine.addTask({ productId: world.shop, kind: "bug", title: "Different manual request", backlog: true });
  engine.task(manualId)!.state = "running";
  const tracking = reason === "unavailable" ? { reason, retry: true } : { reason };
  const source = taskOf(engine, world.shop, "Saved report", [older("old", "bug-reserved: Another sighting", { cardsShown: [automaticId], tracking })]);
  const release = engine.holdFollowUp(source.id);
  source.state = "done";
  source.column = "done";
  source.finishedAt = Date.now();
  const key = followUpKey(source.id, "old");
  engine.s.followUpPending = reason === "unavailable" ? [{ keys: [key], retry: true }] : [];
  plant(engine, source.id, source.findings[0]!.text);
  engine.save();
  const copy = spyOn(fileIO, "copyFile").mockRejectedValue(new Error("Copy refused"));
  try { await engine["followUps"].catchUp(); }
  catch (error) { release(); throw error; }
  finally { copy.mockRestore(); }
  expect(engine.task(automaticId)!.followUp!.reports.map(report => report.findingId)).toEqual(["old"]);
  expect(engine.task(automaticId)!.session.flatMap(line => line.images ?? [])).toEqual([]);
  return { source, automaticId, manualId, key, release };
}

async function combinedAssignments(world: World, partial = false) {
  const { engine } = world;
  const sources = [
    taskOf(engine, world.shop, "First source", [older("first", "bug-first: An older footer bug")]),
    taskOf(engine, world.shop, "Second source", [older("second", "bug-second: An older header bug")]),
  ];
  const releases = sources.map(source => engine.holdFollowUp(source.id));
  for (const source of sources) plant(engine, source.id, source.findings[0]!.text);
  if (partial) {
    sources[0]!.journey![0]!.agentResults![0]!.images!.push({ id: "second", caption: "Another view" });
    writeFileSync(join(world.data, "captures", sources[0]!.id, "second.png"), "png");
  }
  const original = fileIO.copyFile;
  const copy = spyOn(fileIO, "copyFile").mockImplementation(async (...args) => {
    if (String(args[0]).endsWith("pic.png")) throw new Error("Copy refused");
    return original(...args);
  });
  try {
    for (const source of sources) await finish(engine, source);
  } catch (error) { releases.forEach(release => release()); throw error; }
  finally { copy.mockRestore(); }
  const originals = [cardFor(engine, "first")[0]!.id, cardFor(engine, "second")[0]!.id];
  const combinedId = await dispatch(engine, { name: "combineBacklog", args: [originals, "Keep both bug reports", "combined-reports"] }) as string;
  expect(engine.task(combinedId)!.followUp!.reports).toHaveLength(2);
  for (const id of originals) expect(engine.task(id)!.combinedInto).toBe(combinedId);
  return { sources, originals, combinedId, release: () => releases.forEach(release => release()) };
}

it("recovers unfinished reports and pictures on the combined task after the app combines their cards", async () => {
  const world = await open();
  let release = () => {};
  try {
    const saved = await combinedAssignments(world);
    release = saved.release;
    const { sources, originals, combinedId } = saved;
    expect(originals.every(id => !world.engine.s.tasks.some(task => task.id === id))).toBe(true);
    for (const source of sources) expect(world.engine.task(source.id)!.findings[0]!.tracking).toEqual({ reason: "pictures", retry: true });
    await world.engine["followUps"].catchUp();
    await world.engine["followUps"].catchUp();
    for (const source of sources) expect(world.engine.task(source.id)!.findings[0]!.tracking).toEqual({ taskId: combinedId });
    const images = world.engine.task(combinedId)!.session.flatMap(line => line.images ?? []);
    expect(images.map(image => image.from?.taskId).sort()).toEqual(sources.map(source => source.id).sort());
    expect(world.engine.s.followUpPending).toEqual([]);
    release();
    for (const source of sources) {
      await world.engine["cleanup"].removeCaptures(source.id);
      expect(existsSync(join(world.data, "captures", source.id))).toBe(false);
    }
    expect(readdirSync(join(world.data, "captures", combinedId))).toHaveLength(2);
    await reopen(world);
    expect(cards(world.engine).map(task => task.id)).toEqual([combinedId]);
    expect(world.engine.task(combinedId)!.session.flatMap(line => line.images ?? [])).toHaveLength(2);
  } finally { release(); await world.engine.shutdown(); }
});

it("retains combined reports' originals while copying fails and permits manual recovery on a later combined task", async () => {
  const world = await open();
  let release = () => {};
  try {
    const saved = await combinedAssignments(world, true);
    release = saved.release;
    const { sources, combinedId } = saved;
    world.engine.moveToBacklog(combinedId);
    const extra = world.engine.addTask({ productId: world.shop, kind: "bug", title: "Another request", worksOn: world.engine.task(combinedId)!.selectedProducts, backlog: true });
    const latestId = await world.engine.combineBacklog([combinedId, extra], "Combined again", "combine-again");
    const otherId = world.engine.addTask({ productId: world.shop, kind: "bug", title: "Different bug request", backlog: true });
    world.engine.task(otherId)!.state = "running";
    release();
    world.engine.save();
    const original = fileIO.copyFile;
    const copy = spyOn(fileIO, "copyFile").mockImplementation(async (...args) => {
      if (String(args[0]).endsWith("pic.png")) throw new Error("Copy still refused");
      return original(...args);
    });
    try {
      for (const source of sources) {
        await world.engine["cleanup"].removeCaptures(source.id);
        expect(existsSync(join(world.data, "captures", source.id, "pic.png"))).toBe(true);
      }
      await reopen(world);
      expect(world.engine.s.followUpPending?.every(group => group.cardId === latestId)).toBe(true);
      expect(world.engine.task(latestId)!.session.flatMap(line => line.images ?? [])).toHaveLength(1);
    } finally { copy.mockRestore(); }
    const c = new Coordination(world.engine);
    const checks = world.prompts.length;
    for (const source of sources) {
      const args = { taskId: source.id, findingId: source.findings[0]!.id, targetTaskId: latestId, requestId: `combined-${source.id}` };
      expect((await c.call("task.track-finding", { ...args, targetTaskId: otherId, requestId: `unrelated-${source.id}` })).outcome).toBe("invalid");
      const result = await c.call("task.track-finding", args);
      expect(result.outcome).toBe("completed");
      expect(await c.call("task.track-finding", args)).toEqual(result);
    }
    expect(world.prompts).toHaveLength(checks);
    expect(world.engine.s.followUpPending).toEqual([]);
    for (const source of sources) {
      await world.engine["cleanup"].removeCaptures(source.id);
      expect(existsSync(join(world.data, "captures", source.id))).toBe(false);
    }
    await reopen(world);
    expect(world.engine.task(latestId)!.followUp!.reports).toHaveLength(2);
    expect(world.engine.task(latestId)!.session.flatMap(line => line.images ?? [])).toHaveLength(3);
    expect(readdirSync(join(world.data, "captures", latestId))).toHaveLength(3);
  } finally { release(); await world.engine.shutdown(); }
});

for (const reason of ["unavailable", "no-choice"] as const) it(`keeps an archived assignment after a failed ${reason} copy`, async () => {
  const world = await open();
  let release = () => {};
  try {
    const { engine } = world;
    const saved = await failedAssignment(world, reason);
    release = saved.release;
    const { source, automaticId, manualId } = saved;
    engine.task(automaticId)!.state = "cancelled";
    engine.save();
    expect(engine.s.tasks.some(task => task.id === automaticId)).toBe(false);
    const args = { taskId: source.id, findingId: "old", targetTaskId: manualId, requestId: `archived-${reason}` };
    const c = new Coordination(engine);
    const result = await c.call("task.track-finding", args);
    expect(result.outcome).toBe("invalid");
    expect(result.message).toContain("another task");
    const same = await c.call("task.track-finding", { ...args, targetTaskId: automaticId, requestId: `cancelled-${reason}` });
    expect(same.outcome).toBe("invalid");
    expect(same.message).toContain("cancelled");
    await engine["followUps"].catchUp();
    expect(engine.task(manualId)!.followUp).toBeUndefined();
    expect(cards(engine)).toHaveLength(0);
    release();
    engine.save();
    await reopen(world);
    await world.engine["followUps"].catchUp();
    expect(world.engine.task(automaticId)!.followUp!.reports.map(report => report.findingId)).toEqual(["old"]);
    expect(cards(world.engine)).toHaveLength(0);
    expect(await new Coordination(world.engine).call("task.track-finding", args)).toEqual(result);
    const retry = await new Coordination(world.engine).call("task.track-finding", { ...args, requestId: `archived-retry-${reason}` });
    expect(retry.outcome).toBe("invalid");
  } finally { release(); await world.engine.shutdown(); }
});

it("finishes a stranded History report on its existing card after restart, even without original pictures", async () => {
  const world = await open();
  let release = () => {};
  try {
    const saved = await failedAssignment(world, "no-choice");
    release = saved.release;
    const { source, automaticId, manualId } = saved;
    // A saved record from before unfinished assignments were kept for recovery.
    source.findings[0]!.tracking = { reason: "no-choice" };
    world.engine.s.followUpPending = [];
    release();
    world.engine.save();
    await world.engine["cleanup"].removeCaptures(source.id);
    expect(existsSync(join(world.data, "captures", source.id))).toBe(false);
    await reopen(world);
    await world.engine["followUps"].catchUp();
    expect(world.engine.s.tasks.some(task => task.id === source.id)).toBe(false);
    expect(world.engine.task(source.id)!.findings[0]!.tracking).toEqual({ reason: "no-choice" });
    const checks = world.prompts.length;
    const c = new Coordination(world.engine);
    const different = await c.call("task.track-finding", { taskId: source.id, findingId: "old", targetTaskId: manualId, requestId: "stranded-different" });
    expect(different.outcome).toBe("invalid");
    const args = { taskId: source.id, findingId: "old", targetTaskId: automaticId, requestId: "stranded-same" };
    expect((await c.call("task.track-finding", args)).outcome).toBe("completed");
    expect((await c.call("task.track-finding", args)).outcome).toBe("completed");
    expect(world.engine.task(source.id)!.findings[0]!.tracking).toEqual({ taskId: automaticId });
    expect(world.engine.task(automaticId)!.followUp!.reports).toHaveLength(1);
    expect(world.engine.task(manualId)!.followUp).toBeUndefined();
    expect(world.prompts).toHaveLength(checks);
  } finally { release(); await world.engine.shutdown(); }
});

for (const reason of ["unavailable", "no-choice"] as const) it(`keeps the ${reason} picture retry through source retirement and restart`, async () => {
  const world = await open();
  let release = () => {};
  try {
    const saved = await failedAssignment(world, reason);
    release = saved.release;
    const { source, automaticId, manualId, key } = saved;
    release();
    world.engine.save();
    expect(world.engine.s.tasks.some(task => task.id === source.id)).toBe(false);
    const copy = spyOn(fileIO, "copyFile").mockRejectedValue(new Error("Copy still refused"));
    try {
      await world.engine["cleanup"].removeCaptures(source.id);
      expect(existsSync(join(world.data, "captures", source.id, "pic.png"))).toBe(true);
      await reopen(world);
      await world.engine["followUps"].catchUp();
      expect(world.engine.task(source.id)!.findings[0]!.tracking).toEqual({ reason: "pictures", retry: true });
      expect(world.engine.s.followUpPending).toEqual([{ keys: [key], cardId: automaticId }]);
    } finally { copy.mockRestore(); }
    const checks = world.prompts.length;
    const c = new Coordination(world.engine);
    const args = { taskId: source.id, findingId: "old", targetTaskId: automaticId, requestId: `retired-${reason}` };
    const different = await c.call("task.track-finding", { ...args, targetTaskId: manualId, requestId: `retired-different-${reason}` });
    expect(different.outcome).toBe("invalid");
    const result = await c.call("task.track-finding", args);
    expect(result.outcome).toBe("completed");
    expect(await c.call("task.track-finding", args)).toEqual(result);
    expect(world.prompts).toHaveLength(checks);
    expect(world.engine.s.followUpPending).toEqual([]);
    expect(world.engine.task(source.id)!.findings[0]!.tracking).toEqual({ taskId: automaticId });
    expect(world.engine.task(manualId)!.followUp).toBeUndefined();
    await world.engine["cleanup"].removeCaptures(source.id);
    expect(existsSync(join(world.data, "captures", source.id))).toBe(false);
    await reopen(world);
    expect(world.engine.task(automaticId)!.followUp!.reports).toHaveLength(1);
    expect(world.engine.task(automaticId)!.session.flatMap(line => line.images ?? [])).toHaveLength(1);
    expect(readdirSync(join(world.data, "captures", automaticId))).toHaveLength(1);
  } finally { release(); await world.engine.shutdown(); }
});

it("finishes an archived assignment only after its original pictures are gone, leaving the finished target unchanged", async () => {
  const world = await open();
  let release = () => {};
  try {
    const saved = await failedAssignment(world, "no-choice");
    release = saved.release;
    const { source, automaticId, manualId } = saved;
    world.engine.task(automaticId)!.state = "done";
    release();
    world.engine.save();
    const before = structuredClone(world.engine.task(automaticId));
    const c = new Coordination(world.engine);
    const args = { taskId: source.id, findingId: "old", targetTaskId: automaticId, requestId: "closed-assignment" };
    const pictured = await c.call("task.track-finding", args);
    expect(pictured.outcome).toBe("invalid");
    expect(pictured.message).toContain("pictures");
    expect((await c.call("task.track-finding", { ...args, targetTaskId: manualId, requestId: "closed-different" })).outcome).toBe("invalid");
    await world.engine["cleanup"].removeCaptures(source.id);
    expect(existsSync(join(world.data, "captures", source.id))).toBe(false);
    expect((await c.call("task.track-finding", { ...args, requestId: "closed-no-pictures" })).outcome).toBe("completed");
    expect(world.engine.task(automaticId)).toEqual(before);
    expect(world.engine.task(source.id)!.findings[0]!.tracking).toEqual({ taskId: automaticId });
    await reopen(world);
    expect(world.engine.task(automaticId)).toEqual(before);
    expect(world.engine.task(manualId)!.followUp).toBeUndefined();
    expect(cards(world.engine)).toHaveLength(0);
  } finally { release(); await world.engine.shutdown(); }
});

it("withdraws a picture retry when its report is fixed instead of retaining an unfinished credit", async () => {
  const world = await open();
  let release = () => {};
  try {
    const saved = await failedAssignment(world, "no-choice");
    release = saved.release;
    saved.source.findings[0]!.status = "fixed";
    await world.engine["followUps"].catchUp();
    expect(world.engine.s.followUpPending).toEqual([]);
    expect(world.engine.task(saved.automaticId)!.followUp!.reports).toEqual([]);
    expect(world.engine.task(saved.source.id)!.findings[0]!.tracking).toBeUndefined();
    release();
    await world.engine["cleanup"].removeCaptures(saved.source.id);
    expect(existsSync(join(world.data, "captures", saved.source.id))).toBe(false);
  } finally { release(); await world.engine.shutdown(); }
});

for (const reason of ["unavailable", "no-choice"] as const) it(`finishes the existing ${reason} assignment by hand without crediting another target`, async () => {
  const world = await open();
  let release = () => {};
  try {
    const { engine } = world;
    const saved = await failedAssignment(world, reason);
    release = saved.release;
    const { source, automaticId, manualId, key } = saved;
    const c = new Coordination(engine);
    expect(engine.task(source.id)!.findings[0]!.tracking).toEqual({ reason: "pictures", retry: true });
    expect(engine.task(automaticId)!.followUp!.reports.map(report => report.findingId)).toEqual(["old"]);
    expect(engine.task(automaticId)!.session.flatMap(line => line.images ?? [])).toEqual([]);
    expect(engine.s.followUpPending).toEqual([{ keys: [key], cardId: automaticId }]);
    const before = structuredClone([source.findings, engine.task(automaticId), engine.task(manualId), engine.s.followUpPending]);
    const checks = world.prompts.length;
    const args = { taskId: source.id, findingId: "old", targetTaskId: manualId, requestId: `pending-${reason}` };
    const result = await c.call("task.track-finding", args);
    expect(result.outcome).toBe("invalid");
    expect(result.message).toContain("another task");
    expect(await c.call("task.track-finding", args)).toEqual(result);
    expect([source.findings, engine.task(automaticId), engine.task(manualId), engine.s.followUpPending]).toEqual(before);
    expect(world.prompts).toHaveLength(checks);
    expect((await c.call("task.track-finding", { taskId: source.id, findingId: "old", targetTaskId: automaticId, requestId: `complete-${reason}` })).outcome).toBe("completed");
    expect(engine.task(source.id)!.findings[0]!.tracking).toEqual({ taskId: automaticId });
    expect(engine.task(manualId)!.followUp).toBeUndefined();
    const images = engine.task(automaticId)!.session.flatMap(line => line.images ?? []);
    expect(images).toHaveLength(1);
    expect(readdirSync(join(engine.dataDir, "captures", automaticId))).toHaveLength(1);
    expect((await c.call("task.track-finding", { taskId: source.id, findingId: "old", targetTaskId: automaticId, requestId: `finished-${reason}` })).outcome).toBe("completed");
    await engine["followUps"].beforeRemoval(source);
    release();
    await engine["cleanup"].removeCaptures(source.id);
    expect(existsSync(join(engine.dataDir, "captures", source.id))).toBe(false);
    expect(existsSync(join(engine.dataDir, "captures", automaticId, `${images[0]!.id}.png`))).toBe(true);
    await reopen(world);
    await world.engine["followUps"].catchUp();
    expect(world.engine.task(source.id)!.findings[0]!.tracking).toEqual({ taskId: automaticId });
    expect(cards(world.engine).filter(task => task.followUp!.reports.some(report => report.taskId === source.id && report.findingId === "old")).map(task => task.id)).toEqual([automaticId]);
    expect(world.engine.task(automaticId)!.session.flatMap(line => line.images ?? [])).toHaveLength(1);
  } finally { release(); await world.engine.shutdown(); }
});

it("leaves a manual report untracked after copying or saving fails and safely retries with a fresh reference", async () => {
  const world = await open();
  try {
    const { engine } = world;
    const source = settledSource(engine, world.shop);
    plant(engine, source.id, source.findings[0]!.text);
    const targetId = engine.addTask({ productId: world.shop, kind: "bug", title: "Manual target", backlog: true });
    const c = new Coordination(engine);
    const args = { taskId: source.id, findingId: "old", targetTaskId: targetId, requestId: "copy-failed" };
    const copy = spyOn(fileIO, "copyFile").mockRejectedValue(new Error("Copy refused"));
    try {
      const result = await c.call("task.track-finding", args);
      expect(result.outcome).toBe("invalid");
      expect(result.message).toContain("pictures could not be copied");
    } finally { copy.mockRestore(); }
    expect(engine.task(source.id)!.findings[0]!.tracking).toEqual({ reason: "no-choice" });
    expect(engine.task(targetId)!.followUp).toBeUndefined();
    expect((await c.call("task.track-finding", args)).outcome).toBe("invalid");
    const originalSave = engine.save.bind(engine);
    let saves = 0;
    const save = spyOn(engine, "save").mockImplementation((...args) => {
      if (saves++ === 0) throw new Error("Save refused");
      return originalSave(...args);
    });
    try {
      const result = await c.call("task.track-finding", { ...args, requestId: "save-failed" });
      expect(result.outcome).toBe("invalid");
      expect(result.message).toContain("Save refused");
    } finally { save.mockRestore(); }
    expect(engine.task(source.id)!.findings[0]!.tracking).toEqual({ reason: "no-choice" });
    expect(engine.task(targetId)!.followUp).toBeUndefined();
    expect(engine.task(targetId)!.session.flatMap(line => line.images ?? [])).toEqual([]);
    expect(readdirSync(join(engine.dataDir, "captures", targetId))).toEqual([]);
    expect((await c.call("task.track-finding", { ...args, requestId: "copy-retried" })).outcome).toBe("completed");
    expect(engine.task(targetId)!.session.flatMap(line => line.images ?? [])).toHaveLength(1);
    expect(readdirSync(join(engine.dataDir, "captures", targetId))).toHaveLength(1);
    engine.task(targetId)!.state = "done";
    await engine["cleanup"].removeCaptures(targetId);
    expect(existsSync(join(engine.dataDir, "captures", targetId))).toBe(false);
    await engine["followUps"].beforeRemoval(engine.task(source.id)!);
    await engine["cleanup"].removeCaptures(source.id);
    expect(existsSync(join(engine.dataDir, "captures", source.id))).toBe(false);
  } finally { await world.engine.shutdown(); }
});

it("leaves a report untracked when the match cannot be settled, then links one card when it can", async () => {
  let mode: "unsure" | "down" | "same" = "unsure";
  const world = await open((prompt) => {
    if (mode === "down") return "unavailable";
    if (mode === "unsure") return { groups: [], uncertain: keysOf(prompt) };
    return groupByBug(prompt);
  });
  const { engine } = world;
  try {
    const one = taskOf(engine, world.shop, "Date", [older("one", "bug-lost: The date is wrong.")]);
    const two = taskOf(engine, world.shop, "Year", [older("two", "bug-lost: The year is wrong.")]);
    await finish(engine, one);
    await finish(engine, two);
    expect(cards(engine)).toHaveLength(0);
    expect(one.findings[0]!.tracking).toEqual({ reason: "unmatched" });
    expect(two.findings[0]!.tracking).toEqual({ reason: "unmatched" });
    mode = "same";
    await engine["followUps"].catchUp();
    expect(cards(engine)).toHaveLength(0);
    expect(one.findings[0]!.tracking).toEqual({ reason: "unmatched" });

    mode = "down";
    const pictured = "bug-held: The footer opens a retired page.";
    const held = taskOf(engine, world.shop, "Held", [older("held", pictured)]);
    const heldToo = taskOf(engine, world.shop, "Held too", [older("held-too", "bug-held: About in the footer is retired.")]);
    plant(engine, held.id, pictured);
    await finish(engine, held);
    await finish(engine, heldToo);
    expect(cards(engine)).toHaveLength(0);
    expect(held.findings[0]!.tracking).toEqual({ reason: "unavailable", retry: true });
    await engine["cleanup"].removeCaptures(held.id);
    expect(existsSync(join(engine.dataDir, "captures", held.id))).toBe(false);
    mode = "same";
    await engine["followUps"].catchUp();
    const card = cardFor(engine, "held");
    expect(card).toHaveLength(1);
    expect(card[0]!.followUp!.reports).toHaveLength(2);
    expect(card[0]!.session.some((line) => line.images?.length)).toBe(false);
    expect(existsSync(join(engine.dataDir, "captures", card[0]!.id))).toBe(false);
    await engine["followUps"].catchUp();
    expect(cardFor(engine, "held")).toHaveLength(1);
  } finally { await engine.shutdown(); }
});

it("retries a partial picture copy without attaching successful images again", async () => {
  const world = await open();
  const { engine } = world;
  const source = taskOf(engine, world.shop, "Two pictures", [older("partial", "bug-partial: The footer opens a retired page.")]);
  plant(engine, source.id, source.findings[0]!.text);
  source.journey![0]!.agentResults![0]!.images!.push({ id: "second", caption: "The other view" });
  writeFileSync(join(engine.dataDir, "captures", source.id, "second.png"), "png");
  const original = fileIO.copyFile;
  let fail = true;
  const copy = spyOn(fileIO, "copyFile").mockImplementation(async (from, to, mode) => {
    if (String(from).endsWith("second.png") && fail) throw new Error("Copy unavailable");
    return original(from, to, mode);
  });
  try {
    await finish(engine, source);
    const card = cardFor(engine, "partial")[0]!;
    expect(card.session.flatMap(line => line.images ?? [])).toHaveLength(1);
    expect(source.findings[0]!.tracking).toEqual({ reason: "pictures", retry: true });
    fail = false;
    await engine["followUps"].catchUp();
    const images = card.session.flatMap(line => line.images ?? []);
    expect(images).toHaveLength(2);
    expect(new Set(images.map(image => image.from!.imageId))).toEqual(new Set(["pic", "second"]));
    expect(readdirSync(join(engine.dataDir, "captures", card.id))).toHaveLength(2);
    expect(engine.task(source.id)!.findings[0]!.tracking).toEqual({ taskId: card.id });
    await engine["followUps"].catchUp();
    expect(card.session.flatMap(line => line.images ?? [])).toHaveLength(2);
  } finally { copy.mockRestore(); await engine.shutdown(); }
});

it("keeps a report's picture on the unfinished follow-up, then removes it when that follow-up is finished or cancelled", async () => {
  const world = await open();
  const { engine } = world;
  try {
    const text = "bug-photo: The footer opens a retired page.";
    const source = taskOf(engine, world.shop, "Pictured", [older("photo", text)]);
    plant(engine, source.id, text);
    const nit = taskOf(engine, world.shop, "Nit picture", [older("nit", "bug-nit: A small footer note.", { severity: "suggestion" })]);
    plant(engine, nit.id, "bug-nit: A small footer note.");
    await finish(engine, source);
    await finish(engine, nit);
    const card = cardFor(engine, "photo")[0]!;
    const image = card.session.flatMap((line) => line.images ?? [])[0]!;
    expect(image.caption).toBe("The retired page");
    expect(image.from).toEqual({ taskId: source.id, imageId: "pic" });
    const copy = join(engine.dataDir, "captures", card.id, `${image.id}.png`);
    expect(existsSync(copy)).toBe(true);
    expect(readdirSync(join(engine.dataDir, "captures", card.id))).toHaveLength(1);
    await engine["followUps"].catchUp();
    expect(readdirSync(join(engine.dataDir, "captures", card.id))).toHaveLength(1);
    await engine["cleanup"].removeCaptures(source.id);
    await engine["cleanup"].removeCaptures(nit.id);
    expect(existsSync(join(engine.dataDir, "captures", source.id))).toBe(false);
    expect(existsSync(copy)).toBe(true);
    expect(cardFor(engine, "nit")).toHaveLength(0);

    await reopen(world);
    const again = world.engine.task(card.id)!;
    const kept = again.session.flatMap((line) => line.images ?? [])[0]!;
    const keptFile = join(world.engine.dataDir, "captures", card.id, `${kept.id}.png`);
    await waitFor(() => existsSync(keptFile) && !existsSync(join(world.engine.dataDir, "captures", source.id)), "the follow-up picture to outlive the original task");
    again.state = "done";
    await world.engine["cleanup"].removeCaptures(card.id);
    expect(existsSync(keptFile)).toBe(false);

    const cancelledText = "bug-drop: The footer opens a retired page.";
    const dropped = taskOf(world.engine, world.shop, "Dropped picture", [older("drop", cancelledText)]);
    plant(world.engine, dropped.id, cancelledText);
    await finish(world.engine, dropped);
    const dropCard = cardFor(world.engine, "drop")[0]!;
    expect(existsSync(join(world.engine.dataDir, "captures", dropCard.id))).toBe(true);
    world.engine.cancel(dropCard.id);
    await waitFor(() => !existsSync(join(world.engine.dataDir, "captures", dropCard.id)), "the cancelled follow-up picture to be removed");
  } finally { await world.engine.shutdown(); }
});

it("adds a product while the card waits, and only records one named after work has started", async () => {
  const world = await open(groupByBug, true);
  const { engine } = world;
  try {
    const shared = taskOf(engine, world.shop, "Both products", [older("shared", "bug-shared: The footer fails for both products.", { productIds: [world.shop, world.notes] })]);
    await finish(engine, shared);
    expect(cardFor(engine, "shared")[0]!.selectedProducts?.map((choice) => choice.productId)).toEqual([world.shop, world.notes]);
    expect(cardFor(engine, "shared")[0]!.approvePlan).toBe(true);
    engine.setProductDelivery(world.shop, "local", false);
    engine.setProductDelivery(world.notes, "local", true);
    const first = taskOf(engine, world.shop, "Shop footer", [older("shop", "bug-wide: The footer opens a retired page.", { productIds: [world.shop] })]);
    await finish(engine, first);
    const card = cardFor(engine, "wide")[0]!;
    expect(card.selectedProducts?.map((choice) => choice.productId)).toEqual([world.shop]);
    expect(card.approveDelivery).toBe(false);
    const edited = "Coordinator wording for the footer.";
    engine.updateBacklog(card.id, { title: card.title, description: edited });
    const extra = taskOf(engine, world.notes, "Notes footer", [older("notes", "bug-wide: Notes has the same retired footer page.", { productIds: [world.shop, world.notes] })]);
    await finish(engine, extra);
    expect(card.selectedProducts?.map((choice) => choice.productId)).toEqual([world.shop, world.notes]);
    expect(card.approvePlan).toBe(true);
    expect(card.followUp!.alsoReported).toBeUndefined();
    expect(card.approveDelivery).toBe(true);
    expect(card.description).toBe(edited);
    expect(cardFor(engine, "wide")).toHaveLength(1);
    expect(cards(engine)).toHaveLength(2);

    const queued = taskOf(engine, world.shop, "Queued footer", [older("queued", "bug-queued: The footer opens a retired page.", { productIds: [world.shop] })]);
    await finish(engine, queued);
    const queuedCard = cardFor(engine, "queued")[0]!;
    engine.queueTask(queuedCard.id);
    expect(queuedCard.state).toBe("queued");
    expect(queuedCard.startedAt).toBeUndefined();
    const after = taskOf(engine, world.notes, "After start", [older("after", "bug-queued: Notes shows the same retired page.", { productIds: [world.shop, world.notes] })]);
    await finish(engine, after);
    expect(queuedCard.selectedProducts?.map((choice) => choice.productId)).toEqual([world.shop]);
    expect(queuedCard.followUp!.alsoReported).toEqual([world.notes]);
    expect(queuedCard.approveDelivery).toBe(false);
    expect(cardFor(engine, "queued")).toHaveLength(1);

    queuedCard.state = "done";
    const returned = taskOf(engine, world.shop, "Returned", [older("returned", "bug-queued: The retired footer page is back.")]);
    await finish(engine, returned);
    const fresh = cardFor(engine, "queued").filter((task) => task.id !== queuedCard.id);
    expect(fresh).toHaveLength(1);
    expect(fresh[0]!.state).toBe("backlog");
    expect(fresh[0]!.followUp!.reports.map((report) => report.findingId)).toEqual(["returned"]);
    expect(queuedCard.followUp!.reports.map((report) => report.findingId)).not.toContain("returned");
  } finally { await engine.shutdown(); }
});

it("does not open a second card when a link is saved only part-way", async () => {
  const world = await open();
  const { engine } = world;
  try {
    const task = taskOf(engine, world.shop, "Pending", [older("one", "bug-pending: The footer opens a retired page.")]);
    task.state = "done";
    const key = followUpKey(task.id, "one");
    const before = world.prompts.length;
    engine.s.followUpPending = [{ keys: [key] }];
    await engine["followUps"].catchUp();
    expect(world.prompts.length).toBe(before);
    expect(cardFor(engine, "pending")).toHaveLength(1);
    expect(engine.task(task.id)!.findings[0]!.tracking).toEqual({ taskId: cardFor(engine, "pending")[0]!.id });

    const other = taskOf(engine, world.shop, "Pending too", [older("two", "bug-pending: About in the footer is retired.")]);
    other.state = "done";
    const card = cardFor(engine, "pending")[0]!;
    engine.s.followUpPending = [{ keys: [key, followUpKey(other.id, "two")], cardId: card.id }];
    await engine["followUps"].catchUp();
    expect(world.prompts.length).toBe(before);
    expect(cardFor(engine, "pending")).toHaveLength(1);
    expect(engine.task(other.id)!.findings[0]!.tracking).toEqual({ taskId: card.id });
    expect(card.followUp!.reports.map((report) => report.findingId).sort()).toEqual(["one", "two"]);

    await Promise.all([engine["followUps"].noteDone(task), engine["followUps"].noteDone(other)]);
    expect(cardFor(engine, "pending")).toHaveLength(1);
  } finally { await engine.shutdown(); }
});

it("keeps independent classifications separate and requires explicit identity for agreement", async () => {
  const world = await open();
  const { engine } = world;
  try {
    const review = async (task: ReturnType<typeof taskOf>, severity: "pre-existing" | "important", by: string, key: string) => {
      await engine["reviews"]["applyReview"](executionFor(task), STAGE, ReviewResult.parse({ verdict: "fail", findings: [{ text: "bug-clash: The footer opens a retired page.", severity, evidence: EVIDENCE, steps: STEPS }] }), by, "code-reviewer", key);
    };
    for (const first of ["pre-existing", "important"] as const) {
      const task = taskOf(engine, world.shop, `${first} first`, []);
      await review(task, first, "opus-high", "0");
      await review(task, first === "important" ? "pre-existing" : "important", "sol-high", "1");
      expect(task.findings).toHaveLength(2);
      expect(new Set(task.findings.map((finding) => finding.id)).size).toBe(2);
      expect(task.findings.map((finding) => finding.severity).sort()).toEqual(["blocking", "pre-existing"]);
      expect(task.findings.every((finding) => finding.confirmedBy.length === 0)).toBe(true);
      expect(engine["reviews"]["pendingVote"](task, STAGE)?.findings).toHaveLength(1);
    }
    const once = taskOf(engine, world.shop, "Two blind important reports", []);
    await review(once, "important", "opus-high", "0"); await review(once, "important", "sol-high", "1");
    expect(once.findings).toHaveLength(2);
    expect(engine["reviews"]["pendingVote"](once, STAGE)?.findings).toHaveLength(2);
    await engine["reviews"]["applyReview"](executionFor(once), STAGE, ReviewResult.parse({ verdict: "fail", confirms: [{ id: once.findings[0]!.id, evidence: EVIDENCE }] }), "sol-high", "code-reviewer", "1");
    expect(once.findings[0]!.confirmedBy).toEqual(["sol-high"]);
    expect(engine["reviews"]["pendingVote"](once, STAGE)?.findings.map((finding) => finding.id)).toEqual([once.findings[1]!.id]);

    const settled = older("settled", "bug-clash: The footer opens a retired page.", {
      verification: { by: "sol-high", verdict: "pre-existing", reason: "The previous version already opened the retired page.", at: 5 },
      votes: [{ by: "grok-high", toolId: "grok", verdict: "pre-existing", reason: "The footer was already wrong before this change." }],
    });
    const task = taskOf(engine, world.shop, "Checked as older", [settled]);
    await finish(engine, task);
    expect(cardFor(engine, "clash")).toHaveLength(1);
    expect(cardFor(engine, "clash")[0]!.description.match(/The footer was already wrong before this change\./g)).toHaveLength(1);
    expect(cardFor(engine, "clash")[0]!.description).toContain(settled.verification!.reason);
    expect(cardFor(engine, "clash")[0]!.description).toContain(settled.votes![0]!.reason);
    const thin = taskOf(engine, world.shop, "No steps", [older("thin", "bug-thin: The footer opens a retired page.", { steps: undefined, evidence: undefined, verification: settled.verification, votes: settled.votes })]);
    await finish(engine, thin);
    expect(thin.findings[0]!.tracking).toEqual({ reason: "missing-steps" });
    expect(cardFor(engine, "thin")).toHaveLength(0);
  } finally { await engine.shutdown(); }
});

it("asks the reviewer's tool once when two wordings need a match", async () => {
  const root = tempDir("petrina-follow-up-agent-");
  roots.push(root);
  const fakes = new Fakes(join(root, "agents"));
  fakes.scenario({ followUpMatch: "same" });
  const engine = new Engine(join(root, "data"), { agentCommand: () => [process.execPath, join(import.meta.dir, "fake-agent.ts"), fakes.dir] });
  engine.setPoolPaused(true);
  let counted = false;
  const unsubscribe = engine.subscribe(() => { if (engine.s.backgroundAgents?.length) counted = true; });
  try {
    await engine["followUps"].catchUp();
    const shop = await engine.addProduct(await makeProduct(root), "Shop");
    const task = taskOf(engine, shop, "Two reviewers", [
      older("one", "bug-agent: The footer opens a retired page."),
      older("two", "bug-agent: Choosing About still lands on the old page.", { raisedBy: "sol-high", roleId: "security-reviewer" }),
    ]);
    engine.setPoolPaused(false);
    await finish(engine, task);
    expect(cards(engine)).toHaveLength(1);
    expect(cards(engine)[0]!.followUp!.reports.map((report) => report.findingId).sort()).toEqual(["one", "two"]);
    expect(task.findings.every((finding) => finding.tracking && "taskId" in finding.tracking && finding.tracking.taskId === cards(engine)[0]!.id)).toBe(true);
    expect(fakes.prompts().some((prompt) => prompt.includes("Which older reports are the same bug"))).toBe(true);
    expect(counted).toBe(true);
    expect(engine.s.backgroundAgents).toEqual([]);
    expect(readdirSync(join(engine.dataDir, "matching"))).toEqual([]);
  } finally { unsubscribe(); await engine.shutdown(); }
});

it("stays in the backlog until the coordinator queues it, then starts", async () => {
  const world = await open();
  const { engine } = world;
  try {
    const task = taskOf(engine, world.shop, "Ready footer", [older("ready", "bug-ready: The footer opens a retired page.")]);
    await finish(engine, task);
    const card = cards(engine)[0]!;
    engine.setPoolPaused(false);
    engine.schedule();
    expect(card.state).toBe("backlog");
    expect(card.startedAt).toBeUndefined();
    expect(engine.drivers.size).toBe(0);
    engine.queueTask(card.id);
    await waitFor(() => engine.task(card.id)!.startedAt !== undefined, "the queued follow-up to start");
    expect(cards(engine)).toHaveLength(1);
  } finally { await engine.shutdown(); }
});

it("waits until every reviewer has answered before tracking an older bug, and drops the credit if it becomes Important", async () => {
  const world = await open();
  const { engine } = world;
  try {
    const review = async (task: ReturnType<typeof taskOf>, text: string, severity: "pre-existing" | "important", by: string, key: string) => {
      const result = ReviewResult.parse({ verdict: "fail", findings: [{ text, severity, evidence: EVIDENCE, steps: STEPS }] });
      await engine["reviews"]["applyReview"](executionFor(task), STAGE, result, by, "code-reviewer", key);
    };
    const plan = { stages: [STAGE], rationale: "Review it", plannerProfileId: "opus-high" };
    const still = taskOf(engine, world.shop, "Still reviewing", []);
    still.plan = plan;
    still.state = "running";
    still.hunt = { stageId: STAGE.id, round: 1, reported: {}, findings: 0 };
    await review(still, "bug-split: The footer opens a retired page.", "pre-existing", "opus-high", "0");
    still.hunt = { ...still.hunt, reported: { "0": true } };
    const done = taskOf(engine, world.shop, "Already done", [older("done", "bug-split: About in the footer is the old page.")]);
    await finish(engine, done);
    const card = cardFor(engine, "split")[0]!;
    expect(card.followUp!.reports.map((report) => report.findingId)).toEqual(["done"]);
    expect(still.findings[0]!.tracking).toBeUndefined();

    await review(still, "bug-split: The footer opens a retired page.", "important", "sol-high", "1");
    expect(still.findings).toHaveLength(2);
    expect(still.findings[1]!.severity).toBe("blocking");
    // A completed verifier can reclassify the older report itself; similar prose cannot.
    still.findings[0]!.severity = "blocking";
    still.findings[0]!.verification = { by: "sol-high", verdict: "real", reason: "This exact report reproduces only on the changed version.", at: Date.now() };
    await engine["followUps"].catchUp();
    expect(card.followUp!.reports.map((report) => report.findingId)).toEqual(["done"]);
    expect(still.findings[0]!.tracking).toBeUndefined();

    const sample = card.followUp!.reports[0]!;
    card.followUp!.reports.push({ ...sample, taskId: still.id, findingId: still.findings[0]!.id, text: still.findings[0]!.text });
    still.findings[0]!.tracking = { taskId: card.id };
    await engine["followUps"].catchUp();
    expect(card.followUp!.reports.map((report) => report.findingId)).toEqual(["done"]);
    expect(still.findings[0]!.tracking).toBeUndefined();

    const early = taskOf(engine, world.shop, "Judged first", []);
    early.plan = plan;
    early.state = "running";
    early.hunt = { stageId: STAGE.id, round: 1, reported: {}, findings: 0 };
    await review(early, "bug-early: The footer opens a retired page.", "pre-existing", "opus-high", "0");
    await review(early, "bug-early: The footer opens a retired page.", "important", "sol-high", "1");
    const other = taskOf(engine, world.shop, "Other done", [older("other", "bug-early: The footer opens a retired page.")]);
    await finish(engine, other);
    expect(cardFor(engine, "early")[0]!.followUp!.reports.map((report) => report.findingId)).toEqual(["other"]);
    expect(early.findings[0]!.tracking).toBeUndefined();

    const agreed = taskOf(engine, world.shop, "Both agreed", [older("agreed", "bug-agreed: The footer opens a retired page.", { judgments: [{ by: "opus-high", severity: "pre-existing", at: 1 }, { by: "sol-high", severity: "pre-existing", at: 2 }] })]);
    agreed.plan = plan;
    agreed.state = "running";
    agreed.hunt = { stageId: STAGE.id, round: 1, reported: { "0": true, "1": true }, findings: 0 };
    const later = taskOf(engine, world.shop, "Later done", [older("later", "bug-agreed: About in the footer is the old page.")]);
    await finish(engine, later);
    expect(cardFor(engine, "agreed")[0]!.followUp!.reports.map((report) => report.findingId).sort()).toEqual(["agreed", "later"]);
    expect(agreed.findings[0]!.tracking).toEqual({ taskId: cardFor(engine, "agreed")[0]!.id });

    // Raised before this round, and only one of the two reviewers has answered.
    const olderRound = taskOf(engine, world.shop, "Reviewed again", [older("again", "bug-round: The footer opens a retired page.")]);
    olderRound.plan = plan;
    olderRound.state = "running";
    olderRound.hunt = { stageId: STAGE.id, round: 2, reported: { "0": true }, findings: 1 };
    const roundDone = taskOf(engine, world.shop, "Round done", [older("done-round", "bug-round: About in the footer is the old page.")]);
    await finish(engine, roundDone);
    expect(cardFor(engine, "round")[0]!.followUp!.reports.map((report) => report.findingId)).toEqual(["done-round"]);
    expect(olderRound.findings[0]!.tracking).toBeUndefined();

    const both = taskOf(engine, world.shop, "Round agreed", [older("round-agreed", "bug-roundready: The footer opens a retired page.")]);
    both.plan = plan;
    both.state = "running";
    both.hunt = { stageId: STAGE.id, round: 2, reported: { "0": true, "1": true }, findings: 1 };
    const roundLater = taskOf(engine, world.shop, "Round later", [older("round-later", "bug-roundready: About in the footer is the old page.")]);
    await finish(engine, roundLater);
    expect(cardFor(engine, "roundready")[0]!.followUp!.reports.map((report) => report.findingId).sort()).toEqual(["round-agreed", "round-later"]);
    expect(both.findings[0]!.tracking).toEqual({ taskId: cardFor(engine, "roundready")[0]!.id });
  } finally { await engine.shutdown(); }
});

it("keeps a refused picture on the original task until a later pass copies it", async () => {
  const world = await open();
  const { engine } = world;
  try {
    const text = "bug-copy: The footer opens a retired page.";
    const source = taskOf(engine, world.shop, "Copied later", [older("copy", text)]);
    plant(engine, source.id, text);
    chmodSync(join(engine.dataDir, "captures", source.id, "pic.png"), 0);
    await finish(engine, source);
    const card = cardFor(engine, "copy")[0]!;
    expect(source.findings[0]!.tracking).toEqual({ reason: "pictures", retry: true });
    expect(card.session.some((line) => line.images?.length)).toBe(false);
    expect(existsSync(join(engine.dataDir, "captures", source.id, "pic.png"))).toBe(true);
    await engine["cleanup"].removeCaptures(source.id);
    expect(existsSync(join(engine.dataDir, "captures", source.id, "pic.png"))).toBe(true);
    chmodSync(join(engine.dataDir, "captures", source.id, "pic.png"), 0o644);
    await engine["followUps"].catchUp();
    const image = card.session.flatMap((line) => line.images ?? [])[0]!;
    expect(image.from).toEqual({ taskId: source.id, imageId: "pic" });
    expect(readdirSync(join(engine.dataDir, "captures", card.id))).toHaveLength(1);
    expect(engine.task(source.id)!.findings[0]!.tracking).toEqual({ taskId: card.id });
    await engine["cleanup"].removeCaptures(source.id);
    expect(existsSync(join(engine.dataDir, "captures", source.id))).toBe(false);
    expect(existsSync(join(engine.dataDir, "captures", card.id, `${image.id}.png`))).toBe(true);
    await reopen(world);
    const again = world.engine.task(card.id)!;
    const kept = again.session.flatMap((line) => line.images ?? [])[0]!;
    expect(existsSync(join(world.engine.dataDir, "captures", card.id, `${kept.id}.png`))).toBe(true);
    expect(existsSync(join(world.engine.dataDir, "captures", source.id))).toBe(false);
    expect(world.engine.task(source.id)!.findings[0]!.tracking).toEqual({ taskId: card.id });
  } finally { await world.engine.shutdown(); }
});

it("keeps a matching retry until the link is saved, including when saving the link is interrupted", async () => {
  let mode: "down" | "same" = "same";
  const world = await open((prompt) => mode === "down" ? "unavailable" : groupByBug(prompt));
  const { engine } = world;
  try {
    const known = taskOf(engine, world.shop, "Known card", [older("known", "bug-retry: The footer opens a retired page.")]);
    await finish(engine, known);
    const card = cardFor(engine, "retry")[0]!;
    mode = "down";
    const held = taskOf(engine, world.shop, "Held report", [older("held", "bug-retry: About in the footer is the old page.")]);
    await finish(engine, held);
    expect(held.findings[0]!.tracking).toEqual({ reason: "unavailable", retry: true });
    expect(engine.s.followUpPending?.some((group) => group.retry && group.keys.includes(followUpKey(held.id, "held")))).toBe(true);
    mode = "same";
    let interrupt = false;
    const stop = engine.subscribe(() => {
      if (!interrupt) return;
      interrupt = false;
      throw new Error("interrupted after the follow-up was saved");
    });
    interrupt = true;
    await engine["followUps"].catchUp();
    stop();
    expect(engine.task(held.id)!.findings[0]!.tracking).toEqual({ reason: "unavailable", retry: true });
    expect(card.followUp!.reports.map((report) => report.findingId)).toEqual(["known"]);
    await reopen(world);
    const restored = cardFor(world.engine, "retry");
    expect(restored).toHaveLength(1);
    expect(restored[0]!.id).toBe(card.id);
    expect(restored[0]!.followUp!.reports.map((report) => report.findingId).sort()).toEqual(["held", "known"]);
    expect(world.engine.task(held.id)!.findings[0]!.tracking).toEqual({ taskId: card.id });
    await reopen(world);
    expect(cardFor(world.engine, "retry")).toHaveLength(1);
    expect(world.engine.task(held.id)!.findings[0]!.tracking).toEqual({ taskId: card.id });
  } finally { await world.engine.shutdown(); }
});

it("uses the card's state when the match returns, so a cancel or a queue is not lost", async () => {
  let waiting: { prompt: string; resolve: (answer: MatchAnswer) => void } | undefined;
  const world = await open((prompt) => new Promise((resolve) => { waiting = { prompt, resolve }; }), true);
  const { engine } = world;
  try {
    const known = taskOf(engine, world.shop, "Open card", [older("known", "bug-live: The footer opens a retired page.", { productIds: [world.shop] })]);
    await finish(engine, known);
    const card = cardFor(engine, "live")[0]!;

    const queued = taskOf(engine, world.notes, "Queued during the match", [older("queued", "bug-live: Notes shows the same retired page.", { productIds: [world.shop, world.notes] })]);
    waiting = undefined;
    const queueing = finish(engine, queued);
    await waitFor(() => waiting !== undefined, "the queue match to start");
    engine.queueTask(card.id);
    expect(card.state).toBe("queued");
    waiting!.resolve(groupByBug(waiting!.prompt));
    await queueing;
    expect(card.followUp!.reports.map((report) => report.findingId).sort()).toEqual(["known", "queued"]);
    expect(card.selectedProducts?.map((choice) => choice.productId)).toEqual([world.shop]);
    expect(card.followUp!.alsoReported).toEqual([world.notes]);
    expect(queued.findings[0]!.tracking).toEqual({ taskId: card.id });

    const cancelled = taskOf(engine, world.shop, "Cancelled during the match", [older("cancelled", "bug-live: The footer page is still retired.")]);
    waiting = undefined;
    const cancelling = finish(engine, cancelled);
    await waitFor(() => waiting !== undefined, "the cancel match to start");
    engine.cancel(card.id);
    expect(card.state).toBe("cancelled");
    waiting!.resolve(groupByBug(waiting!.prompt));
    await cancelling;
    expect(cancelled.findings[0]!.tracking && "taskId" in cancelled.findings[0]!.tracking && cancelled.findings[0]!.tracking.taskId).not.toBe(card.id);
    expect(card.followUp!.reports.map((report) => report.findingId)).not.toContain("cancelled");
    const fresh = cardFor(engine, "live").filter((task) => task.id !== card.id);
    expect(fresh).toHaveLength(1);
    expect(fresh[0]!.state).toBe("backlog");
    expect(fresh[0]!.followUp!.reports.map((report) => report.findingId)).toEqual(["cancelled"]);
    expect(cancelled.findings[0]!.tracking).toEqual({ taskId: fresh[0]!.id });
  } finally { await engine.shutdown(); }
});

it("does not mark a report tracked when it becomes Important while the match is running", async () => {
  let waiting: { prompt: string; resolve: (answer: MatchAnswer) => void } | undefined;
  const world = await open((prompt) => new Promise((resolve) => { waiting = { prompt, resolve }; }));
  const { engine } = world;
  try {
    const first = taskOf(engine, world.shop, "Already tracked", [older("first", "bug-flip: The footer opens a retired page.")]);
    await finish(engine, first);
    const card = cardFor(engine, "flip")[0]!;
    expect(waiting).toBeUndefined();
    const second = taskOf(engine, world.shop, "Flipped during the match", [older("second", "bug-flip: About in the footer is the old page.", { judgments: [{ by: "opus-high", severity: "pre-existing", at: 1 }, { by: "sol-high", severity: "pre-existing", at: 2 }] })]);
    waiting = undefined;
    const finishing = finish(engine, second);
    await waitFor(() => waiting !== undefined, "the match to start");
    second.findings[0]!.severity = "blocking";
    waiting!.resolve(groupByBug(waiting!.prompt));
    await finishing;
    expect(card.followUp!.reports.map((report) => report.findingId)).toEqual(["first"]);
    expect(engine.task(second.id)!.findings[0]!.severity).toBe("blocking");
    expect(engine.task(second.id)!.findings[0]!.judgments?.map((entry) => entry.severity)).toEqual(["pre-existing", "pre-existing"]);
    expect(engine.task(second.id)!.findings[0]!.tracking).toBeUndefined();
  } finally { await engine.shutdown(); }
});

it("keeps a picture that could not be copied until a later try, including after a restart", async () => {
  const world = await open();
  const { engine } = world;
  try {
    const blockedText = "bug-held: The footer opens a retired page.";
    const clearText = "bug-clear: The header opens a retired page.";
    const blocked = taskOf(engine, world.shop, "Held picture", [older("held", blockedText)]);
    const clear = taskOf(engine, world.shop, "Clear picture", [older("clear", clearText)]);
    plant(engine, blocked.id, blockedText);
    plant(engine, clear.id, clearText);
    chmodSync(join(engine.dataDir, "captures", blocked.id, "pic.png"), 0);
    await finish(engine, blocked);
    await finish(engine, clear);
    expect(blocked.findings[0]!.tracking).toEqual({ reason: "pictures", retry: true });
    expect(clear.findings[0]!.tracking && "taskId" in clear.findings[0]!.tracking).toBe(true);
    await reopen(world);
    await world.engine["cleanup"].removeCaptures(blocked.id);
    await world.engine["cleanup"].removeCaptures(clear.id);
    expect(existsSync(join(world.engine.dataDir, "captures", blocked.id, "pic.png"))).toBe(true);
    expect(world.engine.task(blocked.id)!.findings[0]!.tracking).toEqual({ reason: "pictures", retry: true });
    expect(cardFor(world.engine, "held")[0]!.session.some((line) => line.images?.length)).toBe(false);
    const clearCard = cardFor(world.engine, "clear")[0]!;
    const clearImage = clearCard.session.flatMap((line) => line.images ?? [])[0]!;
    expect(existsSync(join(world.engine.dataDir, "captures", clearCard.id, `${clearImage.id}.png`))).toBe(true);
    chmodSync(join(world.engine.dataDir, "captures", blocked.id, "pic.png"), 0o644);
    await world.engine["followUps"].catchUp();
    const heldCard = cardFor(world.engine, "held")[0]!;
    const image = heldCard.session.flatMap((line) => line.images ?? [])[0]!;
    expect(image.from).toEqual({ taskId: blocked.id, imageId: "pic" });
    expect(readdirSync(join(world.engine.dataDir, "captures", heldCard.id))).toHaveLength(1);
    expect(world.engine.task(blocked.id)!.findings[0]!.tracking).toEqual({ taskId: heldCard.id });
    await world.engine["cleanup"].removeCaptures(blocked.id);
    expect(existsSync(join(world.engine.dataDir, "captures", blocked.id))).toBe(false);
    expect(existsSync(join(world.engine.dataDir, "captures", heldCard.id, `${image.id}.png`))).toBe(true);
  } finally { await world.engine.shutdown(); }
});

it("takes back the product, the picture and the request when a later review says this change caused it", async () => {
  const world = await open(groupByBug, true);
  const { engine } = world;
  try {
    const shopText = "bug-cause: The footer opens a retired page.";
    const notesText = "bug-cause: Notes shows the same retired page.";
    const shop = taskOf(engine, world.shop, "Shop footer", [older("shop", shopText, { productIds: [world.shop] })]);
    const notes = taskOf(engine, world.notes, "Notes footer", [older("notes", notesText, {
      productIds: [world.shop, world.notes],
      judgments: [{ by: "opus-high", severity: "pre-existing", at: 1 }, { by: "sol-high", severity: "pre-existing", at: 2 }],
    })]);
    plant(engine, shop.id, shopText);
    plant(engine, notes.id, notesText);
    notes.plan = { stages: [STAGE], rationale: "Review it", plannerProfileId: "opus-high" };
    notes.state = "running";
    notes.hunt = { stageId: STAGE.id, round: 1, reported: { "0": true, "1": true }, findings: 0 };
    await finish(engine, shop);
    const card = cardFor(engine, "cause")[0]!;
    expect(card.followUp!.reports.map((report) => report.findingId).sort()).toEqual(["notes", "shop"]);
    expect(card.selectedProducts?.map((choice) => choice.productId).sort()).toEqual([world.notes, world.shop].sort());
    expect(card.approvePlan).toBe(true);
    expect(card.description).toContain(notesText);
    expect(card.description).toContain(shopText);
    const copied = card.session.flatMap((line) => line.images ?? []);
    expect(copied.map((image) => image.from?.taskId).sort()).toEqual([notes.id, shop.id].sort());
    notes.findings[0]!.severity = "blocking";
    await engine["followUps"].catchUp();
    expect(card.followUp!.reports.map((report) => report.findingId)).toEqual(["shop"]);
    expect(card.selectedProducts?.map((choice) => choice.productId)).toEqual([world.shop]);
    expect(card.approvePlan).toBe(false);
    expect(card.description).toContain(shopText);
    expect(card.description).not.toContain(notesText);
    expect(card.followUp!.alsoReported).toBeUndefined();
    const kept = card.session.flatMap((line) => line.images ?? []);
    expect(kept.map((image) => image.from?.taskId)).toEqual([shop.id]);
    expect(existsSync(join(engine.dataDir, "captures", card.id, `${kept[0]!.id}.png`))).toBe(true);
    expect(copied.filter((image) => image.from?.taskId === notes.id).every((image) => !existsSync(join(engine.dataDir, "captures", card.id, `${image.id}.png`)))).toBe(true);
    expect(engine.task(notes.id)!.findings[0]!.tracking).toBeUndefined();
    expect(engine.task(shop.id)!.findings[0]!.tracking).toEqual({ taskId: card.id });
    notes.state = "done";
    notes.column = "done";
    notes.finishedAt = Date.now();
    await engine["cleanup"].removeCaptures(notes.id);
    expect(existsSync(join(engine.dataDir, "captures", notes.id))).toBe(false);
    expect(existsSync(join(engine.dataDir, "captures", card.id, `${kept[0]!.id}.png`))).toBe(true);
  } finally { await engine.shutdown(); }
});


it("leaves matching retryable when all model slots are occupied", async () => {
  const world = await open();
  try {
    await reopen(world, false);
    const engine = world.engine;
    const source = taskOf(engine, world.shop, "Matching at capacity", [
      older("one", "bug-capacity: The old page is broken."),
      older("two", "bug-capacity: The same old page is broken.", { raisedBy: "sol-high" }),
    ]);
    engine.s.pool.limit = 1;
    engine.s.backgroundAgents = [{ id: "other", roleId: "verifier", profileId: "sol-high", label: "Already comparing", since: Date.now() }];
    engine.setPoolPaused(false);
    await finish(engine, source);
    expect(cards(engine)).toHaveLength(0);
    expect(source.findings[0]!.tracking).toEqual({ reason: "unavailable", retry: true });
    expect(new Fakes(join(world.root, "agents")).prompts()).toEqual([]);
    engine.s.backgroundAgents = [];
    await engine["followUps"].catchUp();
    expect(engine.s.backgroundAgents).toEqual([]);
  } finally { await world.engine.shutdown(); }
});
