import { afterAll, expect, it } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { Engine } from "../src/engine.js";
import { Fakes, makeProduct, removeDir, tempDir, waitFor } from "./support.js";

const roots: string[] = [];
afterAll(() => roots.forEach(removeDir));

for (const [mode, afterPeer] of [["queue", false], ["interrupt", false], ["queue", true]] as const) it(`delivers a coordinator ${mode} message to every unfinished reviewer${afterPeer ? " after a peer reports" : " working in parallel"}`, async () => {
  const root = tempDir("petrina-review-messages-");
  roots.push(root);
  const fakes = new Fakes(join(root, "fake"));
  fakes.scenario({ planner: "parallel", builder: "plain", controlled: true });
  const engine = new Engine(join(root, "data"), { agentCommand: () => [process.execPath, join(import.meta.dir, "fake-agent.ts"), fakes.dir] });
  const release = (session: string) => writeFileSync(join(fakes.dir, `release-${session}`), "go");
  const productId = await engine.addProduct(makeProduct(root));
  const taskId = engine.addTask({ productId, title: "Add a greeting", description: "[no-check]" });
  const task = () => engine.getState().tasks.find((entry) => entry.id === taskId)!;
  try {
    await waitFor(() => {
      for (const item of engine.getState().inbox) {
        if (item.kind === "plan") engine.approve(item.id);
        else if (item.kind === "permission") engine.allow(item.id, "once");
        else if (item.kind === "question") engine.answer(item.id, "Yes");
      }
      for (const entry of fakes.received()) if (entry.role !== "code reviewer") release(entry.session);
      return fakes.received("code reviewer").length >= 2;
    }, "both reviewers to start");
    const reviewers = [...new Set(fakes.received("code reviewer").map((entry) => entry.session))];
    engine.setPoolPaused(true);
    if (afterPeer) {
      release(reviewers.shift()!);
      await waitFor(() => Object.keys(task().hunt?.reported ?? {}).length === 1, "one reviewer to finish before the message");
    }
    engine.sendMessage(taskId, "Check the guest view too", mode);
    for (const session of reviewers) release(session);
    await waitFor(() => task().state === "waiting" && !task().holdsSlot, "the reviewers to hand back while the pool is paused");
    const heard = fakes.received("code reviewer").filter((entry) => entry.text.includes("Check the guest view too"));
    expect(new Set(heard.map((entry) => entry.session))).toEqual(new Set(reviewers));
    expect(heard).toHaveLength(reviewers.length);
    expect(task().queued).toEqual([]);
  } finally { await engine.shutdown(); }
});
