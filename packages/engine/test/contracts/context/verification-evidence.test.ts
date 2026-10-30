import { expectRejection } from "@petrina/test-support/rejections";
import { expect, it } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { createTaskState } from "@petrina/core";
import { verificationContext } from "../../../src/verification-context.js";
import { removeDir, tempDir } from "../../fixtures.js";

it("links earlier evidence to its node, code and confirmed settings without presenting old passes as current", async () => {
  const root = tempDir("verification-context-");
  try {
    const task = createTaskState({ productId: "api", title: "Verify the product", backlog: true },
      [{ id: "api", name: "API", repo: "local/api", tone: "blue" }], { id: "task", timelineId: "created", now: 1_000_000_000, priority: 0 });
    task.retest = true;
    task.journey = [
      { id: "original", kind: "agent", round: 1, sub: 0, startedAt: 1, endedAt: 3, agentInputs: [{ at: 1, roleId: "custom-builder", profileId: "original-tool", confirmedSettings: { model: "confirmed-model" }, mode: "fresh", taskTitle: task.title, sections: [] }], agentResults: [{ roleId: "custom-builder", profileId: "original-tool", at: 2, productId: "api", versions: { api: "original-tree" }, value: { summary: "Original implementation", changes: ["Full feature"], tests: "Native settings and browser proof" } }] },
      { id: "tested", kind: "agent", round: 1, sub: 0, startedAt: 4, endedAt: 6, agentResults: [{ roleId: "custom-tester", profileId: "tester-tool", at: 5, versions: { api: "original-tree", web: "same-tree" }, value: { summary: "Earlier acceptance", checks: [{ text: "Works", result: "pass", evidence: "Original observation" }] } }] },
      { id: "fix", kind: "agent", round: 1, sub: 0, startedAt: 7, endedAt: 9, agentResults: [{ roleId: "custom-builder", profileId: "original-tool", at: 8, versions: { api: "fixed-tree" }, value: { summary: "Narrow fix", changes: ["Fixed one defect"] } }] },
      { id: "unfinished", kind: "agent", round: 1, sub: 0, startedAt: 10, agentResults: [{ roleId: "custom-builder", profileId: "original-tool", at: 11, value: { summary: "Not finished", changes: [] } }] },
    ];
    const parallel = await Promise.all(Array.from({ length: 4 }, () => verificationContext(root, task, { api: "fixed-tree", web: "same-tree" })));
    const sections = parallel[0]!;
    expect(parallel.every((value) => JSON.stringify(value) === JSON.stringify(sections))).toBe(true);
    const file = JSON.parse(sections[0]!.body.match(/available at ("[^"]+")/)![1]!);
    const saved = JSON.parse(await readFile(file, "utf8"));
    expect(saved.reports).toHaveLength(3);
    expect(saved.reports[0]).toMatchObject({ node: "original", versions: { api: "original-tree" }, settings: { model: "confirmed-model" }, tests: "Native settings and browser proof" });
    expect(sections[0]!.body).not.toContain("Native settings and browser proof");
    expect(sections[1]!.body).toContain("Products with changed trees: api.");
    expect(sections[1]!.body).toContain("old passes never automatically satisfy this run");
    const unknown = await verificationContext(root, task, { api: undefined, web: "same-tree" });
    expect(unknown[1]!.body).not.toContain("Products with changed trees: api");
    expect(unknown[1]!.body).toContain("tree comparison is unknown: api");
    let observations = 0;
    let observedTree: string | undefined = "fixed-tree";
    const observe = async () => { observations++; return { api: observedTree, web: "same-tree" }; };
    expect(await verificationContext(root, task, observe)).toEqual(sections);
    observedTree = undefined;
    expect(await verificationContext(root, task, observe)).toEqual(unknown);
    observedTree = "original-tree";
    const restored = await verificationContext(root, task, observe);
    expect(restored[1]!.body).toContain("Products with changed trees: none;");
    expect(observations).toBe(3);
    await expectRejection(verificationContext(root, task, async () => { throw new Error("Version observation failed"); }), "Version observation failed");
    const before = await readFile(file, "utf8");
    task.journey[0]!.agentResults![0]!.value = { summary: "Different later report", changes: [] };
    await verificationContext(root, task);
    expect(await readFile(file, "utf8")).toBe(before);
    const again = await verificationContext(root, task);
    const changedFile = JSON.parse(again[0]!.body.match(/available at ("[^"]+")/)![1]!);
    await writeFile(changedFile, "Corrupt");
    await expectRejection(verificationContext(root, task), "saved verification evidence changed");
  } finally { removeDir(root); }
});

it.each([
  { name: "no reports", retest: true, endedAt: 3, value: undefined, sections: 0 },
  { name: "unfinished report", retest: true, endedAt: undefined, value: { summary: "Still running", checks: [] }, sections: 0 },
  { name: "unrecognized report", retest: true, endedAt: 3, value: { summary: "Notes only" }, sections: 0 },
  { name: "no acceptance pass owed", retest: false, endedAt: 3, value: { summary: "Saved acceptance", checks: [] }, sections: 1 },
])("does not observe versions for $name", async ({ retest, endedAt, value, sections: count }) => {
  const root = tempDir("verification-unused-versions-");
  try {
    const task = createTaskState({ productId: "api", title: "Verify the product", backlog: true },
      [{ id: "api", name: "API", repo: "local/api", tone: "blue" }], { id: "task", timelineId: "created", now: 1_000_000_000, priority: 0 });
    task.retest = retest;
    task.journey = [{ id: "reported", kind: "agent", round: 1, sub: 0, startedAt: 1, endedAt,
      agentResults: [{ roleId: "custom-tester", profileId: "tester-tool", at: 2, value }] }];
    let observations = 0;
    const sections = await verificationContext(root, task, async () => { observations++; throw new Error("Unused version observation"); });
    expect(sections).toHaveLength(count);
    expect(sections.some(section => section.title === "Why acceptance testing runs again")).toBe(false);
    expect(observations).toBe(0);
  } finally { removeDir(root); }
});

it.each([
  { name: "final retest", retest: true, repairCheck: false },
  { name: "acceptance repair", retest: false, repairCheck: true },
])("observes $name versions even when the prior acceptance report is missing", async ({ retest, repairCheck }) => {
  const root = tempDir("verification-missing-prior-versions-");
  try {
    const task = createTaskState({ productId: "api", title: "Verify the product", backlog: true },
      [{ id: "api", name: "API", repo: "local/api", tone: "blue" }], { id: "task", timelineId: "created", now: 1_000_000_000, priority: 0 });
    task.retest = retest;
    task.repairCheck = repairCheck;
    task.journey = [{ id: "built", kind: "agent", round: 1, sub: 0, startedAt: 1, endedAt: 3,
      agentResults: [{ roleId: "custom-builder", profileId: "builder-tool", at: 2, value: { summary: "Implementation", changes: [] } }] }];
    let observations = 0;
    const sections = await verificationContext(root, task, async () => { observations++; return { api: "actual-current-tree" }; });
    expect(observations).toBe(1);
    expect(sections[1]!.body).toContain('Prior acceptance report: not recorded. Current code trees: {"api":"actual-current-tree"}');
    expect(sections[1]!.body).toContain("The previous code version was not recorded; do not assume a narrower retest scope.");
    expect(sections[1]!.body).toContain(retest ? "This is the final acceptance pass after review" : "This run checks the builder's repair of the prior acceptance run");
  } finally { removeDir(root); }
});
