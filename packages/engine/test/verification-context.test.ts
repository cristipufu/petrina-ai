import { expect, it } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { createDemoState } from "@petrina/core";
import { verificationContext } from "../src/verification-context.js";
import { removeDir, tempDir } from "./support.js";

it("links earlier evidence to its node, code and confirmed settings without presenting old passes as current", async () => {
  const root = tempDir("verification-context-");
  try {
    const task = createDemoState(1_000_000_000).tasks[0]!;
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
    const before = await readFile(file, "utf8");
    task.journey[0]!.agentResults![0]!.value = { summary: "Different later report", changes: [] };
    await verificationContext(root, task);
    expect(await readFile(file, "utf8")).toBe(before);
    const again = await verificationContext(root, task);
    const changedFile = JSON.parse(again[0]!.body.match(/available at ("[^"]+")/)![1]!);
    await writeFile(changedFile, "Corrupt");
    await expect(verificationContext(root, task)).rejects.toThrow("saved verification evidence changed");
  } finally { removeDir(root); }
});
