import { applyAcceptanceVersions } from "@petrina/core";
import { scopesFor } from "@petrina/orchestrator";
import { afterAll, describe, expect, it } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { ScriptedAgents, scriptedResult } from "../../scripted-agents.js";
import { answersTo, findingIds } from "../../scripted-findings.js";
import { coordinator, itemOf, taskOf, until } from "../../support.js";
import { sharedWorldFixtures } from "../../fixtures/shared-world.js";
import { installSharedWorkflowFastPaths } from "../../fixtures/shared-preparation.js";
const fixtures = sharedWorldFixtures();
afterAll(() => fixtures.close());

describe.concurrent("shared-task repair regressions", () => {
  it("stops at exhausted acceptance allowances, keeps them after restart and renews every product on send-back", async () => {
    await fixtures.world("acceptance-exhausted", async ({ shop, api, engine: withEngine }) => {
    let owners: string[] = [], builds = 0;
    const agents = new ScriptedAgents(({ result, cwd, text }) => {
      switch (result) {
        case "plan": return scriptedResult({ rationale: "Build it, try it, then two reviewers.", stages: [
          { kind: "do", title: "Build", roleId: "builder", profileIds: ["opus-xhigh"] },
          { kind: "do", title: "Try it like a user", roleId: "tester", profileIds: ["opus-high"] },
          { kind: "review-chain", title: "Review", roleId: "code-reviewer", profileIds: ["opus-xhigh", "sol-xhigh"], maxRounds: 2 },
        ] });
        case "check-discovery": return scriptedResult({ summary: "Git is the fixture's check.", checks: [{ name: "Version", argv: ["git", "--version"], why: "A real passing check" }] });
        case "build":
          writeFileSync(join(cwd, "greeting.txt"), "Hello\n");
          if (text.includes("You are fixing the review findings")) writeFileSync(join(cwd, "welcome.txt"), `Repair ${++builds}\n`);
          return scriptedResult({ summary: "Added a greeting.", changes: ["People see a greeting"], answers: answersTo(text) });
        case "checks": return scriptedResult({ summary: "The greeting still does not appear.", checks: [{ text: "A greeting file exists", result: "fail", productIds: owners, evidence: "The guest welcome page has no greeting." }] });
        case "findings": return scriptedResult({ verdict: "pass", findings: [{ text: "Consider a friendlier greeting.", severity: "nit", productIds: owners, evidence: "The welcome page's greeting is terse." }], confirms: [], disputes: [] });
        case "votes": return scriptedResult({ verdicts: findingIds(text, "Important findings to check (a verdict on every one, by id)").map(id => ({ id, verdict: "real", reason: "The welcome page has no greeting." })) });
        case "guide": return scriptedResult({ missed: true, line: "Every greeting also shows on the welcome page.", why: "The reviewers checked the greeting only where it was added." });
        default: throw new Error(`Unexpected participant in the acceptance repair fixture: ${result}`);
      }
    });


    const { id } = await withEngine(async engine => {
      installSharedWorkflowFastPaths(engine, {
        skipUpToDate: true,
        skipPrepareChecks: true,
        skipReviewCopies: true,
        skipReviewInputDiffs: true,
      });
      let revCounter = 0;
      engine["work"]["buildCompletion"]["effects"].saveChanges = async (scope) => {
        const rev = (++revCounter).toString(16).padStart(8, "0");
        scope.work.savedVersion = { commit: `b0000000000000000000000000000000${rev}`, tree: `c0000000000000000000000000000000${rev}` };
      };
      engine["updates"].fold = async (scope) => {
        const saved = scope.work.savedVersion ?? { commit: scope.work.baseSha ?? "", tree: "" };
        engine["updates"]["observedHeads"].set(scope.work, saved.commit);
        return { fork: scope.work.baseSha!, version: { head: saved.commit, tree: saved.tree } };
      };
      const taskVersions = async (currentTask: Parameters<typeof scopesFor>[0]) => Object.fromEntries(scopesFor(currentTask).map(s => [s.work.productId, s.work.savedVersion?.tree ?? s.work.baseSha ?? ""]));
      const committedCode = async (currentTask: Parameters<typeof scopesFor>[0]) => {
        const versions = await taskVersions(currentTask);
        return { versions, changes: { ...versions } };
      };
      const checkpointEffects = engine["driver"]["checkpoint"]["effects"];
      checkpointEffects.head = async (scope) => scope.work.savedVersion?.commit ?? "";
      checkpointEffects.patch = async (scope) => scope.work.savedVersion?.tree ?? "patch";
      checkpointEffects.committedCode = committedCode;
      checkpointEffects.versions = taskVersions;
      checkpointEffects.invalidateAcceptance = async (currentTask, versions) => {
        const current = versions ?? await taskVersions(currentTask);
        applyAcceptanceVersions(currentTask, current);
        return current;
      };
      checkpointEffects.acceptanceVersion = async (scope, versions) => JSON.stringify(versions ?? await taskVersions(scope.task));
      checkpointEffects.writeGuide = async () => {};
      checkpointEffects.writeLearnings = async () => {};
      checkpointEffects.offerLearnings = async () => {};
      const acceptanceEffects = engine["work"]["acceptanceStep"]["effects"];
      acceptanceEffects.committedCode = committedCode;
      acceptanceEffects.versions = taskVersions;

      const first = await shop.preparedProduct(engine), second = await api.preparedProduct(engine);
      for (const productId of [first, second]) {
        const product = engine.s.products.find(p => p.id === productId)!;
        product.checks = [];
        product.checksBy = "coordinator";
      }
      owners = [first, second];
      const id = engine.addTask({ productId: first, worksOn: [first, second].map((productId) => ({ productId, startFrom: { kind: "default" }, delivery: "pull-request" })), title: "Acceptance needs a decision" });
      const ready = await until(engine, (state) => !!itemOf(state, id, "delivery") || !!taskOf(state, id).error, coordinator(["plan", "design"]));
      expect(taskOf(ready, id).error).toBeUndefined();
      expect(taskOf(ready, id).acceptanceBlocked).toBe(true);
      expect(taskOf(ready, id).repositories!.map((work) => work.acceptanceReturns)).toEqual([2, 2]);
      // The planned review still runs before the decision, and the held failure starts no review fix round.
      expect(agents.received("findings")).toHaveLength(2);
      expect(agents.received("build")).toHaveLength(6);
      expect(agents.received("brief")).toHaveLength(0);
      expect(agents.received("objections")).toHaveLength(0);

      return { id };

    }, { startAgentSession: agents.start });

    await withEngine(async engine => {
      expect(engine.task(id)!.repositories!.map((work) => work.acceptanceReturns)).toEqual([2, 2]);
      expect(agents.received("build")).toHaveLength(6);
      // An asymmetric saved allowance must be renewed too, rather than blocking the next shared pass.
      engine.setPoolPaused(true);
      const current = engine.task(id)!;
      const inactive = current.repositories!.find((work) => work.productId !== current.productId)!;
      inactive.acceptanceReturns = 1;
      engine.requestChanges(itemOf(engine.getState(), id, "delivery")!.id, "Try a new approach across both products");
      expect(current.repositories!.map((work) => work.acceptanceReturns ?? 0)).toEqual([0, 0]);
      // Re-exhaustion after this renewed checkpoint is a portable controller case in shared-renewal.test.ts.
      expect(shop.github().prs).toHaveLength(0); expect(api.github().prs).toHaveLength(0);

    }, { startAgentSession: agents.start });

    });
  });
});
