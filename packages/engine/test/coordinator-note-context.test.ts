import { expect, it, spyOn } from "bun:test";
import { createHash } from "node:crypto";
import * as files from "node:fs/promises";
import { readFile, rm, writeFile } from "node:fs/promises";
import { BUILT_IN_ROLES, createDemoState, type BuilderContext, type Role, type Task } from "@petrina/core";
import { builderContext } from "../src/builder-context.js";
import { coordinatorNotes, type Section } from "../src/context.js";
import type { MTask } from "../src/kernel.js";
import { executionFor, repositoryView, restoreRepositoryState } from "../src/repository-context.js";
import { removeDir, tempDir } from "./fixtures.js";

const sha = (text: string) => createHash("sha256").update(text).digest("hex");
type Note = NonNullable<Task["notes"]>[number];
const note = (id: string, text: string, stageTitle = `Step for ${id}`): Note => ({ id, text, at: 1, origin: { stageId: `step-${id}`, stageTitle, roleName: "A participant", kind: "design" } });
const opening = (sections: readonly Section[]) => sections.map(section => `## ${section.title}\n${section.body}`).join("\n\n");
const noteSection = (sections: readonly Section[]) => sections.find(section => section.title.startsWith("The coordinator's notes"));

function fixture() {
  const root = tempDir("coordinator-note-context-");
  const task = structuredClone(createDemoState(1_000_000_000).tasks[0]!) as unknown as MTask;
  restoreRepositoryState(task);
  task.notes = []; task.queued = []; task.stepNotes = [];
  const scope = executionFor(task);
  const role = BUILT_IN_ROLES.find(entry => entry.result === "build")!;
  const sections = (member?: string, earlierCarried = false) => coordinatorNotes(scope, member, earlierCarried);
  const prepare = (previous?: BuilderContext, options: { sessionId?: string; role?: Role; member?: string; earlierCarried?: boolean; design?: boolean } = {}) => builderContext(root, repositoryView(scope), options.role ?? role, options.sessionId ?? "own-conversation", sections(options.member, options.earlierCarried), previous, { design: options.design });
  const setNotes = (notes: readonly Note[]) => { task.notes = structuredClone(notes) as NonNullable<MTask["notes"]>; };
  return { root, task, scope, role, sections, prepare, setNotes };
}

async function completePacket(snapshot: BuilderContext, notes: readonly Note[]) {
  const packet = await readFile(snapshot.file, "utf8");
  expect(sha(packet)).toBe(snapshot.digest);
  let offset = -1;
  for (const entry of notes) {
    expect(packet.split(entry.text)).toHaveLength(2);
    const found = packet.indexOf(entry.text);
    expect(found).toBeGreaterThan(offset);
    expect(packet.slice(offset + 1, found)).toContain(`Recorded during “${entry.origin!.stageTitle}”`);
    offset = found;
  }
  return packet;
}

