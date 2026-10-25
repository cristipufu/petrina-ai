import { expect, it } from "bun:test";
import { join } from "node:path";
import { z } from "zod";
import { setupWithCleanup } from "@petrina/test-support/setup-with-cleanup";
import { executionFor } from "@petrina/orchestrator";
import { directDrivers } from "../../fixtures/direct-drivers.js";
import { tempDir } from "../../fixtures.js";

/** Real Turns adapter/recovery/selection; only the unrelated native session attempt is substituted. */
async function fixture(member: boolean) {
  const root = tempDir("petrina-recovery-callbacks-"), owner = directDrivers(root);
  return setupWithCleanup(() => owner.prepare(async () => {
    const engine = owner.open(join(root, "data"), { agentCommand: () => undefined }); engine.schedule = () => {};
    await engine.waitUntilReady(); engine.setPoolPaused(false);
    engine.s.tools = engine.s.tools.map(tool => ({ ...tool, status: "ready" }));
    engine.s.setup!.checks = ["codex", "claude-code", "grok", "antigravity"].map(id => ({ id: id as "codex", status: "ready" }));
    engine.s.products.push({ id: "product", name: "Product", repo: "local/product", tone: "blue", delivery: "local" });
    const task = engine.task(engine.addTask({ productId: "product", title: "Callback owner", backlog: true }))!;
    task.plan = { rationale: "Exact callback wiring", plannerProfileId: "sol-high", stages: [{ id: "target", title: "Target", kind: member ? "review-chain" : "do", roleId: member ? "code-reviewer" : "builder", profileIds: ["sol-high"], maxRounds: 1 }] };
    task.stageIndex = 0; task.state = "running";
    if (member) task.hunt = { stageId: "target", round: 1, reported: {}, findings: 0 };
    const turns = engine["turns"], originalMain = turns["attempt"], originalMember = turns["attemptTogether"];
    turns["attempt"] = async <T>() => "Completed" as T;
    turns["attemptTogether"] = async <T>() => "Completed" as T;
    return { engine, task, turns, scope: executionFor(task), owner,
      close: async () => { turns["attempt"] = originalMain; turns["attemptTogether"] = originalMember; await owner.close(); },
    };
  }), owner.close);
}

for (const member of [false, true]) it(`keeps original used callback ownership and ${member ? "the bound member guard beside a raw selector callback" : "the raw main room callback"}`, async () => {
  const f = await fixture(member);
  let free = 0, bound = 0, used = 0;
  // The real selector consults room for substitutes, whereas a healthy planned profile skips that callback.
  f.task.modelCapacity = [{ toolId: "codex", modelId: "gpt-6.1-sol", profileId: "sol-high", until: Date.now() + 60_000 }];
  const options = {
    marker: "original-options",
    room(this: { marker: string } | undefined) {
      if (this === undefined) free++;
      else { expect(this).toBe(options); expect(this.marker).toBe("original-options"); bound++; }
      return true;
    },
    used(this: { marker: string }, profileId: string) { expect(this).toBe(options); expect(profileId).toBe("astra-xhigh"); used++; },
  };
  try {
    const result = await f.owner.run(f.engine, () => member
      ? f.turns.parallel(f.scope, "code-reviewer", "sol-high", "unused:attempt-is-controlled", () => [], z.string(), new AbortController().signal, options)
      : f.turns.turn(f.scope, "builder", "sol-high", () => [], z.string(), new AbortController().signal, options));
    expect(result).toBe("Completed"); expect(used).toBe(1);
    expect(free).toBeGreaterThan(0); expect(bound).toBe(member ? 1 : 0);
  } finally { await f.close(); }
});

it("keeps the accepted parallel seat ahead of selection and its explicit room recheck", async () => {
  const f = await fixture(true);
  const options = { seat: "sol-high", room() { throw new Error("An accepted first seat must not reselect or repeat its room check"); } };
  try {
    expect(await f.owner.run(f.engine, () => f.turns.parallel(f.scope, "code-reviewer", "sol-high", "unused:attempt-is-controlled", () => [], z.string(), new AbortController().signal, options))).toBe("Completed");
  } finally { await f.close(); }
});
