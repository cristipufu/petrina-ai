import { engineCaseFixtures, type EngineCaseOwner } from "../../fixtures/engine-cases.js";
import { mkdtempSync } from "node:fs";
import { afterAll as closeOwnedCases } from "bun:test";
import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import { type DeepMutable, type Finding } from "@petrina/core";
import { Context } from "../../../src/context.js";
import { executionFor } from "@petrina/orchestrator";
const cases = engineCaseFixtures();
closeOwnedCases(() => cases.close());


const earlier: DeepMutable<Finding> = { id: "older", text: "An earlier bug", severity: "blocking", raisedBy: "sol-high", confirmedBy: [], status: "fixed", answer: { fixed: true, text: "Fixed the earlier bug", at: 1 } };

async function bare(owner: EngineCaseOwner) {
  const root = mkdtempSync(join(owner.root, "petrina-review-input-"));
  const base = "a".repeat(40), first = "b".repeat(40), repo = join(root,"unused-repository");
  const engine = owner.open(join(root, "data"), { admissionsClosed: true, agentCommand: () => undefined, usageCommands: { codex: null, grok: null, antigravity: null }, terminals: () => [] });
  engine.schedule = () => {}; engine.setPoolPaused(true);
  engine.s.products.push({ id: "p", name: "Product", repo: "local/product", tone: "blue" });
  const id = engine.addTask({ productId: "p", title: "A precise review", backlog: true });
  const task = engine.task(id)!;
  Object.assign(executionFor(task).work, { baseSha: base, base: "main", report: { summary: "Original Builder report", changes: [] } });
  task.findings = structuredClone([earlier]);
  task.brief = { summary: "Frozen brief", forUsers: [], areas: [], risks: [], acceptance: [] };
  const context = new Context(engine, { pendingPoints: async () => [] });
  return { root, repo, base, first, engine, task, context, scope: executionFor(task) };
}

describe("immutable review inputs", () => {
  it("omits settled native failures while retaining open failures and settled agent findings", async () => {
    return cases.use("petrina-engine-case-", async owner => {
      const f = await bare(owner);
      try {
        f.task.findings.push({ ...structuredClone(earlier), id: "native-fixed", raisedBy: "petrina", text: "Old native failure", evidence: "OLD-LONG-DIAGNOSTIC" }, { ...structuredClone(earlier), id: "native-open", status: "open", raisedBy: "petrina", text: "Still failing native check" });
        const input = await f.context.captureReview(f.scope);
        const body = input.parts.findings!.map((part) => part.body).join("\n");
        expect(body).not.toContain("OLD-LONG-DIAGNOSTIC"); expect(body).toContain("Still failing native check"); expect(body).toContain(earlier.text);
        expect(input.findings.map((finding) => finding.id)).toEqual([earlier.id, "native-open"]);
        expect(f.task.findings).toHaveLength(3);
      } finally { await owner.stop(f.engine); }

    });
  });
});
