import { expect, it } from "bun:test";
import { createTaskState } from "@petrina/core";
import { Engine } from "../../engine.js";
import { executionFor } from "@petrina/orchestrator";
import { removeDir, tempDir } from "../../fixtures.js";
const REQUIRED = "People see the greeting on the welcome page";
const SECOND = "The greeting reads well on a phone";
const THIRD = "The greeting matches the product's tone";
const UNAVAILABLE = "The hosted preview account is unavailable, so the welcome page could not be opened.";
async function fixture(_options: { checklist: readonly string[] }) {
 const root = tempDir("acceptance-description-");
 const engine = new Engine(root);
 const task = createTaskState({ productId: "product", title: "Greeting", backlog: true },
   [{ id: "product", name: "Product", repo: "local/product", tone: "blue" }], { id: "task", timelineId: "created", now: 1, priority: 0 });
 task.repository = { productId: task.productId, delivery: "local" };
 task.plan = { rationale: "The description lists acceptance before its reviewer credits", plannerProfileId: "sol-high",
   stages: [{ id: "review", kind: "review-chain", title: "Review", roleId: "code-reviewer", profileIds: ["sol-high"], maxRounds: 1 }] };
 return { engine, task, scope: executionFor(task), close: async () => { await engine.shutdown(); removeDir(root); } };
}

it("says Could not verify, unticked, for an unavailable item in a pull request's acceptance checklist", async () => {
  const f = await fixture({ checklist: [] });
  try {
    f.task.brief = { summary: "Show the greeting", areas: [], forUsers: [], risks: [], acceptance: [
      { text: REQUIRED, verification: "blocked", reason: UNAVAILABLE }, { text: SECOND, met: true, verification: "passed" }, { text: THIRD, met: false, verification: "failed" }, { text: "Not tried yet" },
    ] };
    expect(f.engine["shipping"]["pullRequestBody"](f.scope)).toContain(`### Acceptance\n- [ ] ${REQUIRED} (Could not verify)\n- [x] ${SECOND}\n- [ ] ${THIRD}\n- Not tried yet\n`);
  } finally { await f.close(); }
});
