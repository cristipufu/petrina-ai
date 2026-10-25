import { coordinatorPacketState } from "../../fixtures/coordinator-packets.js";
import { expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { readFile, rm, writeFile } from "node:fs/promises";
import { type BuilderContext, type Task } from "@petrina/core";
import { builderContext } from "../../../src/builder-context.js";
import { coordinatorNotes } from "../../../src/context.js";
import { repositoryView } from "@petrina/orchestrator";
import { removeDir, tempDir } from "../../fixtures.js";

type Note = NonNullable<Task["notes"]>[number];
const note = (id: string | undefined, text: string): Note => ({ id, text, at: 1, origin: { stageId: "build", stageTitle: "Build", roleName: "Builder", kind: "design" } });
const notesTitle = "The coordinator's notes on this task";
const hash = (body: string) => createHash("sha256").update(body).digest("hex");

function fixture(identity: "missing" | "duplicate" | "complete") {
  const root = tempDir("coordinator-note-fallback-");
  const { task, scope, role } = coordinatorPacketState();
  task.notes = [note("first", "FIRST PRODUCT DECISION"), note(identity === "missing" ? undefined : identity === "duplicate" ? "first" : "middle", "MIDDLE PRODUCT DECISION"), note("last", "LAST PRODUCT DECISION")];
  task.queued = [{ id: "first", text: task.notes[0]!.text, at: 1, recipients: { main: true, peer: false }, deliveries: { main: { state: "applied", via: "prompt", sessionId: "own-conversation" } } }];
  task.stepNotes = [];
  const sections = () => [{ title: "Current step assignment", body: "SAME" }, ...coordinatorNotes(scope)];
  const prepare = (previous?: BuilderContext) => builderContext(root, repositoryView(scope), role, "own-conversation", sections(), previous);
  const notes = () => sections().find(section => section.title.startsWith(notesTitle))!;
  const receipts = () => structuredClone({ queued: task.queued, session: task.session, timeline: task.timeline });
  return { root, task, prepare, notes, receipts };
}

for (const identity of ["missing", "duplicate", "complete"] as const) {
  it(`omits proven unchanged notes with ${identity} identity without changing delivery, then safely handles changed notes`, async () => {
    const f = fixture(identity);
    try {
      const first = await f.prepare();
      const before = f.receipts();
      const second = await f.prepare(first.snapshot);
      const supplied = second.sections.find(section => section.title.startsWith(notesTitle));
      expect(supplied).toBeUndefined();
      if (identity === "complete") {
        expect(second.omitted?.filter(entry => entry.noteId).map(entry => entry.noteId)).toEqual(["first", "middle", "last"]);
      } else {
        expect(second.omitted?.find(entry => entry.title === f.notes().title)).toEqual({ title: f.notes().title, digest: first.snapshot!.hashes[`${f.notes().title}#1`]! });
        expect(second.omitted?.some(entry => entry.noteId)).not.toBe(true);
        expect(second.snapshot!.noteHashes).toBeUndefined();
      }
      expect(f.receipts()).toEqual(before);
      const packet = await readFile(second.snapshot!.file, "utf8");
      expect(hash(packet)).toBe(second.snapshot!.digest);
      for (const entry of f.task.notes!) expect(packet.split(entry.text)).toHaveLength(2);

      if (identity !== "complete") {
        f.task.notes![1]!.text = "CHANGED MIDDLE PRODUCT DECISION";
        const changed = await f.prepare(second.snapshot);
        expect(changed.sections.find(section => section.title.startsWith(notesTitle))?.body).toBe(f.notes().body);
        for (const entry of f.task.notes!) expect(changed.sections.find(section => section.title.startsWith(notesTitle))!.body.split(entry.text)).toHaveLength(2);
        expect(changed.omitted?.some(entry => entry.noteId)).not.toBe(true);
        expect(f.receipts()).toEqual(before);
        // Repairing identities cannot establish what the older ambiguous snapshot supplied.
        f.task.notes![1]!.id = "middle";
        const recovered = await f.prepare(changed.snapshot);
        expect(recovered.sections.find(section => section.title.startsWith(notesTitle))?.body).toBe(f.notes().body);
        const reusable = await f.prepare(recovered.snapshot);
        expect(reusable.sections.some(section => section.title.startsWith(notesTitle))).toBe(false);
        expect(reusable.omitted?.filter(entry => entry.noteId).map(entry => entry.noteId)).toEqual(["first", "middle", "last"]);
        expect(f.receipts()).toEqual(before);
      }
    } finally { removeDir(f.root); }
  });
}

for (const identity of ["missing", "duplicate"] as const) {
  it(`retains complete ${identity}-identity notes for untrusted packets and hashes, but reuses an exact legacy whole-section comparison`, async () => {
    const f = fixture(identity);
    try {
      const first = await f.prepare();
      const before = f.receipts();
      const key = `${f.notes().title}#1`;
      const missingHashes = { ...first.snapshot!.hashes }; delete missingHashes[key];
      const legacy = { ...first.snapshot!, hashes: { ...first.snapshot!.hashes, [key]: hash(f.notes().background ?? f.notes().body) } };
      const omitted = await f.prepare(legacy);
      expect(omitted.sections.some(section => section.title.startsWith(notesTitle))).toBe(false);
      expect(omitted.omitted?.find(entry => entry.title === f.notes().title)).toEqual({ title: f.notes().title, digest: legacy.hashes[key]! });
      expect(omitted.omitted?.some(entry => entry.noteId)).not.toBe(true);
      for (const previous of [{ ...first.snapshot!, hashes: missingHashes }, { ...first.snapshot!, hashes: { ...first.snapshot!.hashes, [key]: "not-the-recorded-content" } }]) {
        const full = await f.prepare(previous);
        expect(full.sections.find(section => section.title.startsWith(notesTitle))?.body).toBe(f.notes().body);
        expect(full.omitted?.some(entry => entry.noteId)).not.toBe(true);
      }
      f.task.notes![1]!.text = "CHANGED AFTER LEGACY COMPARISON";
      const changed = await f.prepare(legacy);
      expect(changed.sections.find(section => section.title.startsWith(notesTitle))?.body).toBe(f.notes().body);
      f.task.notes![1]!.text = "MIDDLE PRODUCT DECISION";
      await rm(first.snapshot!.file);
      const missing = await f.prepare(first.snapshot);
      expect(missing.sections.find(section => section.title.startsWith(notesTitle))?.body).toBe(f.notes().body);
      expect(missing.omitted?.some(entry => entry.noteId)).not.toBe(true);
      await writeFile(missing.snapshot!.file, "ALTERED COMPLETE CONTEXT");
      const altered = await f.prepare(missing.snapshot);
      expect(altered.sections.find(section => section.title.startsWith(notesTitle))?.body).toBe(f.notes().body);
      expect(altered.omitted?.some(entry => entry.noteId)).not.toBe(true);
      expect(altered.snapshot).toBeUndefined();
      expect(f.receipts()).toEqual(before);
    } finally { removeDir(f.root); }
  });
}

for (const fingerprint of ["legacy text", "current section"] as const) {
  it(`reuses an intact ${fingerprint} comparison with valid ids but no per-note snapshot, and falls back when that proof is unavailable`, async () => {
    const f = fixture("complete");
    try {
      const first = await f.prepare();
      const before = f.receipts();
      const key = `${f.notes().title}#1`;
      // Conversations saved before note-level comparisons have only whole-section fingerprints.
      const previous = structuredClone(first.snapshot!);
      delete previous.noteHashes;
      if (fingerprint === "legacy text") previous.hashes = { ...previous.hashes, [key]: hash(f.notes().background ?? f.notes().body) };
      const unchanged = await f.prepare(previous);
      expect(unchanged.sections.some(section => section.title.startsWith(notesTitle))).toBe(false);
      expect(unchanged.omitted?.find(entry => entry.title === f.notes().title)).toEqual({ title: f.notes().title, digest: previous.hashes[key]! });
      expect(unchanged.omitted?.some(entry => entry.noteId)).not.toBe(true);
      expect(f.receipts()).toEqual(before);
      const packet = await readFile(unchanged.snapshot!.file, "utf8");
      expect(hash(packet)).toBe(unchanged.snapshot!.digest);
      for (const entry of f.task.notes!) expect(packet.split(entry.text)).toHaveLength(2);

      const originalNotes = structuredClone(f.task.notes!);
      for (const changedNotes of [
        originalNotes.map((entry, index) => index === 1 ? { ...entry, text: "CHANGED PRODUCT DECISION" } : entry),
        originalNotes.map((entry, index) => index === 1 ? { ...entry, origin: { ...entry.origin!, stageTitle: "Design" } } : entry),
        [originalNotes[1]!, originalNotes[0]!, originalNotes[2]!],
      ]) {
        f.task.notes = changedNotes;
        const changed = await f.prepare(previous);
        expect(changed.sections.find(section => section.title.startsWith(notesTitle))?.body).toBe(f.notes().body);
        expect(changed.omitted?.some(entry => entry.noteId)).not.toBe(true);
      }
      f.task.notes = originalNotes;
      const missingHashes = { ...previous.hashes }; delete missingHashes[key];
      for (const unproven of [
        { ...previous, hashes: missingHashes },
        { ...previous, hashes: { ...previous.hashes, [key]: "not-the-recorded-content" } },
      ]) {
        const full = await f.prepare(unproven);
        expect(full.sections.find(section => section.title.startsWith(notesTitle))?.body).toBe(f.notes().body);
        expect(full.omitted?.some(entry => entry.noteId)).not.toBe(true);
      }
      await rm(previous.file);
      const missingPacket = await f.prepare(previous);
      expect(missingPacket.sections.find(section => section.title.startsWith(notesTitle))?.body).toBe(f.notes().body);
      expect(missingPacket.omitted?.some(entry => entry.noteId)).not.toBe(true);
      await writeFile(missingPacket.snapshot!.file, "ALTERED COMPLETE CONTEXT");
      const alteredPacket = await f.prepare(previous);
      expect(alteredPacket.sections.find(section => section.title.startsWith(notesTitle))?.body).toBe(f.notes().body);
      expect(alteredPacket.omitted?.some(entry => entry.noteId)).not.toBe(true);
      expect(alteredPacket.snapshot).toBeUndefined();
      expect(f.receipts()).toEqual(before);
    } finally { removeDir(f.root); }
  });
}