it("sends a new background note once beside the complete ordered decision index and recovers every original note from the packet", async () => {
  const f = fixture();
  const earlier = [note("first", "FIRST ORIGINAL PRODUCT DECISION"), note("second", "SECOND ORIGINAL PRODUCT DECISION")];
  const added = note("new", "NEW PRODUCT DECISION", "Original design call");
  try {
    f.setNotes(earlier);
    const first = await f.prepare();
    f.setNotes([...earlier, added]);
    const next = await f.prepare(first.snapshot);
    const text = opening(next.sections), notes = noteSection(next.sections)!.body;
    expect(text.split(added.text)).toHaveLength(2);
    for (const entry of earlier) expect(text).not.toContain(entry.text);
    expect(notes).toContain(`Recorded during “${added.origin!.stageTitle}”`);
    expect(notes).toContain("latest wins");
    expect(text).toContain("compacted");
    const index = notes.split("\n").filter(line => /^\d+\. /.test(line));
    expect(index).toHaveLength(3);
    for (const [position, entry] of [...earlier, added].entries()) {
      expect(index[position]).toContain(entry.id!);
      expect(index[position]).toContain(entry.origin!.stageTitle);
    }
    expect(index[0]).toContain("saved");
    expect(index[2]).toContain("below");
    expect(next.omitted?.filter(entry => entry.noteId).map(entry => entry.noteId)).toEqual(["first", "second"]);
    for (const omitted of next.omitted!.filter(entry => entry.noteId)) expect(omitted.digest).toBe(first.snapshot!.noteHashes![omitted.noteId!]!);
    expect(Object.keys(next.snapshot!.noteHashes!)).toEqual(["first", "second", "new"]);
    for (const entry of [...earlier, added]) expect(JSON.stringify(next.snapshot)).not.toContain(entry.text);
    await completePacket(next.snapshot!, [...earlier, added]);
    // A reloaded snapshot alone preserves the comparison; no parallel cache is necessary.
    const replay = await f.prepare(JSON.parse(JSON.stringify(next.snapshot)));
    expect(noteSection(replay.sections)).toBeUndefined();
    for (const entry of [...earlier, added]) expect(opening(replay.sections)).not.toContain(entry.text);
    expect(replay.omitted?.filter(entry => entry.noteId).map(entry => entry.noteId)).toEqual(["first", "second", "new"]);
  } finally { removeDir(f.root); }
});

it("indexes a queued note as a coordinator message while preserving every delivery and conversation record", async () => {
  const f = fixture();
  const earlier = note("old", "PREVIOUSLY HEARD CONSTRAINT"), waiting = note("waiting", "WAITING PRODUCT GUIDANCE");
  try {
    f.setNotes([earlier]);
    const first = await f.prepare();
    f.setNotes([earlier, waiting]);
    f.task.queued.push({ id: waiting.id!, text: waiting.text, at: 2, recipients: { main: false, "review-1": false } });
    const before = structuredClone({ queued: f.task.queued, session: f.task.session, timeline: f.task.timeline });
    const next = await f.prepare(first.snapshot);
    const notes = noteSection(next.sections)!.body;
    expect(notes).toContain(waiting.id!);
    expect(notes).toContain("coordinator message");
    expect(notes).not.toContain(waiting.text);
    expect(notes).not.toContain(earlier.text);
    expect({ queued: f.task.queued, session: f.task.session, timeline: f.task.timeline }).toEqual(before);
    expect(next.omitted?.filter(entry => entry.noteId).map(entry => entry.noteId)).toEqual(["old"]);
    await completePacket(next.snapshot!, [earlier, waiting]);
  } finally { removeDir(f.root); }
});

it("sends changes to recorded text or original step, and distinguishes identical wording under different ids", async () => {
  const f = fixture();
  const earlier = note("old", "KEEP THIS DISTINCT DECISION"), changed = note("edited", "ORIGINAL WORDING"), step = note("step", "STEP SCOPED GUIDANCE");
  try {
    f.setNotes([earlier, changed, step]);
    const first = await f.prepare();
    const current = [earlier, { ...changed, text: "REVISED WORDING" }, { ...step, origin: { ...step.origin!, stageTitle: "A different original step" } }, note("different-id", earlier.text)];
    f.setNotes(current);
    const next = await f.prepare(first.snapshot);
    const notes = noteSection(next.sections)!.body;
    expect(notes.split(earlier.text)).toHaveLength(2);
    expect(notes).toContain("REVISED WORDING");
    expect(notes).not.toContain(changed.text);
    expect(notes).toContain(step.text);
    expect(notes).toContain("A different original step");
    const index = notes.split("\n").filter(line => /^\d+\. /.test(line));
    expect(index[1]).toContain("changed");
    expect(index[2]).toContain("changed");
    expect(next.omitted?.filter(entry => entry.noteId).map(entry => entry.noteId)).toEqual(["old"]);
    const packet = await readFile(next.snapshot!.file, "utf8");
    expect(packet.split(earlier.text)).toHaveLength(3);
    expect(packet).toContain(current[1]!.text);
    expect(packet).toContain(current[2]!.origin!.stageTitle);
  } finally { removeDir(f.root); }
});

