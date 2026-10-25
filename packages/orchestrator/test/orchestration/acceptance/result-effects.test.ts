import { expect, it } from "vitest";
import { AcceptanceResults } from "../../../src/acceptance-results.js";
import { acceptanceResultsFixture } from "../../fixtures/acceptance-results.js";

const report = { summary: "Checked recovery", checks: [{ text: "Recovery works", result: "pass" as const, evidence: "The recovery and nearby control passed" }], proofAnswers: [], learnings: [] };

it("retains recorded answers before learning work, and recorded proof before patch observation", async () => {
  const f = acceptanceResultsFixture(), request = f.request();
  const value = { ...report, proofAnswers: [{ id: request.id, result: "pass" as const, evidence: "Recovery and its nearby control passed" }] };
  const result = await f.record(value);
  expect(result).toEqual({ failed: 0, requiredGap: false, requiredCount: 0, restored: false });
  const beforeLearning = f.events.find(event => event.kind === "learnings")!.task;
  expect(beforeLearning.journey!.at(-1)!.proofChecks).toEqual(value.proofAnswers);
  expect(beforeLearning.acceptanceRun).toBeDefined();
  expect(beforeLearning.proofRequests![0]!.proof).toBeUndefined();
  const beforePatch = f.events.find(event => event.kind === "patch")!.task;
  expect(beforePatch.acceptanceRun).toBeUndefined();
  expect(beforePatch.proofRequests![0]).toMatchObject({ status: "proved", proof: { stepId: f.step.id, versions: f.versions } });
  expect(f.step.agentResults![0]!.value).toBe(value);
  expect(f.task.testedPatch).toBe("tested-patch");
});

it("propagates learning failure before settling proof or asking for a patch", async () => {
  const f = acceptanceResultsFixture(), failure = new Error("Learning store unavailable");
  const request = f.request();
  f.host.noteLearnings = async () => { throw failure; };
  await expect(f.record({ ...report, proofAnswers: [{ id: request.id, result: "pass", evidence: "Recovery passed" }] })).rejects.toBe(failure);
  expect(f.task.acceptanceRun).toBe(f.run); expect(request.proof).toBeUndefined();
  expect(f.events.some(event => event.kind === "patch")).toBe(false);
  expect(f.step.endedAt).toBeUndefined();
});

it("keeps method receivers and propagates a failed patch observation without inventing a version", async () => {
  const f = acceptanceResultsFixture(), failure = new Error("Patch unavailable");
  const host = { ...f.host, calls: 0, async acceptancePatch() { this.calls++; throw failure; } };
  const owner = new AcceptanceResults(host);
  await expect(owner.record(f.scope, { roleId: "tester", profileId: "opus-high", report, run: f.run, testedVersions: f.versions, currentVersions: f.versions })).rejects.toBe(failure);
  expect(host.calls).toBe(1);
  expect(f.task.acceptanceRun).toBeUndefined();
  expect(f.task.testedPatch).toBeUndefined();
  expect(f.task.acceptancePassed).toBeUndefined();
  expect(f.step.endedAt).toBeDefined();
});
