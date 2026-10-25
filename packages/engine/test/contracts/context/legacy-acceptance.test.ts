import { expect, it } from "bun:test";
import { beginAgentStep, BUILT_IN_ROLES, endAgentStep, owedAcceptanceTest } from "@petrina/core";
import { readFileSync } from "node:fs";
import { removeDir, tempDir } from "@petrina/test-support/fixtures";
import { acceptanceContext } from "../../fixtures/acceptance-context.js";
import { promptContext } from "../../fixtures/prompt-context.js";
import { contractFor } from "../../../src/roles.js";
import { verificationContext } from "../../../src/verification-context.js";

it("gives restored early testing its actual repair instructions", async () => {
  const root = tempDir("petrina-legacy-acceptance-context-");
  try {
    const f = acceptanceContext(root), tester = BUILT_IN_ROLES.find(role => role.result === "checks")!;
    f.task.stageIndex = 1; f.task.retest = true; f.task.proofDeliveryGate = "added-check"; f.scope.work.acceptanceReturns = 1;
    const step = beginAgentStep(f.task, tester.id, "opus-high", 200, BUILT_IN_ROLES, undefined, f.scope.work);
    step.agentResults = [{ roleId: tester.id, profileId: "opus-high", at: 201, value: { summary: "The greeting failed before its repair", checks: [{ text: "Greeting", result: "fail" }] }, versions: { a: "earlier-observed-tree" } }];
    endAgentStep(f.task, { outcome: "1 failed", reason: "Acceptance failed" }, 202);
    expect(owedAcceptanceTest(f.task)).toEqual({ stage: 1, final: false });
    const ctx = promptContext(tester); ctx.task = f.task;
    const instructions = contractFor(tester).instructions(ctx);
    expect(instructions).toContain("This acceptance run checks the builder's repair of an earlier run that did not pass, before review.");
    expect(instructions).not.toContain("final acceptance");
    const sections = await verificationContext(root, f.task, { a: "repaired-observed-tree", b: "unchanged-observed-tree" });
    const reason = sections.find(section => section.title === "Why acceptance testing runs again")!;
    expect(reason.body).toContain("This run checks the builder's repair of the prior acceptance run, which did not pass; the planned reviews follow.");
    expect(reason.body).not.toContain("final acceptance");
    const evidence = sections.find(section => section.title === "Earlier implementation and verification evidence")!;
    const path = JSON.parse(evidence.body.match(/available at ("(?:[^"\\]|\\.)*")/)![1]!) as string;
    expect(JSON.parse(readFileSync(path, "utf8")).reports[0].versions).toEqual({ a: "earlier-observed-tree" });
  } finally { removeDir(root); }
});