it("compares each conversation's own exact records and ignores a timestamp-only change", async () => {
  const f = fixture();
  const firstNote = note("first", "THE FIRST SEAT HEARD THIS"), secondNote = note("second", "ONLY THE SECOND SEAT HEARD THIS"), thirdNote = note("third", "BOTH SEATS NEED THIS NEXT");
  try {
    f.setNotes([firstNote]);
    const firstSeat = await f.prepare(undefined, { sessionId: "seat-one" });
    f.setNotes([firstNote, secondNote]);
    const secondSeat = await f.prepare(undefined, { sessionId: "seat-two" });
    f.setNotes([{ ...firstNote, at: 999 }, secondNote, thirdNote]);
    const one = await f.prepare(firstSeat.snapshot, { sessionId: "seat-one" });
    const two = await f.prepare(secondSeat.snapshot, { sessionId: "seat-two" });
    expect(opening(one.sections)).not.toContain(firstNote.text);
    expect(opening(one.sections)).toContain(secondNote.text);
    expect(opening(one.sections)).toContain(thirdNote.text);
    expect(opening(two.sections)).not.toContain(firstNote.text);
    expect(opening(two.sections)).not.toContain(secondNote.text);
    expect(opening(two.sections)).toContain(thirdNote.text);
    expect(one.snapshot!.noteHashes!.first).toBe(firstSeat.snapshot!.noteHashes!.first);
    expect((await f.prepare(secondSeat.snapshot, { sessionId: "seat-one" })).sections).toEqual(f.sections());
    await completePacket(one.snapshot!, f.task.notes!);
    await completePacket(two.snapshot!, f.task.notes!);
  } finally { removeDir(f.root); }
});

it("makes changed order and withdrawals explicit without repeating unchanged bodies, including removal of the last note", async () => {
  const f = fixture();
  const notes = [note("first", "FIRST BODY"), note("second", "SECOND BODY"), note("third", "THIRD BODY")];
  try {
    f.setNotes(notes);
    const first = await f.prepare();
    f.setNotes([notes[2]!, notes[0]!]);
    const next = await f.prepare(first.snapshot);
    const text = opening(next.sections), body = noteSection(next.sections)!.body;
    const index = body.split("\n").filter(line => /^\d+\. /.test(line));
    expect(index[0]).toContain("third");
    expect(index[1]).toContain("first");
    expect(body).toContain("second");
    expect(body).toMatch(/no longer appl/i);
    for (const entry of notes) expect(text).not.toContain(entry.text);
    await completePacket(next.snapshot!, [notes[2]!, notes[0]!]);
    f.setNotes([]);
    const empty = await f.prepare(next.snapshot);
    const withdrawal = opening(empty.sections);
    expect(withdrawal).toContain("third");
    expect(withdrawal).toContain("first");
    expect(withdrawal).toMatch(/no longer appl/i);
    expect(await readFile(empty.snapshot!.file, "utf8")).not.toContain(notes[0]!.text);
  } finally { removeDir(f.root); }
});

it("records an order change even when distinct note ids have identical text and original steps", async () => {
  const f = fixture();
  const one = note("10", "IDENTICAL WORDS IN DISTINCT RECORDED DECISIONS", "Shared original step");
  const two = { ...one, id: "2" };
  try {
    f.setNotes([one, two]);
    const first = await f.prepare();
    f.setNotes([two, one]);
    const next = await f.prepare(first.snapshot);
    const notes = noteSection(next.sections);
    expect(notes).toBeDefined();
    const index = notes!.body.split("\n").filter(line => /^\d+\. /.test(line));
    expect(index[0]).toStartWith("1. 2:");
    expect(index[1]).toStartWith("2. 10:");
    expect(notes!.body).not.toContain(one.text);
    expect(sha(await readFile(next.snapshot!.file, "utf8"))).toBe(next.snapshot!.digest);
    expect((await f.prepare(next.snapshot)).sections.some(section => section.title.startsWith("The coordinator's notes"))).toBe(false);
  } finally { removeDir(f.root); }
});

