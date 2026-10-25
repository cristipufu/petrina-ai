import { nativeCoordinatorTask } from "../../fixtures/coordinator-native.js";
import { expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ConversationNote, JourneyAgentInput, StepNote } from "@petrina/core";
import type { z } from "zod";
import { BriefResult, BuildResult, ObjectionsResult, ReviewResult } from "../../../src/roles.js";
import { routeMessages } from "@petrina/core";
import { prepareReviewInput, type ReviewInput } from "../../../src/review-context.js";
import { historyGuidance } from "../../../src/review-history.js";
import { makeProduct, waitFor } from "../../fixtures.js";

const notesTitle = "The coordinator's notes on this task (preserve product decisions; read each instruction in its original step)";
const note = (id: string, text = `EXACT-DECISION-${id}: keep the agreed product behaviour.`) => ({
  id, at: Number(id.replace(/\D/g, "")) || 1, text, origin: { stageTitle: `Decision ${id}`, roleName: "Coordinator" },
});
const oldNotes = () => [note("n1"), note("n2"), note("n3"), note("n4")];
const hash = (text: string) => createHash("sha256").update(text).digest("hex");

async function fixture(builtIn: "builder" | "architect" | "design-reviewer" | "code-reviewer" = "builder", peer = false, initialNotes = oldNotes()) {
  const { root, repo, fakes, engine, task, scope, dispose: close } = await nativeCoordinatorTask("petrina-note-continuation-", "Keep every coordinator decision", { builder: "plain", architect: "plain", reopen: "resume", controlled: true }, "ORIGINAL-NOTE-TASK");
  try {
    // Added role ids must obey the same result contract as their built-in counterparts.
    const role = { ...engine.role(builtIn)!, id: `notes-${builtIn}` };
    engine.s.roles.push(role);
    const schema: z.ZodType<unknown> = role.result === "build" ? BuildResult : role.result === "brief" ? BriefResult : role.result === "objections" ? ObjectionsResult : ReviewResult;
    const design = role.result === "brief" || role.result === "objections";
    const parallel = role.result === "findings";
    const copies = [repo, ...(peer ? [await makeProduct(join(root, "peer"))] : [])];
    task.plan = { rationale: "Exercise the assigned role", plannerProfileId: "sol-high", stages: [{ id: "work", title: "Current work", kind: "do", roleId: role.id, profileIds: ["sol-high"] }] };
    task.stageIndex = 0; task.state = "running"; task.holdsSlot = true;
    task.brief = { summary: "UNCHANGED-NOTE-BRIEF", forUsers: [], areas: [], acceptance: [{ text: "Preserve every decision" }], risks: [] };
    task.notes = initialNotes;
    if (parallel) task.hunt = { stageId: "work", round: 1, reported: {}, profiles: { "0": "sol-high", ...(peer ? { "1": "astra-xhigh" } : {}) } };
    const controllers: AbortController[] = [];
    const pending: Promise<unknown>[] = [];
    let completed: ConversationNote | undefined;
    let review: ReviewInput | undefined;
    const given = async (member?: string) => [
      ...await engine["context"].sectionsFor(scope, role.id, member, undefined, undefined, review),
      ...(design ? [{ title: "Objections from the design reviewer", body: "UNCHANGED-DESIGN-OBJECTION" }, { title: "The coordinator's call", body: "UNCHANGED-DESIGN-CALL" }] : []),
    ];
    const run = async (resume?: ConversationNote, seat = 0, earlier: readonly StepNote[] = []) => {
      if (!parallel && fakes.received().length) engine.finishStep(scope);
      if (earlier.length) {
        task.stepNotes = earlier.map(entry => ({ ...entry }));
        scope.work.stepAttempts = 1;
      }
      const index = fakes.received().length;
      const controller = new AbortController(); controllers.push(controller);
      const profile = seat ? "astra-xhigh" : "sol-high";
      task.state = "running"; task.holdsSlot = true;
      task.agent = { roleId: role.id, profileId: "sol-high", since: Date.now(), step: 0 };
      const result = parallel
        ? engine["turns"].parallel(scope, role.id, profile, copies[seat]!, () => given(`review-${seat}`), schema, controller.signal,
          { key: String(seat), member: `review-${seat}`, reviewerKey: String(seat), seat: profile, reviewContext: true, ...(review ? { reviewFindings: review.findings } : {}), ...(resume ? { resume } : {}), completed: saved => { completed = structuredClone(saved); } })
        : engine["turns"].turn(scope, role.id, "sol-high", () => given(), schema, controller.signal, { ...(resume ? { resume } : {}), ...(design ? { designContext: true } : {}) });
      pending.push(result); result.catch(() => {});
      const opening = await waitFor(() => fakes.received()[index], "the recorded note opening", undefined, { during: result });
      writeFileSync(join(fakes.dir, `release-${opening.session}`), "go");
      await result;
      const saved = structuredClone(parallel ? completed! : scope.work.conversation!);
      const input = task.journey!.at(-1)!.agentInputs!.at(-1)!;
      expect(readFileSync(input.exact!.file, "utf8")).toBe(opening.text);
      return { opening, saved, input };
    };
    const dispose = async () => {
      controllers.forEach(controller => controller.abort());
      await Promise.allSettled(pending);
      await close();
    };
    return { engine, task, scope, fakes, run, dispose, role, data: join(root, "data"), setReview: (input: ReviewInput) => { review = input; } };
  } catch (error) { await close(); throw error; }
}

