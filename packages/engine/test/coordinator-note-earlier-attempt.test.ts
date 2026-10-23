import { expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { BUILT_IN_ROLES, createDemoState, type BuilderContext, type Task } from "@petrina/core";
import { builderContext } from "../src/builder-context.js";
import { coordinatorNotes, type Section } from "../src/context.js";
import type { MTask } from "../src/kernel.js";
import { executionFor, repositoryView, restoreRepositoryState } from "../src/repository-context.js";
import { removeDir, tempDir } from "./fixtures.js";

type Note = NonNullable<Task["notes"]>[number];
const note = (id: string, text: string): Note => ({ id, text, at: 1, origin: { stageId: "review", stageTitle: "Original review", roleName: "Reviewer", kind: "design" } });
const opening = (sections: readonly Section[]) => sections.map(section => `## ${section.title}\n${section.body}`).join("\n\n");

function fixture() {
  const root = tempDir("coordinator-note-earlier-attempt-");
  const task = structuredClone(createDemoState(1_000_000_000).tasks[0]!) as unknown as MTask;
  restoreRepositoryState(task);
  task.notes = []; task.queued = []; task.stepNotes = [];
  const scope = executionFor(task);
  const role = BUILT_IN_ROLES.find(entry => entry.result === "build")!;
  const prepare = (previous?: BuilderContext, earlierCarried = true, sessionId = "saved-review-conversation", member?: string) =>
    builderContext(root, repositoryView(scope), role, sessionId, coordinatorNotes(scope, member, earlierCarried), previous);
  return { root, task, scope, prepare };
}

async function expectCompletePacket(snapshot: BuilderContext, notes: readonly Note[]) {
  const packet = await readFile(snapshot.file, "utf8");
  expect(createHash("sha256").update(packet).digest("hex")).toBe(snapshot.digest);
  let previous = -1;
  for (const entry of notes) {
    expect(packet.split(entry.text)).toHaveLength(2);
    const position = packet.indexOf(entry.text);
    expect(position).toBeGreaterThan(previous);
    expect(packet.slice(previous + 1, position)).toContain(`Recorded during “${entry.origin!.stageTitle}”`);
    previous = position;
  }
}

it("keeps a late-heard earlier-attempt message out of a reopened older conversation's note delta", async () => {
  const f = fixture();
  const old = note("old", "DECISION ALREADY IN THE SAVED SNAPSHOT"), heardLater = note("heard-later", "GUIDANCE HEARD AFTER THE SAVED SNAPSHOT");
  try {
    f.task.notes = [old];
    const first = await f.prepare();
    f.task.notes = [old, heardLater];
    f.task.stepNotes = [{ id: heardLater.id!, text: heardLater.text, at: 2, kind: "message" }];
    f.scope.work.stepAttempts = 2;
    f.task.queued = [{ id: heardLater.id!, text: heardLater.text, at: 2, recipients: { main: true, peer: false }, deliveries: { main: { state: "applied", via: "live", sessionId: "saved-review-conversation" } } }];
    const before = structuredClone({ queued: f.task.queued, session: f.task.session, timeline: f.task.timeline, stepNotes: f.task.stepNotes });
    const returned = await f.prepare(first.snapshot);
    const text = opening(returned.sections);
    expect(text).not.toContain(old.text);
    expect(text).not.toContain(heardLater.text);
    expect(text).toContain(heardLater.id!);
    expect(text).toMatch(/earlier[- ]attempt/i);
    expect({ queued: f.task.queued, session: f.task.session, timeline: f.task.timeline, stepNotes: f.task.stepNotes }).toEqual(before);
    await expectCompletePacket(returned.snapshot!, [old, heardLater]);
    const replayed = await f.prepare(returned.snapshot);
    expect(opening(replayed.sections)).not.toContain(heardLater.text);
  } finally { removeDir(f.root); }
});

for (const addsNote of [false, true]) it(`adds no omission claim or context reference when every note is already carried (adds note=${addsNote})`, async () => {
  const f = fixture();
  const old = note("old", "ORIGINAL DECISION ALREADY CARRIED"), added = note("new", "LATER DECISION ALSO ALREADY CARRIED");
  try {
    f.task.notes = [old];
    const first = await f.prepare();
    const current = addsNote ? [old, added] : [old];
    f.task.notes = current;
    f.task.stepNotes = current.map(entry => ({ id: entry.id!, text: entry.text, at: 2, kind: "message" }));
    f.scope.work.stepAttempts = 2;
    const returned = await f.prepare(first.snapshot);
    expect(returned.sections).toEqual([]);
    expect(returned.omitted ?? []).toEqual([]);
    await expectCompletePacket(returned.snapshot!, current);
  } finally { removeDir(f.root); }
});

for (const variant of ["first-attempt", "guidance-not-carried", "fresh-parallel-seat"] as const) it(`still sends the new full note when earlier-attempt exclusion does not apply (${variant})`, async () => {
  const f = fixture();
  const old = note("old", "OLD INDEPENDENT PRODUCT DECISION"), added = note("new", "NEW GUIDANCE THAT THIS OPENING NEEDS IN FULL");
  try {
    f.task.notes = [old];
    const first = await f.prepare();
    f.task.notes = [old, added];
    f.task.stepNotes = [{ id: added.id!, text: added.text, at: 2, kind: "message" }];
    f.scope.work.stepAttempts = variant === "first-attempt" ? 1 : 2;
    const returned = await f.prepare(first.snapshot, variant === "first-attempt", variant === "fresh-parallel-seat" ? "fresh-peer" : "saved-review-conversation", variant === "fresh-parallel-seat" ? "peer" : undefined);
    expect(opening(returned.sections).split(added.text)).toHaveLength(2);
    if (variant === "fresh-parallel-seat") expect(opening(returned.sections)).toContain(old.text);
    await expectCompletePacket(returned.snapshot!, [old, added]);
  } finally { removeDir(f.root); }
});
