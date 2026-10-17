import { afterAll, describe, expect, it } from "bun:test";
import { join } from "node:path";
import type { Task } from "@petrina/core";
import { Engine } from "../src/engine.js";
import { EARLIER_ATTEMPT } from "../src/prompts.js";
import { EngineProcess, Fakes, makeProduct, removeDir, tempDir, waitFor } from "./support.js";

const roots: string[] = [];
afterAll(() => roots.forEach(removeDir));

function setup() {
  const root = tempDir("petrina-restart-");
  roots.push(root);
  return { product: makeProduct(root), home: join(root, "home"), fakes: new Fakes(join(root, "fake")) };
}

describe("what the coordinator says during a step survives a restart", () => {
  for (const stop of ["quit", "kill", "pause"] as const) {
    it(`reaches the agent that starts the step again, after ${stop === "quit" ? "an ordinary quit" : stop === "kill" ? "a forced kill" : "pausing and resuming"}`, async () => {
      const { product, home, fakes } = setup();
      fakes.scenario({ planner: "short", builder: "restart" });
      let engine = await EngineProcess.harness(home, fakes.dir);
      const productId = (await engine.act("addProduct", product)) as string;
      await engine.act("setProductDelivery", productId, "local", false);
      const taskId = (await engine.act("addTask", { productId, title: "Add a greeting" })) as string;

      const asked = await engine.until((state) => state.inbox.some((item) => item.taskId === taskId && item.kind === "question"), "the builder's question");
      const question = asked.inbox.find((item) => item.taskId === taskId && item.kind === "question")!;
      await engine.act("answer", question.id, "Blue, please", { taskId, about: question.title, clientId: "c1" });
      await waitFor(() => fakes.marked("builder-answered"), "the builder to get the answer");
      await engine.act("sendMessage", taskId, "Keep it short", "queue", "c2");
      await engine.act("sendMessage", taskId, "Use exclamation marks", "interrupt", "c3");
      await waitFor(() => fakes.marked("builder-interrupted"), "the builder to get the interruption");
      // The last message goes in less than a second before Petrina stops.
      await engine.act("sendMessage", taskId, "Sign it from the team", "queue", "c4");
      if (stop === "pause") {
        await engine.act("pause", taskId);
        await engine.act("resume", taskId);
      } else {
        if (stop === "quit") await engine.quit();
        else await engine.kill();
        engine = await EngineProcess.harness(home, fakes.dir);
      }
      const state = await engine.until((current) => current.tasks.find((task) => task.id === taskId)?.state === "done", "the task to finish", 60_000);
      const task = state.tasks.find((entry) => entry.id === taskId)!;

      const builders = fakes.openings("builder");
      expect(builders).toHaveLength(2);
      expect(builders[0]).not.toContain(EARLIER_ATTEMPT);
      const restarted = builders[1]!;
      expect(restarted).toContain(EARLIER_ATTEMPT);
      // All of it, in order, each marked as earlier, the answer next to its question.
      const said = [
        "(earlier attempt) The agent asked: Which colour should the greeting be? | The coordinator answered: Blue, please",
        "(earlier attempt) A message from the coordinator: Keep it short",
        "(earlier attempt) The coordinator interrupted with: Use exclamation marks",
        "(earlier attempt) A message from the coordinator: Sign it from the team",
      ].map((line) => restarted.indexOf(line));
      expect(said.every((at) => at >= 0)).toBe(true);
      expect([...said].sort((a, b) => a - b)).toEqual(said);
      expect(task.timeline.some((entry) => entry.text === "Handed on 4 things you said in an earlier attempt at this step")).toBe(true);

      // The step finished: the next one does not get them again.
      const reviewers = fakes.openings("code reviewer");
      expect(reviewers).toHaveLength(1);
      expect(reviewers[0]).not.toContain(EARLIER_ATTEMPT);
      expect(task.stepNotes).toBeUndefined();
      await engine.quit();
    });
  }
});

describe("a message sent as the engine is killed", () => {
  it("is kept exactly once after the window sends it again", async () => {
    const { product, home, fakes } = setup();
    let engine = await EngineProcess.harness(home, fakes.dir);
    await engine.act("setPoolPaused", true);
    const productId = (await engine.act("addProduct", product)) as string;
    const taskId = (await engine.act("addTask", { productId, title: "Hold still" })) as string;
    await Bun.sleep(600);

    // Killed before, while or just after the engine saves it: the window never hears back either way.
    for (const [index, delay] of [0, 1, 5, 20, 60].entries()) {
      const text = `Message ${index}`;
      const clientId = `send-${index}`;
      const socket = await engine.socket();
      socket.send(JSON.stringify({ id: 1, action: { name: "sendMessage", args: [taskId, text, "queue", clientId] } }));
      if (delay) await Bun.sleep(delay);
      await engine.kill();
      engine = await EngineProcess.harness(home, fakes.dir);
      // Reconnected: the window sends what it never got a confirmation for.
      await engine.act("sendMessage", taskId, text, "queue", clientId);
      const task = await engine.task(taskId);
      expect(task.queued.filter((message) => message.text === text)).toHaveLength(1);
      expect(task.stepNotes?.filter((note) => note.text === text)).toHaveLength(1);
    }
    await engine.quit();
  });
});

describe("what the coordinator says is kept for the step", () => {
  const root = tempDir("petrina-steps-");
  roots.push(root);
  const engine = new Engine(join(root, "data"));
  afterAll(() => engine.shutdown());

  async function waitingTask(): Promise<() => Task> {
    const product = makeProduct(join(root, `p${Date.now()}`));
    engine.setPoolPaused(true);
    const productId = await engine.addProduct(product, `Product ${engine.getState().products.length + 1}`);
    const taskId = engine.addTask({ productId, title: "Hold still" });
    return () => engine.getState().tasks.find((task) => task.id === taskId)!;
  }

  it("counts a resend once when its confirmation was lost", async () => {
    const task = await waitingTask();
    engine.sendMessage(task().id, "Only once", "queue", "same-id");
    engine.sendMessage(task().id, "Only once", "queue", "same-id");
    expect(task().queued).toHaveLength(1);
    expect(task().stepNotes).toHaveLength(1);
    expect(task().notes).toHaveLength(1);
  });

  it("forgets a message taken back before any agent got it", async () => {
    const task = await waitingTask();
    engine.sendMessage(task().id, "Never mind", "queue");
    engine.removeQueued(task().id, task().queued[0]!.id);
    expect(task().queued).toHaveLength(0);
    expect(task().stepNotes).toHaveLength(0);
    expect(task().notes).toHaveLength(0);
  });

  it("keeps an answer whose question a restart dropped, and hands it to the step", async () => {
    const task = await waitingTask();
    engine.answer("inbox-gone", "Green", { taskId: task().id, about: "Which colour?", clientId: "late-answer" });
    expect(task().stepNotes).toEqual([expect.objectContaining({ kind: "answer", text: "Green", about: "Which colour?" })]);
    expect(task().queued.at(-1)?.text).toBe("About your question “Which colour?”: Green");
  });
});