function completeNotes(saved: ConversationNote, notes: readonly ReturnType<typeof note>[]) {
  const packet = readFileSync(saved.context!.file, "utf8");
  expect(hash(packet)).toBe(saved.context!.digest);
  let position = -1;
  for (const entry of notes) {
    const heading = `Recorded during “${entry.origin.stageTitle}” (${entry.origin.roleName}):\n${entry.text}`;
    expect(packet.split(heading)).toHaveLength(2);
    expect(packet.indexOf(heading)).toBeGreaterThan(position);
    position = packet.indexOf(heading);
  }
}

function truthfulOmissions(input: JourneyAgentInput, ids: string[]) {
  expect(input.manifest!.filter(entry => entry.kind === "omitted" && entry.noteId).map(entry => entry.noteId)).toEqual(ids);
  const section = input.sections.find(section => section.title === notesTitle)!;
  expect(input.manifest!.find(entry => entry.name === notesTitle && entry.kind === "text")?.size).toBe(section.body.length);
}

for (const builtIn of ["builder", "architect", "design-reviewer", "code-reviewer"] as const) it(`sends only new background notes on the ${builtIn} result contract's managed return`, async () => {
  const f = await fixture(builtIn);
  try {
    const first = await f.run();
    const added = note("n5");
    f.task.notes = [...f.task.notes!, added];
    const receipts = structuredClone(f.task.queued);
    const lines = structuredClone(f.task.session);
    const next = await f.run(first.saved);
    expect(next.input.mode).toBe("continued");
    expect(next.opening.session).toBe(first.opening.session);
    expect(next.opening.text).toContain("latest wins where they conflict");
    expect(next.opening.text).toContain("Read it before acting if context is missing or was compacted");
    expect(next.opening.text.split(added.text)).toHaveLength(2);
    expect(next.opening.text).toContain(`Recorded during “${added.origin.stageTitle}” (${added.origin.roleName}):\n${added.text}`);
    const notes = next.input.sections.find(section => section.title === notesTitle)!.body;
    for (const [index, entry] of f.task.notes!.entries()) {
      expect(notes).toContain(`${index + 1}. ${entry.id}`);
      expect(notes).toContain(entry.origin!.stageTitle);
    }
    for (const entry of oldNotes()) expect(next.opening.text).not.toContain(entry.text);
    expect(notes).toContain("full text below (new)");
    expect(notes).toContain("unchanged in the saved complete context");
    completeNotes(next.saved, [...oldNotes(), added]);
    truthfulOmissions(next.input, oldNotes().map(entry => entry.id));
    expect(f.task.queued).toEqual(receipts);
    expect(f.task.session.filter(line => line.from === "you")).toEqual(lines.filter(line => line.from === "you"));
    if (builtIn === "architect" || builtIn === "design-reviewer") {
      expect(next.opening.text).toContain("UNCHANGED-DESIGN-OBJECTION");
      expect(next.opening.text).toContain("UNCHANGED-DESIGN-CALL");
    }
    const replay = await f.run(next.saved);
    expect(replay.input.sections.some(section => section.title === notesTitle)).toBe(false);
    for (const entry of f.task.notes!) expect(replay.opening.text).not.toContain(entry.text);
    completeNotes(replay.saved, [...oldNotes(), added]);
  } finally { await f.dispose(); }
});

