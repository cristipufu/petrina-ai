import { executionFor } from "../src/repository-context.js";
import { afterAll, expect, it, spyOn } from "bun:test";
import * as fileIO from "node:fs/promises";
import { chmodSync, existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { followUpKey, type DeepMutable, type Finding, type MatchAnswer } from "@petrina/core";
import { Engine } from "./engine.js";
import { ReviewResult } from "../src/roles.js";
import { checkReviewEvidence } from "../src/review.js";
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
  const shop = await engine.addProduct(makeProduct(root), "Shop");
  const notes = withNotes ? await engine.addProduct(makeProduct(join(root, "other")), "Notes") : "";
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

it("does not attach reports to a manual bug that was queued while matching", async () => {
  let queue = () => {};
  const world = await open(prompt => { queue(); return groupByBug(prompt); });
  try {
    const engine = world.engine;
    const id = engine.addTask({ productId: world.shop, kind: "bug", title: "bug-race: Existing manual bug", description: "Do not change this queued request", backlog: true });
    queue = () => { queue = () => {}; engine.queueTask(id); };
    const source = taskOf(engine, world.shop, "New sighting", [older("race", "bug-race: The same underlying bug")]);
    await finish(engine, source);
    expect(engine.task(id)!.state).toBe("queued");
    expect(engine.task(id)!.followUp).toBeUndefined();
    expect(engine.task(id)!.description).toBe("Do not change this queued request");
    expect(source.findings[0]!.tracking).toHaveProperty("taskId");
    expect(source.findings[0]!.tracking).not.toEqual({ taskId: id });
    expect(cards(engine)).toHaveLength(1);
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

it("follows a chosen card, keeps a refusal off it, and leaves a missing choice untracked", async () => {
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
    expect(silent.findings[0]!.tracking).toEqual({ reason: "no-choice" });
    expect(cards(engine).some((task) => task.followUp!.reports.some((report) => report.findingId === "silent"))).toBe(false);
  } finally { await engine.shutdown(); }
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
    expect(source.findings[0]!.tracking).toBeUndefined();
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
    const shop = await engine.addProduct(makeProduct(root), "Shop");
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
    expect(source.findings[0]!.tracking).toBeUndefined();
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
    expect(blocked.findings[0]!.tracking).toBeUndefined();
    expect(clear.findings[0]!.tracking && "taskId" in clear.findings[0]!.tracking).toBe(true);
    await reopen(world);
    await world.engine["cleanup"].removeCaptures(blocked.id);
    await world.engine["cleanup"].removeCaptures(clear.id);
    expect(existsSync(join(world.engine.dataDir, "captures", blocked.id, "pic.png"))).toBe(true);
    expect(world.engine.task(blocked.id)!.findings[0]!.tracking).toBeUndefined();
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