it("keeps the full notes part when nothing can be omitted and separately names superseded recorded notes", async () => {
  const f = fixture();
  const old = note("old", "OLD DECISION TO WITHDRAW"), replacement = note("replacement", "COMPLETE REPLACEMENT DECISION");
  try {
    f.setNotes([old]);
    const first = await f.prepare();
    f.setNotes([replacement]);
    const next = await f.prepare(first.snapshot);
    expect(noteSection(next.sections)!.body).toBe(noteSection(f.sections())!.body);
    expect(next.sections.some(section => !section.title.startsWith("The coordinator's notes") && /no longer appl/i.test(section.title + section.body) && section.body.includes(old.id!))).toBe(true);
    expect(next.omitted?.some(entry => entry.noteId)).toBe(false);
    await completePacket(next.snapshot!, [replacement]);
    expect(await readFile(next.snapshot!.file, "utf8")).not.toContain(old.text);
  } finally { removeDir(f.root); }
});

it("sends newly visible notes at their original position, and never calls live or other-seat notes withdrawn", async () => {
  const f = fixture();
  const notes = [note("first", "FIRST HEARD BODY"), note("middle", "MIDDLE NEWLY VISIBLE BODY"), note("last", "LAST HEARD BODY")];
  try {
    f.setNotes(notes);
    f.task.queued.push({ id: "middle", text: notes[1]!.text, at: 2, recipients: { peer: false } });
    const first = await f.prepare(undefined, { member: "seat" });
    expect(opening(first.sections)).not.toContain(notes[1]!.text);
    f.task.queued = [];
    const visible = await f.prepare(first.snapshot, { member: "seat" });
    const body = noteSection(visible.sections)!.body;
    expect(body).toContain(notes[1]!.text);
    const index = body.split("\n").filter(line => /^\d+\. /.test(line));
    expect(index[1]).toContain("middle");
    for (const state of ["sending", "accepted", "unconfirmed"] as const) {
      f.task.queued = [{ id: "middle", text: notes[1]!.text, at: 2, recipients: { seat: false }, deliveries: { seat: { state, via: "live" } } }];
      const before = structuredClone(f.task.queued);
      const live = await f.prepare(visible.snapshot, { member: "seat" });
      expect(opening(live.sections)).not.toContain("middle");
      expect(opening(live.sections)).not.toContain(notes[1]!.text);
      expect(f.task.queued).toEqual(before);
      f.task.queued = [];
      const returned = await f.prepare(live.snapshot, { member: "seat" });
      expect(opening(returned.sections)).toContain(notes[1]!.text);
    }
    f.task.queued = [{ id: "middle", text: notes[1]!.text, at: 2, recipients: { peer: false } }];
    expect(opening((await f.prepare(visible.snapshot, { member: "seat" })).sections)).not.toContain("middle");
  } finally { removeDir(f.root); }
});

it("keeps earlier-attempt guidance in the complete packet and leaves fresh parallel guidance intact", async () => {
  const f = fixture();
  const earlier = note("old", "EARLIER ATTEMPT CONSTRAINT"), added = note("new", "LATER PRODUCT CLARIFICATION");
  try {
    f.setNotes([earlier]);
    f.task.stepNotes = [{ id: "old", text: earlier.text, at: 1, kind: "message" }];
    f.scope.work.stepAttempts = 2;
    const first = await f.prepare(undefined, { earlierCarried: true });
    expect(opening(first.sections)).not.toContain(earlier.text);
    await completePacket(first.snapshot!, [earlier]);
    f.setNotes([earlier, added]);
    const warm = await f.prepare(first.snapshot, { earlierCarried: true });
    expect(opening(warm.sections)).toContain(added.text);
    expect(opening(warm.sections)).not.toContain(earlier.text);
    await completePacket(warm.snapshot!, [earlier, added]);
    const freshSeat = await f.prepare(warm.snapshot, { sessionId: "fresh-peer", member: "review-1" });
    expect(freshSeat.sections).toEqual(f.sections("review-1"));
    expect(opening(freshSeat.sections)).toContain(earlier.text);
    await completePacket(freshSeat.snapshot!, [earlier, added]);
  } finally { removeDir(f.root); }
});

