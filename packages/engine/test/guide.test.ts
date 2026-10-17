import { afterAll, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { State, Task } from "@petrina/core";
import { Engine } from "../src/engine.js";
import type { Scenario } from "./fake-agent.js";
import { Fakes, git, makeProduct, removeDir, tempDir, waitFor } from "./support.js";

const roots: string[] = [];
afterAll(() => roots.forEach(removeDir));

const POINT = "Every greeting also shows on the welcome page.";

/** A task up to its delivery check, sent back with a note; `onGuide` answers the review-guide offer as it appears. */
async function sendBack(scenario: Scenario, onGuide: (engine: Engine, itemId: string) => void) {
  const root = tempDir("petrina-guide-");
  roots.push(root);
  const fakes = new Fakes(join(root, "fake"));
  fakes.scenario({ planner: "short", ...scenario });
  const engine = new Engine(join(root, "data"), { agentCommand: () => [process.execPath, join(import.meta.dir, "fake-agent.ts"), fakes.dir] });
  const productId = await engine.addProduct(makeProduct(root));
  engine.setProductDelivery(productId, "local", true);
  const taskId = engine.addTask({ productId, title: "Add a greeting" });
  const offers: { blocking: boolean; body?: string }[] = [];
  const until = (done: (state: State) => unknown, what: string) =>
    waitFor(() => {
      const state = engine.getState();
      for (const item of state.inbox) {
        if (item.taskId !== taskId) continue;
        if (item.kind === "plan") engine.approve(item.id);
        else if (item.kind === "permission") engine.allow(item.id, "once");
        else if (item.kind === "guide") {
          offers.push({ blocking: item.blocking, ...(item.body ? { body: item.body } : {}) });
          onGuide(engine, item.id);
        }
      }
      const task = state.tasks.find((entry) => entry.id === taskId) as Task | undefined;
      if (task?.state === "failed") throw new Error(`The task failed: ${task.error}`);
      return done(state) && task;
    }, what, 60_000) as Promise<Task>;
  const delivery = (state: State) => state.inbox.find((item) => item.taskId === taskId && item.kind === "delivery");
  await until(delivery, "the delivery check");
  engine.requestChanges(delivery(engine.getState())!.id, "The welcome page lost its greeting");
  const task = await until((state) => delivery(state) && state.tasks.find((entry) => entry.id === taskId)?.fixing === false && !state.tasks.find((entry) => entry.id === taskId)?.miss, "the delivery check again");
  return { engine, fakes, task, offers, productId };
}

const lines = (task: Task) => task.timeline.map((entry) => entry.text);

describe.concurrent("a review guide that learns from misses", () => {
  it("offers a point when the coordinator sends back what reviewers passed; accepted, reviewers check it and it lands in REVIEW.md", async () => {
    const { engine, fakes, task, offers, productId } = await sendBack({}, (engine, id) => engine.approve(id));
    try {
      // An offer that never holds the task up.
      expect(offers).toEqual([{ blocking: false, body: POINT }]);
      expect(lines(task)).toContain(`You added to the review guide: ${POINT}`);
      expect(engine.getState().products.find((entry) => entry.id === productId)!.reviewGuide).toMatchObject([{ text: POINT, fromTask: task.id, writtenOn: task.id }]);

      // The next round's reviewer read it, and the branch that ships carries it in REVIEW.md.
      const reviews = fakes.openings("code reviewer");
      expect(reviews.at(-1)).toContain("The product's review guide (REVIEW.md): check the change against every point");
      expect(reviews.at(-1)).toContain(POINT);
      expect(readFileSync(join(task.worktree!, "REVIEW.md"), "utf8")).toContain(`- ${POINT}`);
      expect(git(task.worktree!, "log", "-1", "--format=%s")).toBe("Review guide: one more point");
    } finally {
      engine.shutdown();
    }
  });

  it("leaves the guide alone when the coordinator says not this time", async () => {
    const { engine, task, offers, productId } = await sendBack({}, (engine, id) => engine.declineGuide(id));
    try {
      expect(offers).toHaveLength(1);
      expect(lines(task)).toContain("You left the review guide as it is");
      expect(engine.getState().products.find((entry) => entry.id === productId)!.reviewGuide).toBeUndefined();
    } finally {
      engine.shutdown();
    }
  });

  it("offers nothing when the note was a change of mind", async () => {
    const { engine, task, offers } = await sendBack({ guide: "change of mind" }, () => undefined);
    try {
      expect(offers).toEqual([]);
      expect(lines(task)).toContain("Nothing for the review guide: The note asks for a new colour: a change of mind, not a miss.");
    } finally {
      engine.shutdown();
    }
  });
});
