import { setupWithCleanup } from "@petrina/test-support/setup-with-cleanup";
import { afterAll, afterEach, describe, expect, it } from "bun:test";
import { join } from "node:path";
import { journeyProblems, type Task } from "@petrina/core";
import { Engine } from "../../engine.js";
import { EARLIER_ATTEMPT } from "../../../src/prompts.js";
import { engineProcessCases, Fakes, makeProduct, removeDir, tempDir, waitFor } from "../../support.js";

const roots: string[] = [];
const cases = engineProcessCases();
afterEach(() => cases.close());
afterAll(() => roots.forEach(removeDir));

async function setup() {
  const root = tempDir("petrina-restart-");
  const owners = cases.open(root);
  const use = async <T>(body: () => Promise<T>): Promise<T> => {
    const value = await setupWithCleanup(() => owners.prepare(body), () => owners.close());
    await owners.close(); return value;
  };
  return setupWithCleanup(() => owners.prepare(async () => ({ owners, use, product: await makeProduct(root), home: join(root, "home"), fakes: new Fakes(join(root, "fake")) })), () => owners.close());
}

describe("what the coordinator says during a step survives a restart", () => {
  for (const stop of ["quit", "kill", "pause"] as const) {
    it(`reaches the agent that starts the step again, after ${stop === "quit" ? "an ordinary quit" : stop === "kill" ? "a forced kill" : "pausing and resuming"}`, async () => {
      const run = await setup();
      return run.use(async () => {
        const owners = run.owners;
        const { product, home, fakes } = run;

        fakes.scenario({ planner: "short", builder: "restart" });
        let engine = await owners.harness(home, fakes.dir);
        const productId = (await owners.run(engine, async () => engine.act("addProduct", product))) as string;
        await owners.run(engine, async () => engine.act("setProductDelivery", productId, "local", false));
        const taskId = (await owners.run(engine, async () => engine.act("addTask", { productId, title: "Add a greeting" }))) as string;

        const asked = await owners.run(engine, async () => engine.until((state) => state.inbox.some((item) => item.taskId === taskId && item.kind === "question"), "the builder's question"));
        const question = asked.inbox.find((item) => item.taskId === taskId && item.kind === "question")!;
        const box = asked.tasks.find((task) => task.id === taskId)!.journey!.at(-1)!;
        expect(box).toMatchObject({ kind: "agent", roleId: "builder" });
        await owners.run(engine, async () => engine.act("answer", question.id, "Blue, please", { taskId, about: question.title, clientId: "c1" }));
        await waitFor(() => fakes.marked("builder-answered"), "the builder to get the answer");
        await owners.run(engine, async () => engine.act("sendMessage", taskId, "Keep it short", "queue", "c2"));
        await owners.run(engine, async () => engine.act("sendMessage", taskId, "Use exclamation marks", "interrupt", "c3"));
        await waitFor(() => fakes.marked("builder-interrupted"), "the builder to get the interruption");
        // The last message goes in less than a second before Petrina stops.
        await owners.run(engine, async () => engine.act("sendMessage", taskId, "Sign it from the team", "queue", "c4"));
        if (stop === "pause") {
          await owners.run(engine, async () => engine.act("pause", taskId));
          await owners.run(engine, async () => engine.act("resume", taskId));
        } else {
          if (stop === "quit") await engine.quit();
          else await engine.kill();
          engine = await owners.harness(home, fakes.dir);
        }
        const state = await owners.run(engine, async () => engine.until((current) => current.tasks.find((task) => task.id === taskId)?.state === "done", "the task to finish", 60_000));
        const task = state.tasks.find((entry) => entry.id === taskId)!;

        const builders = fakes.openings("builder");
        expect(builders).toHaveLength(2);
        expect(builders[0]).not.toContain(EARLIER_ATTEMPT);
        const restarted = builders[1]!;
        expect(restarted).toContain(EARLIER_ATTEMPT);
        // Heard context stays earlier; the waiting instruction joins the actual prompt once.
        const said = [
          "(earlier attempt) The agent asked: Which colour should the greeting be? | The coordinator answered: Blue, please",
          "(earlier attempt) A message from the coordinator: Keep it short",
          "(earlier attempt) The coordinator interrupted with: Use exclamation marks",
          "1. Sign it from the team",
        ].map((line) => restarted.indexOf(line));
        expect(said.every((at) => at >= 0)).toBe(true);
        expect([...said].sort((a, b) => a - b)).toEqual(said);
        expect(restarted.split("Sign it from the team")).toHaveLength(2);
        expect(task.timeline.some((entry) => entry.text === "Handed on 3 things you said in an earlier attempt at this step")).toBe(true);
        // The journey survived it: one builder box throughout, from when the step first started, its question answered under it.
        const builderBoxes = task.journey!.filter((step) => step.roleId === "builder");
        expect(builderBoxes).toHaveLength(1);
        expect(builderBoxes[0]).toMatchObject({ id: box.id, startedAt: box.startedAt, end: "done" });
        expect(builderBoxes[0]!.asks).toEqual([expect.objectContaining({ title: "Which colour should the greeting be?", how: "answered", answer: "Blue, please" })]);
        expect(task.timeline.filter((entry) => entry.text.startsWith("You said") || entry.text === "You answered: Blue, please").every((entry) => entry.step === box.id)).toBe(true);
        expect(journeyProblems(task)).toEqual([]);

        // The step finished: the next one does not get them again.
        const reviewers = fakes.openings("code reviewer");
        expect(reviewers).toHaveLength(1);
        expect(reviewers[0]).not.toContain(EARLIER_ATTEMPT);
        expect(task.stepNotes).toBeUndefined();
        await engine.quit();

      });
    });
  }
});