it("sends complete current notes for old snapshots, changed scope, insufficient identity and nothing reusable", async () => {
  const f = fixture();
  const earlier = note("old", "OLD PRODUCT CONSTRAINT"), added = note("new", "NEW PRODUCT CONSTRAINT");
  try {
    f.setNotes([earlier]);
    const first = await f.prepare();
    f.setNotes([earlier, added]);
    const oldSnapshot = { ...first.snapshot!, noteHashes: undefined };
    const comparisonFailure = { ...first.snapshot!, noteHashes: new Proxy(first.snapshot!.noteHashes!, { get() { throw new Error("Comparison unavailable"); } }) };
    const comparisonFallback = await f.prepare(comparisonFailure);
    expect(comparisonFallback.sections).toEqual(f.sections());
    expect(comparisonFallback.snapshot).toBeUndefined();
    for (const options of [{ previous: oldSnapshot }, { previous: first.snapshot, sessionId: "replacement-profile-session" }, { previous: first.snapshot, role: { ...f.role, id: "replacement-role", instructions: "Changed role contract" } }]) {
      const full = await f.prepare(options.previous, options);
      expect(full.sections).toEqual(f.sections());
      await completePacket(full.snapshot!, [earlier, added]);
    }
    for (const notes of [[{ ...earlier, id: undefined }, added], [earlier, { ...added, id: earlier.id }]]) {
      f.setNotes(notes);
      const full = await f.prepare(first.snapshot);
      expect(full.sections).toEqual(f.sections());
      await completePacket(full.snapshot!, notes);
    }
    f.setNotes([]);
    const noNotes = await f.prepare();
    const entirelyNew = note("entirely-new", "NO SHARED NOTE CONTENT");
    f.setNotes([entirelyNew]);
    const nothingReusable = await f.prepare(noNotes.snapshot);
    expect(nothingReusable.sections).toEqual(f.sections());
    await completePacket(nothingReusable.snapshot!, [entirelyNew]);
    // A renderer without per-note records is an older or uncertain caller and remains complete.
    f.setNotes([earlier, added]);
    const plain = f.sections().map(({ title, body, background }) => ({ title, body, background }));
    const full = await builderContext(f.root, repositoryView(f.scope), f.role, "own-conversation", plain, first.snapshot);
    expect(full.sections).toEqual(plain);
  } finally { removeDir(f.root); }
});

it("falls back to complete notes for missing or altered packets and failed storage, then recovers", async () => {
  const f = fixture();
  const earlier = note("old", "KEEP EVERY ORIGINAL CONSTRAINT"), added = note("new", "KEEP THE FRESH INSTRUCTION");
  try {
    f.setNotes([earlier]);
    const first = await f.prepare();
    f.setNotes([earlier, added]);
    await rm(first.snapshot!.file);
    expect((await f.prepare(first.snapshot)).sections).toEqual(f.sections());
    f.setNotes([earlier]);
    const restored = await f.prepare();
    await writeFile(restored.snapshot!.file, "The packet was changed");
    f.setNotes([earlier, added]);
    expect((await f.prepare(restored.snapshot)).sections).toEqual(f.sections());
    // A failed optional packet save must not shorten instructions or retain a broken snapshot.
    f.setNotes([note("different", "DIFFERENT PACKET FOR STORAGE FAILURE"), added]);
    const write = spyOn(files, "writeFile").mockImplementation(async () => { throw new Error("Storage is unavailable"); });
    try {
      const failed = await f.prepare(first.snapshot);
      expect(failed.sections).toEqual(f.sections());
      expect(failed.snapshot).toBeUndefined();
    } finally { write.mockRestore(); }
    const recovered = await f.prepare(first.snapshot);
    expect(recovered.sections).toEqual(f.sections());
    expect(recovered.snapshot).toBeDefined();
    await completePacket(recovered.snapshot!, f.task.notes!);
  } finally { removeDir(f.root); }
});