it("delivers a new waiting note once without replaying old decisions or changing their receipts", async () => {
  const f = await fixture();
  try {
    const first = await f.run();
    const text = "NEW-WAITING-DECISION: preserve all earlier choices.";
    const id = f.engine.sendMessage(f.task.id, text, "queue")!;
    const receipt = f.task.queued[0]!;
    const next = await f.run(first.saved);
    expect(next.opening.text.split(text)).toHaveLength(2);
    expect(next.input.sections.find(section => section.title === "Messages from the coordinator, in order")?.body).toBe(`1. ${text}`);
    const notes = next.input.sections.find(section => section.title === notesTitle)!.body;
    expect(notes).toContain(id);
    expect(notes).toContain("waiting as a coordinator message");
    expect(notes).not.toContain(text);
    for (const entry of oldNotes()) expect(next.opening.text).not.toContain(entry.text);
    expect(receipt.deliveries?.main).toEqual(expect.objectContaining({ state: "applied", via: "prompt", sessionId: first.opening.session }));
    expect(f.task.queued).toEqual([]);
    expect(f.task.session.filter(line => line.coordinatorMessageId === id)).toHaveLength(1);
    truthfulOmissions(next.input, oldNotes().map(entry => entry.id));
    const packet = readFileSync(next.saved.context!.file, "utf8");
    for (const entry of [...oldNotes(), { text }]) expect(packet.split(entry.text)).toHaveLength(2);
    const replay = await f.run(next.saved);
    expect(replay.opening.text).not.toContain(text);
    expect(f.task.session.filter(line => line.coordinatorMessageId === id)).toHaveLength(1);
  } finally { await f.dispose(); }
});

it("sends revisions over earlier-attempt versions, current order and withdrawals in its actual managed opening", async () => {
  const f = await fixture();
  try {
    const first = await f.run();
    const original = oldNotes();
    const changedText = { ...original[1]!, text: "CHANGED-SECOND-DECISION: preserve the revised choice." };
    const changedStep = { ...original[3]!, origin: { stageTitle: "Revised decision step", roleName: "Coordinator" } };
    // Identical words under another recorded id are a separate decision, never semantic matches.
    const inserted = note("n6", original[0]!.text);
    const current = [changedStep, original[0]!, inserted, changedText];
    f.task.notes = current;
    const earlier = original.slice(1).map(entry => ({ id: entry.id, text: entry.text, at: 1, kind: "message" as const }));
    const next = await f.run(first.saved, 0, earlier);
    const notes = next.input.sections.find(section => section.title === notesTitle)!.body;
    expect(notes).toContain("No longer applying: n3.");
    expect(notes).toContain("full text below (changed)");
    for (const id of [changedText.id, changedStep.id]) {
      const indexed = notes.split("\n").find(line => /^\d+\. /.test(line) && line.includes(`${id}:`))!;
      expect(indexed).toContain("full text below (changed)");
      expect(indexed).not.toContain("already carried");
    }
    for (const [index, entry] of current.entries()) expect(notes).toContain(`${index + 1}. ${entry.id}`);
    expect(next.opening.text).toContain(changedText.text);
    expect(next.opening.text).not.toContain(original[1]!.text);
    expect(next.opening.text).toContain(`Recorded during “Revised decision step” (Coordinator):\n${changedStep.text}`);
    expect(next.opening.text.split(original[0]!.text)).toHaveLength(2);
    expect(next.opening.text).not.toContain(original[2]!.text);
    completeNotes(next.saved, current);
    truthfulOmissions(next.input, ["n1"]);
    // Failure to reopen preserves the complete current notes as fresh background.
    f.fakes.scenario({ builder: "plain", controlled: true });
    const fresh = await f.run(next.saved);
    expect(fresh.input.mode).toBe("fresh");
    expect(fresh.opening.session).not.toBe(first.opening.session);
    for (const entry of current) expect(fresh.opening.text).toContain(entry.text);
    expect(fresh.opening.text).not.toContain("unchanged in the saved complete context");
    completeNotes(fresh.saved, current);
  } finally { await f.dispose(); }
});

