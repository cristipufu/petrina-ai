import { afterAll, expect, it } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { nextLine, type State } from "@petrina/core";


import { EngineProcess, Fakes, git, makeProduct, removeDir, tempDir, waitFor } from "../../support.js";

const roots: string[] = [];
afterAll(() => roots.forEach(removeDir));

it("names and enforces the check for unresolved review issues when shipping normally needs no approval", async () => {
  const root = tempDir("petrina-review-next-"); roots.push(root);
  const fakes = new Fakes(join(root, "fake"));
  // One reviewer raises an Important finding in the only round; the voter holds until the test lets it go.
  fakes.scenario({ planner: "short", builder: "plain", reviewer: "important", verifier: "hold" });
  const engine = await EngineProcess.harness(join(root, "home"), fakes.dir);
  try {
    const product = await makeProduct(root);
    const productId = await engine.act("addProduct", product);
    await engine.act("setProductDelivery", productId, "local", false);
    const taskId = await engine.act("addTask", { productId, title: "Check the greeting" });
    const task = (state: State) => state.tasks.find((entry) => entry.id === taskId)!;
    await waitFor(() => fakes.marked("verifier-voting"), "the vote on an unresolved issue");
    const reviewing = await engine.state();
    expect(nextLine(reviewing, task(reviewing))).toBe("Next: your call, then Petrina commits to main");
    writeFileSync(join(fakes.dir, "release-vote"), "go");
    const waiting = await engine.until((state) => state.inbox.some((item) => item.kind === "delivery"), "the mandatory check");
    expect(task(waiting).landed).toBeUndefined();
    expect(nextLine(waiting, task(waiting))).toBe("Next: Petrina commits to main");
    await engine.act("approve", waiting.inbox.find((item) => item.kind === "delivery")!.id);
    const done = await engine.until((state) => ["done", "failed"].includes(task(state).state), "shipping after approval");
    expect(task(done).error).toBeUndefined();
    expect(task(done).state).toBe("done");
    expect(await git(product, "show", "main:greeting.txt")).toBe("Hello (with left-pad)");
  } finally { await engine.quit(); }
});
