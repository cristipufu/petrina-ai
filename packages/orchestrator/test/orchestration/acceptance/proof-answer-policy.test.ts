import { expect, it } from "vitest";
import { recordAcceptanceStart, recordAgentResult } from "@petrina/core";
import { AcceptanceStep, type AcceptanceReply } from "../../../src/index.js";
import { acceptanceHost } from "../../fixtures/acceptance.js";
import { acceptanceResultsFixture } from "../../fixtures/acceptance-results.js";

it("repairs missing or duplicate proof answers in the same Tester turn and never trusts evidence-free passes", async () => {
  const f = acceptanceResultsFixture(), request = f.request();
  f.task.retest = true;
  const route = acceptanceHost();
  let turns = 0;
  const step = new AcceptanceStep({ now: f.host.now, checkpoint() {} }, {
    committedCode: async () => ({ versions: f.versions, changes: f.changes }),
    versions: async () => f.versions,
    saveEdits: async () => { throw new Error("The Tester cannot edit"); },
    async turn(scope, input) {
      turns++;
      recordAcceptanceStart(scope.task, f.step, "checks", structuredClone);
      const reply = (proofAnswers: AcceptanceReply["proofAnswers"]): AcceptanceReply => ({ summary: "Tried the requested proof", checks: [], learnings: [], proofAnswers });
      expect(input.check(reply([]))).toContain("exactly once by id");
      const answer = { id: request.id, result: "pass" as const, evidence: "The requested scenario passed" };
      expect(input.check(reply([answer, answer]))).toContain("exactly once");
      const accepted = reply([{ id: request.id, result: "pass" }]);
      expect(input.check(accepted)).toBeUndefined();
      recordAgentResult(f.step, { roleId: input.roleId, profileId: input.profileId, at: f.host.now(), value: accepted });
      return accepted;
    },
  }, f.owner, route.host);
  await step.run(f.scope, { roleId: "tester", profileId: "opus-high", canEdit: () => false }, new AbortController().signal);
  expect(turns).toBe(1);
  expect(request.status).toBe("unverified");
  expect(f.task.findings).toEqual([]);
  expect(f.scope.work.acceptanceReturns).toBeUndefined();
  expect(f.step.agentResults).toHaveLength(1);
  expect(f.step.agentResults![0]!.value).toMatchObject({ proofAnswers: [{ id: request.id, result: "pass" }] });
  expect(request.proof).toMatchObject({ stepId: f.step.id, result: "blocked", reason: "The agent did not record how it verified this request." });
});
