import { describe, expect, it } from "vitest";
import { createDemoState, createPortfolioDemo } from "../../../src/demo.js";
import { journeyProblems, journeyView, type JourneyView } from "../../../src/journey.js";

import type { State, Task } from "../../../src/model.js";

import { Simulator } from "../../../src/sim.js";

const taskOf = (sim: Simulator, id: string): Task => sim.getState().tasks.find((entry) => entry.id === id)!;

const contextOf = (state: State) => ({ roles: state.roles, profiles: state.profiles, tasks: state.tasks, inbox: state.inbox, ...(state.planner ? { planner: state.planner } : {}) });

const viewOf = (sim: Simulator, id: string): JourneyView => journeyView(taskOf(sim, id), contextOf(sim.getState()));

const boxes = (view: JourneyView) => view.nodes.map((node) => `${node.name}: ${node.state}`);

describe("the demos", () => {
  const demos = [
    ["?demo", createDemoState(1_000_000_000_000)],
    ["?demo=portfolio", createPortfolioDemo(1_000_000_000_000).state],
  ] as const;

  for (const [name, state] of demos) {
    it(`${name}: every started task has a journey whose times match its timeline`, () => {
      for (const task of state.tasks) {
        if (task.state === "queued" && !task.after) {
          expect(task.journey, task.id).toBeUndefined();
          continue;
        }
        // A Backlog card is waiting to be queued, so it has not started and has no recorded journey.
        // One that was sent back after work began still has its journey, and is checked below.
        if (task.state === "backlog" && !task.journey) {
          expect(journeyProblems(task), task.id).toEqual([]);
          expect(journeyView(task, contextOf(state)).start, task.id).toEqual({ kind: "backlog" });
          continue;
        }
        expect(journeyProblems(task), task.id).toEqual([]);
        task.journey!.forEach((step, index) => {
          const lines = task.timeline.filter((entry) => entry.step === step.id);
          const where = `${task.id} ${step.id}`;
          // An agent's box starts with its "started" line; your steps start the moment the step before ended,
          // and end with what you decided.
          if (step.kind === "agent") expect(lines[0]?.at, where).toBe(step.startedAt);
          else if (step.kind === "you") expect(step.startedAt, where).toBe(task.journey![index - 1]?.endedAt);
          if (step.kind === "you" && step.endedAt !== undefined) expect(lines.at(-1)?.at, where).toBe(step.endedAt);
          for (const line of lines) expect(line.at, where).toBeGreaterThanOrEqual(step.startedAt);
        });
        const view = journeyView(task, contextOf(state));
        expect(view.nodes.length).toBeGreaterThan(0);
      }
    });
  }

  it("?demo has the call waiting on you, the delivery check after a send-back, open questions and a waiting task", () => {
    const [, state] = demos[0];
    const view = (id: string) => journeyView(state.tasks.find((task) => task.id === id)!, contextOf(state));
    expect(view("gift-cards").nodes.find((node) => node.state === "you")?.name).toBe("Your call");
    expect(boxes(view("pricing-refresh")).slice(2, 9)).toEqual([
      "Automated checks: done",
      "Code reviewer: done",
      "Builder (fixes): done",
      "Automated checks (round 2): done",
      "Code reviewer (round 2): done",
      "Your delivery check: you",
      "Publish delivery: next",
    ]);
    // Notes ships releases: the Release Manager writes the notes, then Petrina publishes.
    expect(boxes(view("dark-mode")).slice(-2)).toEqual(["Release Manager: ahead", "Publish delivery: ahead"]);
    expect(view("dark-mode").nodes.find((node) => node.state === "you")?.asks[0]).toMatchObject({ kind: "question" });
    expect(view("guest-checkout").nodes.find((node) => node.state === "you")?.asks[0]).toMatchObject({ kind: "permission" });
    expect(view("tag-search").nodes[0]).toMatchObject({ kind: "wait", live: "Waiting for “Dark mode” to land" });
  });

  it("?demo: allowing the permission and answering the question settle their capsules", () => {
    const sim = new Simulator(createDemoState(1_000_000_000_000));
    const item = (taskId: string) => sim.getState().inbox.find((entry) => entry.taskId === taskId && entry.blocking)!;
    sim.allow(item("guest-checkout").id, "once");
    sim.answer(item("dark-mode").id, "Follow the system setting");
    const asks = (id: string) => taskOf(sim, id).journey!.flatMap((step) => step.asks ?? []);
    expect(asks("guest-checkout")).toEqual([expect.objectContaining({ kind: "permission", how: "allowed" })]);
    expect(asks("dark-mode")).toEqual([expect.objectContaining({ kind: "question", how: "answered", answer: "Follow the system setting" })]);
    expect(viewOf(sim, "guest-checkout").nodes.some((node) => node.state === "you")).toBe(false);
  });

  it("?demo=portfolio has a long finished task", () => {
    const [, state] = demos[1];
    const task = state.tasks.find((entry) => entry.title === "Usage dashboard" && entry.state === "done")!;
    const view = journeyView(task, contextOf(state));
    expect(view.nodes).toHaveLength(22);
    expect(view.nodes.every((node) => node.state === "done")).toBe(true);
    expect(view.end?.state).toBe("done");
  });
});