it("compares each parallel seat with its own notes and keeps new broadcast receipts separate", async () => {
  const f = await fixture("code-reviewer", true);
  try {
    const first = await f.run();
    const intermediate = note("n5");
    f.task.notes = [...f.task.notes!, intermediate];
    const peer = await f.run(undefined, 1);
    const text = "BROADCAST-NEW-DECISION: each reviewer must hear this once.";
    const id = f.engine.sendMessage(f.task.id, text, "queue")!;
    routeMessages(f.task, ["review-0", "review-1"]);
    const receipt = f.task.queued[0]!;
    const returned = await f.run(first.saved);
    expect(returned.opening.text.split(intermediate.text)).toHaveLength(2);
    expect(returned.opening.text.split(text)).toHaveLength(2);
    expect(receipt.recipients).toEqual({ "review-0": true, "review-1": false });
    expect(receipt.deliveries?.["review-0"]).toEqual(expect.objectContaining({ state: "applied", sessionId: first.opening.session }));
    expect(receipt.deliveries?.["review-1"]).toBeUndefined();
    truthfulOmissions(returned.input, oldNotes().map(entry => entry.id));
    const peerReturned = await f.run(peer.saved, 1);
    expect(peerReturned.opening.text).not.toContain(intermediate.text);
    expect(peerReturned.opening.text.split(text)).toHaveLength(2);
    expect(receipt.recipients).toEqual({ "review-0": true, "review-1": true });
    expect(receipt.deliveries?.["review-1"]).toEqual(expect.objectContaining({ state: "applied", sessionId: peer.opening.session }));
    truthfulOmissions(peerReturned.input, [...oldNotes(), intermediate].map(entry => entry.id));
    expect(f.task.queued).toEqual([]);
    expect(f.task.session.filter(line => line.coordinatorMessageId === id)).toHaveLength(1);
    for (const result of [returned, peerReturned]) {
      const packet = readFileSync(result.saved.context!.file, "utf8");
      for (const entry of [...oldNotes(), intermediate, { text }]) expect(packet.split(entry.text)).toHaveLength(2);
    }
  } finally { await f.dispose(); }
});

it("keeps queued delivery separate from whole-section omission when a note has no recorded id", async () => {
  const f = await fixture();
  try {
    f.task.notes![1]!.id = undefined;
    const first = await f.run();
    const text = "QUEUED-WITH-AN-IDLESS-NOTE: preserve the original product choices.";
    const id = f.engine.sendMessage(f.task.id, text, "queue")!;
    const receipt = f.task.queued[0]!;
    const changed = await f.run(first.saved);
    const notes = changed.input.sections.find(section => section.title === notesTitle)!.body;
    for (const entry of oldNotes()) expect(notes.split(entry.text)).toHaveLength(2);
    expect(changed.opening.text.split(text)).toHaveLength(2);
    expect(notes).not.toContain(text);
    expect(changed.input.sections.find(section => section.title === "Messages from the coordinator, in order")?.body).toBe(`1. ${text}`);
    expect(receipt.deliveries?.main).toEqual(expect.objectContaining({ state: "applied", sessionId: first.opening.session }));
    const deliveries = structuredClone(receipt.deliveries);

    const unchanged = await f.run(changed.saved);
    expect(unchanged.input.sections.some(section => section.title === notesTitle)).toBe(false);
    expect(unchanged.input.manifest).toContainEqual(expect.objectContaining({ name: notesTitle, kind: "omitted", size: 0 }));
    expect(unchanged.input.manifest!.some(entry => entry.noteId)).toBe(false);
    for (const entry of [...oldNotes(), { text }]) expect(unchanged.opening.text).not.toContain(entry.text);
    expect(receipt.deliveries).toEqual(deliveries);
    expect(f.task.queued).toEqual([]);
    expect(f.task.session.filter(line => line.coordinatorMessageId === id)).toHaveLength(1);
    const packet = readFileSync(unchanged.saved.context!.file, "utf8");
    expect(hash(packet)).toBe(unchanged.saved.context!.digest);
    for (const entry of [...oldNotes(), { text }]) expect(packet.split(entry.text)).toHaveLength(2);
  } finally { await f.dispose(); }
});

