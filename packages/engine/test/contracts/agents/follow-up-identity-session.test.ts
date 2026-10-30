import { afterAll, expect, it } from "bun:test";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { Fakes } from "../../fixtures.js";
import { fakeAgentSessions } from "../../fixtures/fake-agent-sessions.js";
import { createFollowUpFixtures, recordedFollowUpProduct, older, taskOf, finish, cards } from "../../fixtures/follow-up-native.js";
import { privateAgentToolProbe } from "../../scripted-probes.js";
const { use, close } = createFollowUpFixtures();
afterAll(close);
it("asks the reviewer's tool once when two wordings need a match", async () => {
  return use(async caseOwner => {
  const root = caseOwner.root;
  const fakes = new Fakes(join(root, "agents"));
  fakes.scenario({ followUpMatch: "same" });
  const engine = caseOwner.open(join(root, "data"), { agentCommand: () => [process.execPath, join(import.meta.dir, "../../fake-agent.ts"), fakes.dir], startAgentSession: fakeAgentSessions(fakes), toolProbe: privateAgentToolProbe() });
  let counted = false;
  let unsubscribe: (() => void) | undefined;
  caseOwner.onStop(() => unsubscribe?.());
  try {
    engine.setPoolPaused(true);
    unsubscribe = engine.subscribe(() => { if (engine.s.backgroundAgents?.length) counted = true; });
    await engine["followUps"].catchUp();
    const shop = recordedFollowUpProduct(engine, "shop", "Shop");
    const task = taskOf(engine, shop, "Two reviewers", [
      older("one", "bug-agent: The footer opens a retired page."),
      older("two", "bug-agent: Choosing About still lands on the old page.", { raisedBy: "sol-high", roleId: "security-reviewer" }),
    ]);
    engine.setPoolPaused(false);
    await finish(caseOwner, engine, task);
    expect(cards(engine)).toHaveLength(1);
    expect(cards(engine)[0]!.followUp!.reports.map((report) => report.findingId).sort()).toEqual(["one", "two"]);
    expect(task.findings.every((finding) => finding.tracking && "taskId" in finding.tracking && finding.tracking.taskId === cards(engine)[0]!.id)).toBe(true);
    expect(fakes.prompts().some((prompt) => prompt.includes("Which older reports are the same bug"))).toBe(true);
    expect(counted).toBe(true);
    expect(engine.s.backgroundAgents).toEqual([]);
    expect(readdirSync(join(engine.dataDir, "matching"))).toEqual([]);
  } finally { unsubscribe?.(); await caseOwner.stop(engine); }
  });
});
