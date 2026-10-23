import { expect, it } from "bun:test";
import { readFile } from "node:fs/promises";
import { BUILT_IN_ROLES, createDemoState, type BuilderContext, type Task } from "@petrina/core";
import { builderContext } from "../src/builder-context.js";
import { coordinatorNotes, type Section } from "../src/context.js";
import type { MTask } from "../src/kernel.js";
import { executionFor, repositoryView, restoreRepositoryState } from "../src/repository-context.js";
import { removeDir, tempDir } from "./fixtures.js";

const notesTitle = "The coordinator's notes on this task";
type Note = NonNullable<Task["notes"]>[number];
const note: Note = { id: "decision", text: "THE COORDINATOR'S ORIGINAL DECISION", at: 1, origin: { stageId: "build", stageTitle: "Original build", roleName: "Builder", kind: "question" } };

function fixture() {
  const root = tempDir("coordinator-note-empty-");
  const task = structuredClone(createDemoState(1_000_000_000).tasks[0]!) as unknown as MTask;
  restoreRepositoryState(task);
  task.notes = []; task.queued = []; task.stepNotes = [];
  const scope = executionFor(task);
  const role = BUILT_IN_ROLES.find(entry => entry.result === "build")!;
  const prepare = (assignment: string, previous?: BuilderContext, extra: Section[] = [], member?: string) => builderContext(root, repositoryView(scope), role, "own-conversation", [
    { title: "Current step assignment", body: assignment }, ...extra, ...coordinatorNotes(scope, member),
  ], previous);
  return { root, task, prepare };
}

it("keeps fresh and warm note-free packets free of empty headings and unnecessary saved-context references", async () => {
  const f = fixture();
  try {
    const first = await f.prepare("FIRST ASSIGNMENT");
    const next = await f.prepare("CHANGED ASSIGNMENT", first.snapshot);
    for (const prepared of [first, next]) {
      expect(prepared.sections.map(section => section.title)).toEqual(["Current step assignment"]);
      expect(prepared.omitted ?? []).toEqual([]);
      expect(await readFile(prepared.snapshot!.file, "utf8")).not.toContain(notesTitle);
    }
  } finally { removeDir(f.root); }
});

it("still references saved context when a real unchanged background section is left out", async () => {
  const f = fixture();
  const checks = { title: "Product checks", body: "THE PRODUCT'S REQUIRED CHECKS" };
  try {
    const first = await f.prepare("FIRST ASSIGNMENT", undefined, [checks]);
    const next = await f.prepare("CHANGED ASSIGNMENT", first.snapshot, [checks]);
    expect(next.sections.map(section => section.title)).toEqual(["Current authoritative task context", "Current step assignment"]);
    expect(next.omitted?.map(section => section.title)).toEqual([checks.title]);
    const packet = await readFile(next.snapshot!.file, "utf8");
    expect(packet).toContain(checks.body);
    expect(packet).not.toContain(notesTitle);
  } finally { removeDir(f.root); }
});

it("names the final withdrawn note once without retaining an empty notes heading", async () => {
  const f = fixture();
  try {
    f.task.notes = [structuredClone(note)];
    const first = await f.prepare("FIRST ASSIGNMENT");
    f.task.notes = [];
    const removed = await f.prepare("CHANGED ASSIGNMENT", first.snapshot);
    const withdrawal = removed.sections.find(section => section.title === "Coordinator notes no longer applying");
    expect(withdrawal?.body).toContain(note.id!);
    expect(withdrawal?.body).toContain("No longer applying");
    expect(removed.sections.map(section => section.title)).toEqual(["Current authoritative task context", "Current step assignment", "Coordinator notes no longer applying"]);
    const packet = await readFile(removed.snapshot!.file, "utf8");
    expect(packet).not.toContain(notesTitle);
    expect(packet).not.toContain(note.text);
    expect(removed.omitted?.filter(entry => entry.noteId)).toEqual([]);
    const replay = await f.prepare("NEXT ASSIGNMENT", removed.snapshot);
    expect(replay.sections.map(section => section.title)).toEqual(["Current step assignment"]);
    expect(replay.omitted ?? []).toEqual([]);
  } finally { removeDir(f.root); }
});

for (const delivery of ["sending", "accepted", "unconfirmed", "other-seat"] as const) {
  it(`keeps a note hidden by ${delivery} delivery out of withdrawals and empty context references`, async () => {
    const f = fixture();
    try {
      f.task.notes = [structuredClone(note)];
      const visible = await f.prepare("FIRST ASSIGNMENT", undefined, [], "seat");
      f.task.queued = [{ id: note.id!, text: note.text, at: 2, recipients: delivery === "other-seat" ? { peer: false } : { seat: false },
        ...(delivery === "other-seat" ? {} : { deliveries: { seat: { state: delivery, via: "live" as const } } }),
      }];
      const queued = structuredClone(f.task.queued);
      const hidden = await f.prepare("CHANGED ASSIGNMENT", visible.snapshot, [], "seat");
      const replay = await f.prepare("NEXT ASSIGNMENT", hidden.snapshot, [], "seat");
      for (const prepared of [hidden, replay]) {
        expect(prepared.sections.map(section => section.title)).toEqual(["Current step assignment"]);
        expect(prepared.omitted ?? []).toEqual([]);
        const packet = await readFile(prepared.snapshot!.file, "utf8");
        expect(packet).not.toContain(notesTitle);
        expect(packet).not.toContain(note.text);
      }
      expect(f.task.queued).toEqual(queued);
      f.task.queued = [];
      const returned = await f.prepare("RETURNED ASSIGNMENT", replay.snapshot, [], "seat");
      const notes = returned.sections.find(section => section.title.startsWith(notesTitle));
      expect(notes?.body).toContain(note.text);
      expect(returned.sections.some(section => /no longer applying/i.test(section.title + section.body))).toBe(false);
    } finally { removeDir(f.root); }
  });
}