it("combines managed note deltas with frozen review history without retaining unused warm copies", async () => {
  const f = await fixture("code-reviewer");
  try {
    const finding = { id: "settled", text: "The earlier issue", severity: "blocking" as const, raisedBy: "sol-high", roleId: f.role.id, status: "fixed" as const, confirmedBy: [], evidence: "ORIGINAL-REVIEW-EVIDENCE ".repeat(100), answer: { fixed: true, text: "The dated Builder claim", at: 10 } };
    const card = { id: "follow-up", title: "The earlier follow-up", productIds: ["p"], problem: "ORIGINAL-FOLLOW-UP-DETAIL ".repeat(100) };
    f.task.findings = [finding];
    f.task.journey = [{ id: "examined", kind: "agent", stageId: "work", roleId: f.role.id, round: 1, sub: 0, startedAt: 20, endedAt: 30, result: { findings: [finding], findingsSettled: true, findingChanges: { claimedFixed: [finding.id], raised: [], fixed: [finding.id], dismissed: [] } } }];
    f.task.plan!.stages[0]!.kind = "review-chain";
    const freeze = async (round: number, cards: ReviewInput["cards"]) => {
      f.task.rounds = { work: round };
      const input = await f.engine["context"].captureReview(f.scope);
      input.cards = cards;
      const ref = await prepareReviewInput(f.data, f.scope, input, new AbortController().signal);
      expect(input.history?.findings).toHaveProperty(finding.id);
      f.task.hunt = { id: `note-history-round-${round}`, stageId: "work", round, reported: {}, profiles: { "0": "sol-high" }, input: ref };
      f.setReview(input);
      return input;
    };
    const initial = await freeze(2, [card]);
    const first = await f.run();
    expect(first.input.mode).toBe("fresh");
    expect(first.opening.text.split(historyGuidance(initial.history!))).toHaveLength(2);
    expect(first.opening.text).not.toContain(finding.evidence);
    expect(first.opening.text).not.toContain(card.problem);
    expect(f.task.journey!.filter(step => step.reviewHistory)).toHaveLength(1);
    const retained = structuredClone(f.task.journey!.at(-1)!.reviewHistory!);
    expect(JSON.parse(retained.body).cards[card.id]).toEqual(card);
    expect(JSON.parse(retained.body).findings[finding.id]).toContain(finding.evidence);
    completeNotes(first.saved, oldNotes());

    f.engine.finishStep(f.scope);
    const added = note("n5");
    f.task.notes = [...f.task.notes!, added];
    await freeze(3, [card]);
    const next = await f.run(first.saved);
    expect(next.input.mode).toBe("continued");
    expect(next.opening.text.split(added.text)).toHaveLength(2);
    for (const old of oldNotes()) expect(next.opening.text).not.toContain(old.text);
    expect(next.opening.text).toContain("Current finding status index");
    expect(next.input.sections.some(section => section.title === "Open follow-up cards")).toBe(false);
    expect(next.opening.text).not.toContain(historyGuidance(initial.history!));
    expect(f.task.journey!.at(-1)!.reviewHistory).toBeUndefined();
    expect(f.task.journey!.filter(step => step.reviewHistory).map(step => step.reviewHistory)).toEqual([retained]);
    truthfulOmissions(next.input, oldNotes().map(entry => entry.id));
    completeNotes(next.saved, [...oldNotes(), added]);
    const packet = readFileSync(next.saved.context!.file, "utf8");
    expect(packet).toContain(finding.evidence);
    expect(packet).toContain(card.problem);

    f.engine.finishStep(f.scope);
    const changed = { ...card, problem: `${card.problem}CHANGED-FOLLOW-UP-TAIL` };
    const changedInput = await freeze(4, [changed]);
    const changedCard = await f.run(next.saved);
    expect(changedCard.opening.text).toContain(changed.problem);
    expect(changedCard.opening.text).not.toContain(historyGuidance(changedInput.history!));
    expect(f.task.journey!.at(-1)!.reviewHistory).toBeUndefined();
    expect(f.task.journey!.filter(step => step.reviewHistory).map(step => step.reviewHistory)).toEqual([retained]);
    for (const entry of f.task.notes!) expect(changedCard.opening.text).not.toContain(entry.text);
    completeNotes(changedCard.saved, [...oldNotes(), added]);
  } finally { await f.dispose(); }
});