it("checks the saved packet before rebuilding identical content, then returns to reduced notes only after a complete fallback", async () => {
  const f = fixture();
  const notes = [note("old", "UNCHANGED ORIGINAL PRODUCT DECISION")];
  try {
    f.setNotes(notes);
    const first = await f.prepare();
    await rm(first.snapshot!.file);
    // Saving the same current content can recreate its old name; that does not
    // establish that the conversation had an intact packet before this return.
    const missing = await f.prepare(first.snapshot);
    expect(missing.sections).toEqual(f.sections());
    expect(missing.snapshot).toBeDefined();
    await completePacket(missing.snapshot!, notes);
    await writeFile(missing.snapshot!.file, "Altered complete context");
    const altered = await f.prepare(missing.snapshot);
    expect(altered.sections).toEqual(f.sections());
    expect(altered.snapshot).toBeUndefined();
    expect(await readFile(missing.snapshot!.file, "utf8")).toBe("Altered complete context");
    await rm(missing.snapshot!.file);
    const recovered = await f.prepare();
    expect(recovered.sections).toEqual(f.sections());
    await completePacket(recovered.snapshot!, notes);
    const continued = await f.prepare(recovered.snapshot);
    expect(noteSection(continued.sections)).toBeUndefined();
    await completePacket(continued.snapshot!, notes);
  } finally { removeDir(f.root); }
});

for (const revision of ["text", "original-step"] as const) it(`sends a changed note despite earlier-attempt guidance carrying its previous version (${revision})`, async () => {
  const f = fixture();
  const stable = note("stable", "UNCHANGED DECISION BESIDE THE REVISION");
  const original = note("revised", "GUIDANCE BEFORE ITS REVISION", "The original design step");
  const revised = revision === "text" ? { ...original, text: "REVISED GUIDANCE THAT MUST BE SUPPLIED" }
    : { ...original, origin: { ...original.origin!, stageTitle: "The revised original step" } };
  try {
    f.setNotes([stable, original]);
    const first = await f.prepare();
    f.setNotes([stable, revised]);
    f.task.stepNotes = [{ id: original.id!, text: original.text, at: 2, kind: "message" }];
    f.scope.work.stepAttempts = 2;
    const before = structuredClone({ queued: f.task.queued, session: f.task.session, timeline: f.task.timeline, stepNotes: f.task.stepNotes });
    const returned = await f.prepare(first.snapshot, { earlierCarried: true });
    const body = noteSection(returned.sections)!.body;
    expect(body.split(revised.text)).toHaveLength(2);
    expect(body).not.toContain(stable.text);
    expect(body).toContain(`Recorded during “${revised.origin!.stageTitle}”`);
    const entry = body.split("\n").find(line => line.startsWith("2. revised:"))!;
    expect(entry).toContain("full text below (changed)");
    expect(entry).not.toContain("already carried");
    if (revision === "text") expect(body).not.toContain(original.text);
    expect(returned.omitted?.filter(omission => omission.noteId).map(omission => omission.noteId)).toEqual(["stable"]);
    expect({ queued: f.task.queued, session: f.task.session, timeline: f.task.timeline, stepNotes: f.task.stepNotes }).toEqual(before);
    await completePacket(returned.snapshot!, [stable, revised]);
    const replay = await f.prepare(returned.snapshot, { earlierCarried: true });
    expect(noteSection(replay.sections)).toBeUndefined();
    expect(opening(replay.sections)).not.toContain(revised.text);
    const fresh = await f.prepare(returned.snapshot, { sessionId: "fresh-revision-seat", member: "fresh-peer" });
    expect(opening(fresh.sections)).toContain(stable.text);
    expect(opening(fresh.sections).split(revised.text)).toHaveLength(2);
    await completePacket(fresh.snapshot!, [stable, revised]);
  } finally { removeDir(f.root); }
});