describe("a message sent as the engine is killed", () => {
  it("is kept exactly once after the window sends it again", async () => {
    const run = await setup();
    return run.use(async () => {
      const owners = run.owners;
      const { product, home, fakes } = run;

      let engine = await owners.harness(home, fakes.dir);
      await owners.run(engine, async () => engine.act("setPoolPaused", true));
      const productId = (await owners.run(engine, async () => engine.act("addProduct", product))) as string;
      const taskId = (await owners.run(engine, async () => engine.act("addTask", { productId, title: "Hold still" }))) as string;
      await Bun.sleep(600);

      // Killed before, while or just after the engine saves it: the window never hears back either way.
      for (const [index, delay] of [0, 1, 5, 20, 60].entries()) {
        const text = `Message ${index}`;
        const clientId = `send-${index}`;
        const socket = await owners.run(engine, async () => engine.socket());
        socket.send(JSON.stringify({ id: 1, action: { name: "sendMessage", args: [taskId, text, "queue", clientId] } }));
        if (delay) await Bun.sleep(delay);
        await engine.kill();
        engine = await owners.harness(home, fakes.dir);
        // Reconnected: the window sends what it never got a confirmation for.
        await owners.run(engine, async () => engine.act("sendMessage", taskId, text, "queue", clientId));
        const task = await owners.run(engine, async () => engine.task(taskId));
        expect(task.queued.filter((message) => message.text === text)).toHaveLength(1);
        expect(task.stepNotes?.filter((note) => note.text === text)).toHaveLength(1);
      }
      await engine.quit();

    });
  });
});

describe("what the coordinator says is kept for the step", () => {
  const root = tempDir("petrina-steps-");
  roots.push(root);
  const engine = new Engine(join(root, "data"));
  afterAll(() => engine.shutdown());

  async function waitingTask(): Promise<() => Task> {
    engine.setPoolPaused(true);
    const productId = `private-message-product-${engine.s.products.length + 1}`;
    engine.s.products.push({ id: productId, name: `Product ${engine.s.products.length + 1}`, repo: `local/${productId}`, tone: "blue", delivery: "local" });
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
