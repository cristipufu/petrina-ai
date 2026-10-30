import { afterAll, describe, expect, it } from "bun:test";
import { chmodSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { finish, itemOf, taskOf } from "../../support.js";
import { sourceWorlds, pull, deliveryGate } from "../../fixtures/source-world.js";
const fixtures = sourceWorlds();
afterAll(() => fixtures.close());

describe.concurrent("source failures and delivery recovery",()=>{
for (const problem of ["closed", "deleted", "fork-refused"] as const) it(`preserves PR work when its destination becomes ${problem}`, async () => {
    const forks: Record<string, string> = {};
    await fixtures.world(`unavailable-${problem}`, async ({ w, engine: withEngine, candidate }) => {
    const source = await pull(w, problem === "fork-refused");
    forks["contributor/demo"] = source.remote;

    await withEngine(async engine => {

      const productId = await w.preparedProduct(engine);
      const id = await candidate(engine, { productId, title: "A greeting", description: "[quick]", startFrom: { kind: "pull-request", value: "7" } }, { checks: "none" });
      const state = await deliveryGate(engine, id);
      if (problem === "closed") w.setGitHub((github) => { github.prs[0]!.state = "CLOSED"; });
      else if (problem === "deleted") rmSync(join(w.remote, "refs", "heads", "review-work"), { force: true });
      else { const hook = join(source.remote, "hooks", "pre-receive"); writeFileSync(hook, "#!/bin/sh\nexit 1\n"); chmodSync(hook, 0o755); }
      engine.approve(itemOf(state, id, "delivery")!.id);
      const task = taskOf(await finish(engine, id), id);
      expect(task.state).toBe("failed"); expect(task.pr).toBeUndefined();
      expect(readFileSync(join(task.worktree!, "greeting.txt"), "utf8")).toContain("Hello");
      expect(w.github().prs).toHaveLength(1);
      if (problem === "fork-refused") expect(task.error).toContain("contributor/demo");

    });
    }, {}, forks);
  });
});
