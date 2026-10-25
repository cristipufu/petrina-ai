import { afterAll, describe, expect, it } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { ScriptedAgents, scriptedResult } from "../../scripted-agents.js";
import { answersTo, findingIds } from "../../scripted-findings.js";
import { coordinator, itemOf, removeDir, taskOf, until, type World } from "../../support.js";
import { sharedWorld } from "../../fixtures/shared-world.js";
const worlds: World[] = [], recordRoots: string[] = [];
afterAll(() => { worlds.forEach(world => removeDir(world.dir)); recordRoots.forEach(removeDir); });
const setup = (name: string) => sharedWorld(name, worlds);

describe.concurrent("shared-task repair regressions", () => {
  it("stops at exhausted acceptance allowances, keeps them after restart and renews every product on send-back", async () => {
    const { shop, api, start } = await setup("acceptance-exhausted");
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
    const restart = () => start({ startAgentSession: agents.start });
    let engine = restart();
    try {
      const first = await engine.addProduct(shop.clone), second = await engine.addProduct(api.clone, "API");
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
      await engine.shutdown(); engine = restart();
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
    } finally { await engine.shutdown(); }
  });
});
