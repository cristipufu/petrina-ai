import { afterAll, expect, it } from "bun:test";
import { standInBrowser } from "./message-browser.js";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Fakes, makeWorld, removeDir, waitFor } from "./support.js";

const roots: string[] = [];
const browser = standInBrowser();
afterAll(() => { browser.mockRestore(); roots.forEach(removeDir); });

for (const [mode, afterPeer] of [["now", false], ["now", true], ["queue", false], ["interrupt", false], ["queue", true]] as const) it(`delivers a coordinator ${mode} message to every unfinished reviewer${afterPeer ? " after a peer reports" : " working in parallel"}`, async () => {
  const world = await makeWorld("review-messages");
  const root = world.dir;
  roots.push(root);
  const fakes = new Fakes(join(root, "fake"));
  fakes.scenario({ planner: "parallel", builder: "plain", controlled: true, ...(mode === "now" ? { live: "injected" } : {}) });
  const engine = world.start({ agentCommand: () => [process.execPath, join(import.meta.dir, "fake-agent.ts"), fakes.dir], usageCommands: { codex: null, grok: null, antigravity: null } });
  const release = (session: string) => writeFileSync(join(fakes.dir, `release-${session}`), "go");
  const productId = await engine.addProduct(world.clone);
  const taskId = engine.addTask({ productId, title: "Add a greeting", description: "[no-check]" });
  const task = () => engine.getState().tasks.find((entry) => entry.id === taskId)!;
  try {
    await waitFor(() => {
      if (task().state === "failed") throw new Error(task().error);
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
    const livePath = join(fakes.dir, "live.jsonl");
    if (mode === "now") {
      await waitFor(() => existsSync(livePath) && readFileSync(livePath, "utf8").trim().split("\n").length === reviewers.length, "every unfinished reviewer to receive live input before release");
      expect(task().queued[0]?.recipients && Object.keys(task().queued[0]!.recipients!)).toHaveLength(reviewers.length);
      expect(task().hunt?.reported && Object.keys(task().hunt!.reported!)).toHaveLength(afterPeer ? 1 : 0);
    }
    for (const session of reviewers) release(session);
    await waitFor(() => task().state === "waiting" && !task().holdsSlot, "the reviewers to hand back while the pool is paused");
    const heard: { session: string }[] = mode === "now" ? readFileSync(livePath, "utf8").trim().split("\n").map(line => ({ session: JSON.parse(line).sessionId })) : fakes.received("code reviewer").filter((entry) => entry.text.includes("Check the guest view too"));
    expect(new Set(heard.map((entry) => entry.session))).toEqual(new Set(reviewers));
    expect(heard).toHaveLength(reviewers.length);
    expect(task().queued).toEqual([]);
    if (mode === "now") expect(fakes.received("code reviewer")).toHaveLength(2);
  } finally { await engine.shutdown(); }
});
