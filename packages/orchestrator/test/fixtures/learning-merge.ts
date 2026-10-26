import { withLearnings, type GuideLine, type LearningReceipt } from "@petrina/core";
import { keepApprovedLearnings } from "../../src/learning-merge.js";
import type { LearningMergeEffects, PlainInstructions } from "../../src/ports/learning-merge.js";

export const INTRO = "What agents learned about working in this repository, added with the coordinator's OK.";
export const BASE = `# Working on the demo\n\nKeep changes small.\n\n## Learnings\n\n${INTRO}\n\n- Run the package tests before delivering.\n`;
export const X1 = "Run engine tests through the package runner so its cleanup runs.";
export const X2 = "Keep disposable repositories outside the working copy.";
export const X3 = "Run bun test --parallel only for diagnostics.";
export const Y1 = "Read the review guide before building.";
export const Y2 = "Run bun test parallel only through the runner.";
export const Y3 = "Name every test fixture after the case it proves.";

/** Explicit version/file/approval observations, never an implementation of Git or the merge decision. */
export function learningMergeFixture(base = BASE, conflicts = ["AGENTS.md"]) {
  const taskId = "this-task", other = "other-task";
  const request = { taskId, fork: "observed:fork", onto: "observed:main", ref: "observed:task", merged: { tree: "observed:conflicted-tree", conflicts } };
  const product: { learnings: GuideLine[]; learningReceipts: LearningReceipt[] } = { learnings: [], learningReceipts: [] };
  const files = new Map<string, PlainInstructions>([request.fork, request.onto, request.ref].map(ref => [ref, { mode: "100644", text: base }]));
  const history = [base], calls: string[] = [], writes: { tree: string; mode: string; text: string }[] = [];
  const effects: LearningMergeEffects = {
    async instructionsAt(ref) { calls.push(`file:${ref}`); return files.get(ref); },
    async objectMergeBase(ref, onto) {
      if (ref !== request.ref || onto !== request.onto) throw new Error("Unexpected bound history request");
      calls.push("fork"); return request.fork;
    },
    async instructionVersionsBetween(fork, onto) {
      if (fork !== request.fork || onto !== request.onto) throw new Error("Unexpected instruction history");
      calls.push("history"); return history;
    },
    async objectHistoryContains(onto, receipt) {
      if (onto !== request.onto) throw new Error("Unexpected receipt owner");
      calls.push(`contains:${receipt}`); return false;
    },
    async instructionsInTree(tree, mode, text) { writes.push({ tree, mode, text }); return "effect:written-instructions-tree"; },
  };
  const record = (text: string, writtenOn?: string, fromTask = writtenOn ?? taskId) => {
    product.learnings.push({ text, at: 100, fromTask, ...(writtenOn ? { writtenOn } : {}) });
  };
  const replace = (ref: string, text: string) => { files.set(ref, { mode: "100644", text }); };
  const mainEdit = (change: (text: string) => string) => {
    const text = change(files.get(request.onto)!.text); replace(request.onto, text); history.push(text);
  };
  const ownEdit = (change: (text: string) => string) => replace(request.ref, change(files.get(request.ref)!.text));
  return { taskId, other, request, product, files, history, calls, writes, effects, record, mainEdit, ownEdit,
    main(lessons: readonly string[], writer = other) { lessons.forEach(text => record(text, writer)); mainEdit(text => withLearnings(text, lessons)); },
    own(lessons: readonly string[]) { lessons.forEach(text => record(text, taskId)); ownEdit(text => withLearnings(text, lessons)); },
    // Historical receipts are supplied scenario input; no native AcceptedPoints sweep is claimed here.
    receipt(text: string, writer = other) { product.learningReceipts.push({ text, fromTask: writer, writtenOn: writer, foundOn: request.onto }); },
    run() { return keepApprovedLearnings({ current() { calls.push("records"); return product; } }, request, effects); },
  };
}