it("does not treat identical wording under another id as already carried earlier-attempt guidance", async () => {
  const f = fixture();
  const stable = note("stable", "A SAVED INDEPENDENT DECISION");
  const added = note("new-id", "IDENTICAL WORDS FROM A DISTINCT RECORDED DECISION");
  try {
    f.setNotes([stable]);
    const first = await f.prepare();
    f.setNotes([stable, added]);
    f.task.stepNotes = [{ id: "different-earlier-id", text: added.text, at: 2, kind: "message" }];
    f.scope.work.stepAttempts = 2;
    const returned = await f.prepare(first.snapshot, { earlierCarried: true });
    const body = noteSection(returned.sections)!.body;
    expect(body.split(added.text)).toHaveLength(2);
    expect(body).not.toContain(stable.text);
    expect(body.split("\n").find(line => line.startsWith("2. new-id:"))).toContain("full text below (new)");
    await completePacket(returned.snapshot!, [stable, added]);
  } finally { removeDir(f.root); }
});

it("keeps an idless note in full when only earlier-attempt wording matches", async () => {
  const f = fixture();
  const stable = note("stable", "A PROVEN ORIGINAL DECISION");
  const added = { ...note("unused", "IDLESS DECISION NEEDS ITS COMPLETE TEXT"), id: undefined };
  try {
    f.setNotes([stable]);
    const first = await f.prepare();
    f.setNotes([stable, added]);
    f.task.stepNotes = [{ id: "earlier-id", text: added.text, at: 2, kind: "message" }];
    f.scope.work.stepAttempts = 2;
    const returned = await f.prepare(first.snapshot, { earlierCarried: true });
    const body = noteSection(returned.sections)!.body;
    expect(body.split(added.text)).toHaveLength(2);
    expect(body).toContain(stable.text);
    expect(returned.omitted ?? []).toEqual([]);
    expect(returned.snapshot!.noteHashes).toBeUndefined();
    await completePacket(returned.snapshot!, [stable, added]);
  } finally { removeDir(f.root); }
});

it("retains exact earlier-attempt exclusions for guidance newer than the saved comparison", async () => {
  const f = fixture();
  const stable = note("stable", "THE SAVED ORIGINAL DECISION");
  const heardLater = note("heard-later", "GUIDANCE HEARD AFTER THE SAVED COMPARISON");
  try {
    f.setNotes([stable]);
    const first = await f.prepare();
    f.setNotes([stable, heardLater]);
    f.task.stepNotes = [{ id: heardLater.id!, text: heardLater.text, at: 2, kind: "message" }];
    f.scope.work.stepAttempts = 2;
    const returned = await f.prepare(first.snapshot, { earlierCarried: true });
    const body = noteSection(returned.sections)!.body;
    expect(body).not.toContain(stable.text);
    expect(body).not.toContain(heardLater.text);
    expect(body.split("\n").find(line => line.startsWith("2. heard-later:"))).toContain("already carried in earlier-attempt guidance");
    await completePacket(returned.snapshot!, [stable, heardLater]);
    expect(noteSection((await f.prepare(returned.snapshot, { earlierCarried: true })).sections)).toBeUndefined();
    const fresh = await f.prepare(returned.snapshot, { sessionId: "fresh-late-guidance-seat", member: "fresh-peer" });
    expect(opening(fresh.sections)).toContain(stable.text);
    expect(opening(fresh.sections).split(heardLater.text)).toHaveLength(2);
    await completePacket(fresh.snapshot!, [stable, heardLater]);
  } finally { removeDir(f.root); }
});

