import { afterAll, expect, it, spyOn } from "bun:test";
import * as files from "node:fs/promises";
import { BUILT_IN_ROLES } from "@petrina/core";
import { repositoryView } from "@petrina/orchestrator";
import { settledReviewFindings } from "../../../src/review-history.js";
import { formatFindings } from "../../../src/prompts.js";
import { frozenHistoryFixtures } from "../../fixtures/review-history.js";

const { finding, examined, fixture, freeze, longCard, supplied, opening, measure, close } = frozenHistoryFixtures();
afterAll(close);
it("keeps acceptance failures and findings with unknown origin complete after a checked fix claim", async () => {
  const f = await fixture(0);
  try {
    const acceptance = { ...finding("acceptance"), roleId: undefined, text: "Failed acceptance check: The guest sees a greeting", evidence: "Original acceptance evidence" };
    const unknown = { ...finding("unknown"), roleId: undefined };
    const retired = { ...finding("retired"), roleId: "unknown-role" };
    f.task.findings = [acceptance, unknown, retired, finding("reviewer")];
    f.task.journey = [examined(f.task.findings)];
    expect(settledReviewFindings(repositoryView(f.scope), BUILT_IN_ROLES)).toEqual({ reviewer: { round: 2, step: "checked" } });
    const { input, step } = await freeze(f);
    const sections = await supplied(f, input);
    for (const original of [acceptance, unknown, retired]) expect(opening(f, sections)).toContain(formatFindings([original], { complete: true }));
    expect(JSON.parse(step.reviewHistory!.body).findings.reviewer).toBe(formatFindings([input.findings[3]!], { complete: true }));
    measure("acceptance and unknown origins stay complete with reviewer control", f, sections, step.reviewHistory!.body);
  } finally { await f.engine.shutdown(); }
});

it("uses complete sections if the indexed copy cannot be frozen", async () => {
  const f = await fixture();
  const write = files.writeFile;
  const failed = spyOn(files, "writeFile").mockImplementation(async (path, data, options) => {
    if (String(path).endsWith(".history.json")) throw new Error("Unavailable history storage");
    return write(path, data, options);
  });
  try {
    const { input, step } = await freeze(f, [longCard]);
    expect(input.history).toBeUndefined();
    const sections = await supplied(f, input);
    expect(step.reviewHistory).toBeUndefined();
    expect(opening(f, sections)).toContain(f.task.findings[0]!.evidence!); expect(opening(f, sections)).toContain(longCard.problem);
    const stats = measure("copy storage unavailable, complete fallback", f, sections); expect(stats.after).toBe(stats.before);
  } finally { failed.mockRestore(); await f.engine.shutdown(); }
});
