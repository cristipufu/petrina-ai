import { afterAll, describe, expect, it, spyOn } from "bun:test";
import * as gitOps from "@petrina/repositories/git";
import { executionFor } from "@petrina/orchestrator";
import { Learnings } from "../../../src/learnings.js";
import { removeDir, type World } from "../../support.js";
import { repositoryRecords, type RepositoryRecordOptions } from "../../fixtures/shared-records.js";
const worlds: World[] = [], recordRoots: string[] = [];
afterAll(() => { worlds.forEach(world => removeDir(world.dir)); recordRoots.forEach(removeDir); });
const fixture = (name: string, options: RepositoryRecordOptions = {}) => repositoryRecords(name, recordRoots, options);

describe("explicit repository execution contexts", () => {
  it("groups a shared reviewer's companion lessons and reads only their repository once", async () => {
    const { engine, task } = await fixture("named-learning", { git: ["second"] });
    const read = spyOn(gitOps, "fileAt");
    try {
      const first = executionFor(task, "first"), second = executionFor(task, "second");
      const learnings = new Learnings(engine);
      const texts = ["Use the second product's focused check for its UI changes.", "The second product's fixtures live beside its tests."];
      await learnings.note(first, [...texts.map((text) => ({ productId: "second", text })), { productId: "second", text: texts[0]! }, "An unassigned shared lesson stays with the task."], "code-reviewer", "sol-high");
      expect(first.work.lessons).toBeUndefined();
      expect(second.work.lessons?.map((lesson) => lesson.text)).toEqual(texts);
      expect(task.sharedLessons?.map((lesson) => lesson.text)).toEqual(["An unassigned shared lesson stays with the task."]);
      expect(read.mock.calls.filter(([, , file]) => file === "AGENTS.md")).toEqual([[second.work.worktree!, "HEAD", "AGENTS.md"]]);
      expect(Object.hasOwn(task, "lessons")).toBe(false);
    } finally { read.mockRestore(); await engine.shutdown(); }
  });
});