for (const scenario of ["warm background", "warm waiting message", "fresh"] as const) it(`measures the five-note replay in an actual ${scenario} Builder opening`, async () => {
  // Replay the measured note sizes without storing another task's private instructions.
  const lengths = [2_314, 3_617, 1_877, 2_942, 2_226];
  const notes = lengths.map((length, index) => note(`n${index + 1}`, `EXACT-MEASURED-DECISION-${index + 1}: `.padEnd(length, String(index + 1))));
  expect(notes.map(entry => entry.text.length)).toEqual(lengths);
  const pair: { opening: number; notes: number; packet: number; snapshotJson: number; journeyJson: number }[] = [];
  for (const policy of ["complete-note control", "note-by-note"] as const) {
    const f = await fixture("builder", false, scenario === "fresh" ? notes : notes.slice(0, 4));
    try {
      const previous = scenario === "fresh" ? undefined : (await f.run()).saved;
      if (previous && policy === "complete-note control") {
        // The legacy snapshot has section hashes only. Its safe full-note fallback
        // reproduces the pre-change supplied text through the real managed turn.
        delete previous.context!.noteHashes;
      }
      if (scenario === "warm waiting message") {
        f.engine.sendMessage(f.task.id, notes[4]!.text, "queue");
        // Replaying an archived instruction keeps the step where it was recorded.
        f.task.notes!.at(-1)!.origin = notes[4]!.origin;
      } else f.task.notes = notes;
      const recorded = await f.run(previous);
      expect(recorded.input.mode).toBe(scenario === "fresh" ? "fresh" : "continued");
      const current = f.task.notes!;
      const packet = readFileSync(recorded.saved.context!.file, "utf8");
      completeNotes(recorded.saved, current as ReturnType<typeof note>[]);
      expect(current.map(entry => entry.text)).toEqual(notes.map(entry => entry.text));
      expect(hash(readFileSync(recorded.input.exact!.file, "utf8"))).toBe(recorded.input.exact!.digest);
      expect(recorded.input.exact!.size).toBe(recorded.opening.text.length);
      const body = recorded.input.sections.find(section => section.title === notesTitle)!.body;
      const full = scenario === "fresh" || policy === "complete-note control";
      for (const entry of notes.slice(0, 4)) {
        if (full) expect(recorded.opening.text.split(entry.text)).toHaveLength(2);
        else expect(recorded.opening.text).not.toContain(entry.text);
      }
      expect(recorded.opening.text.split(notes[4]!.text)).toHaveLength(2);
      if (scenario === "warm waiting message") {
        expect(body).not.toContain(notes[4]!.text);
        expect(recorded.input.sections.find(section => section.title === "Messages from the coordinator, in order")?.body).toBe(`1. ${notes[4]!.text}`);
        expect(f.task.queued).toEqual([]);
        expect(f.task.session.filter(line => line.coordinatorMessageId === current[4]!.id)).toHaveLength(1);
      }
      if (!full) truthfulOmissions(recorded.input, notes.slice(0, 4).map(entry => entry.id));
      const snapshot = structuredClone(recorded.saved.context!);
      // Snapshot storage before the change used the same schema minus note hashes.
      if (policy === "complete-note control") delete snapshot.noteHashes;
      pair.push({ opening: recorded.opening.text.length, notes: body.length, packet: packet.length, snapshotJson: JSON.stringify(snapshot).length, journeyJson: JSON.stringify(recorded.input).length });
    } finally { await f.dispose(); }
  }
  const before = pair[0]!, after = pair[1]!;
  expect(after.packet).toBe(before.packet);
  expect(after.snapshotJson).toBeGreaterThan(before.snapshotJson);
  if (scenario === "fresh") {
    expect(after.opening).toBe(before.opening);
    expect(after.notes).toBe(before.notes);
    expect(after.journeyJson).toBe(before.journeyJson);
  } else {
    expect(before.opening - after.opening).toBeGreaterThan(9_000);
    expect(before.notes - after.notes).toBeGreaterThan(9_000);
    expect(before.journeyJson - after.journeyJson).toBeGreaterThan(9_000);
  }
  // Keep the evidence on its own line: Bun may hide properties attached to an assertion error.
  console.log("Coordinator note character measurements (controlled replay; token, cost and duration effects unmeasured):", JSON.stringify({ scenario, before, after, recoveredNotes: notes.length }));
});
