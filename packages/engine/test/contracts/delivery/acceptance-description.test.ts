import { engineCaseFixtures, type EngineCaseOwner } from "../../fixtures/engine-cases.js";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { afterAll as closeOwnedCases } from "bun:test";
import { expect, it } from "bun:test";
import { createTaskState } from "@petrina/core";
import { executionFor } from "@petrina/orchestrator";
const cases = engineCaseFixtures();
closeOwnedCases(() => cases.close());


const REQUIRED = "People see the greeting on the welcome page";
const SECOND = "The greeting reads well on a phone";
const THIRD = "The greeting matches the product's tone";
const UNAVAILABLE = "The hosted preview account is unavailable, so the welcome page could not be opened.";
async function fixture(owner: EngineCaseOwner, _options: { checklist: readonly string[] }) {
  const root = mkdtempSync(join(owner.root, "acceptance-description-"));
  const engine = owner.open(root, {});
  const task = createTaskState({ productId: "product", title: "Greeting", backlog: true },
  [{ id: "product", name: "Product", repo: "local/product", tone: "blue" }], { id: "task", timelineId: "created", now: 1, priority: 0 });
  task.repository = { productId: task.productId, delivery: "local" };
  task.plan = { rationale: "The description lists acceptance before its reviewer credits", plannerProfileId: "sol-high",
    stages: [{ id: "review", kind: "review-chain", title: "Review", roleId: "code-reviewer", profileIds: ["sol-high"], maxRounds: 1 }] };
  return { engine, task, scope: executionFor(task), close: async () => { await owner.stop(engine);  } };
}

it("says Could not verify, unticked, for an unavailable item in a pull request's acceptance checklist", async () => {
  return cases.use("petrina-engine-case-", async owner => {
    const f = await fixture(owner, { checklist: [] });
    try {
      await owner.run(f.engine, async () => {
        f.task.brief = { summary: "Show the greeting", areas: [], forUsers: [], risks: [], acceptance: [
            { text: REQUIRED, verification: "blocked", reason: UNAVAILABLE }, { text: SECOND, met: true, verification: "passed" }, { text: THIRD, met: false, verification: "failed" }, { text: "Not tried yet" },
          ] };
        expect(f.engine["shipping"]["pullRequestBody"](f.scope)).toContain(`### Acceptance\n- [ ] ${REQUIRED} (Could not verify)\n- [x] ${SECOND}\n- [ ] ${THIRD}\n- Not tried yet\n`);

      });
    } finally { await f.close(); }

  });
});