for (const revision of ["text", "original-step"] as const) it(`sends the full changed note when earlier-attempt guidance leaves no reusable background (${revision})`, async () => {
  const f = fixture();
  const original = note("only", "THE ONLY NOTE BEFORE ITS REVISION", "The first recorded step");
  const revised = revision === "text" ? { ...original, text: "THE ONLY NOTE AFTER ITS REVISION" }
    : { ...original, origin: { ...original.origin!, stageTitle: "The corrected recorded step" } };
  try {
    f.setNotes([original]);
    const first = await f.prepare();
    f.setNotes([revised]);
    f.task.stepNotes = [{ id: original.id!, text: original.text, at: 2, kind: "message" }];
    f.scope.work.stepAttempts = 2;
    const returned = await f.prepare(first.snapshot, { earlierCarried: true });
    const body = noteSection(returned.sections)!.body;
    expect(body.split(revised.text)).toHaveLength(2);
    expect(body).toContain(`Recorded during “${revised.origin!.stageTitle}”`);
    expect(body).not.toContain("already carried");
    expect(returned.omitted ?? []).toEqual([]);
    await completePacket(returned.snapshot!, [revised]);
  } finally { removeDir(f.root); }
});

for (const failure of ["missing-packet", "packet-write", "note-comparison"] as const) it(`keeps a revised original step explicit when optional context preparation fails (${failure})`, async () => {
  const f = fixture();
  const stable = note("stable", "EVERY FULL FALLBACK STILL NEEDS THIS DECISION");
  const original = note("revised", "THE DECISION TEXT STAYS EXACTLY THE SAME", "The previous original step");
  const revised = { ...original, origin: { ...original.origin!, stageTitle: "The corrected original step" } };
  try {
    f.setNotes([stable, original]);
    const first = await f.prepare();
    f.setNotes([stable, revised]);
    f.task.stepNotes = [{ id: original.id!, text: original.text, at: 2, kind: "message" }];
    f.scope.work.stepAttempts = 2;
    const before = structuredClone({ queued: f.task.queued, session: f.task.session, timeline: f.task.timeline, stepNotes: f.task.stepNotes });
    if (failure === "missing-packet") await rm(first.snapshot!.file);
    const previous = failure === "note-comparison" ? {
      ...first.snapshot!, noteHashes: new Proxy(first.snapshot!.noteHashes!, { get() { throw new Error("The recorded note comparison is unavailable"); } }),
    } : first.snapshot;
    const write = failure === "packet-write" ? spyOn(files, "writeFile").mockImplementation(async () => { throw new Error("The context packet could not be saved"); }) : undefined;
    let fallback: Awaited<ReturnType<typeof f.prepare>>;
    try { fallback = await f.prepare(previous, { earlierCarried: true }); }
    finally { write?.mockRestore(); }
    const body = noteSection(fallback.sections)!.body;
    expect(body).toContain(stable.text);
    expect(body.split(revised.text)).toHaveLength(2);
    expect(body).toContain(`Recorded during “${revised.origin!.stageTitle}”`);
    expect(body).not.toContain(`Recorded during “${original.origin!.stageTitle}”`);
    expect(body).not.toContain("already carried");
    expect(fallback.omitted ?? []).toEqual([]);
    if (fallback.snapshot) await completePacket(fallback.snapshot, [stable, revised]);
    expect({ queued: f.task.queued, session: f.task.session, timeline: f.task.timeline, stepNotes: f.task.stepNotes }).toEqual(before);

    const recovered = await f.prepare(first.snapshot, { earlierCarried: true });
    const recoveredBody = noteSection(recovered.sections)!.body;
    expect(recoveredBody.split(revised.text)).toHaveLength(2);
    expect(recoveredBody).toContain(`Recorded during “${revised.origin!.stageTitle}”`);
    await completePacket(recovered.snapshot!, [stable, revised]);
    const replay = await f.prepare(recovered.snapshot, { earlierCarried: true });
    expect(noteSection(replay.sections)).toBeUndefined();
    expect(opening(replay.sections)).not.toContain(revised.text);
    await completePacket(replay.snapshot!, [stable, revised]);
    expect({ queued: f.task.queued, session: f.task.session, timeline: f.task.timeline, stepNotes: f.task.stepNotes }).toEqual(before);
  } finally { removeDir(f.root); }
});
