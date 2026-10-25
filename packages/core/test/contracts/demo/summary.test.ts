import { describe, expect, it } from "vitest";
import { createDemoState, createFirstRunDemo, createPortfolioDemo, DEMO_PRODUCTS } from "../../../src/demo.js";
import { BUILT_IN_ROLES, DEFAULT_PROFILES, KNOWN_TOOLS } from "../../../src/library.js";
import type { State, Task } from "../../../src/model.js";
import { Simulator } from "../../../src/sim.js";

import { TODO_MAX, mainLine, nextLine, plainTodo, timeLeft } from "../../../src/summary.js";

function emptyState(): State {
  return {
    now: 0,
    seq: 0,
    products: [{ id: "p", name: "Product", repo: "acme/product", tone: "blue" }],
    roles: BUILT_IN_ROLES,
    tools: KNOWN_TOOLS,
    profiles: DEFAULT_PROFILES,
    tasks: [],
    inbox: [],
    pool: { limit: 4, paused: false, toolCaps: {} },
  };
}

const taskOf = (sim: Simulator, id: string): Task => sim.getState().tasks.find((task) => task.id === id)!;

const next = (sim: Simulator, id: string) => nextLine(sim.getState(), taskOf(sim, id));

const item = (sim: Simulator, kind: string) => sim.getState().inbox.find((entry) => entry.kind === kind);

function until(sim: Simulator, reached: () => boolean, approve = false): void {
  for (let tick = 0; tick < 400; tick += 1) {
    if (reached()) return;
    sim.tick();
    for (const entry of sim.getState().inbox) {
      if (entry.kind === "question") sim.answer(entry.id, entry.options?.[0] ?? "Yes");
      else if (entry.kind === "permission") sim.allow(entry.id, "once");
      else if (approve && entry.kind !== "disagreement") sim.approve(entry.id);
    }
  }
  throw new Error("never reached");
}

describe("the demo", () => {
  it("keeps the first task's to-do item through actions after setup, with Next and no guessed time", () => {
    const demo = createFirstRunDemo(1_000_000_000);
    const sim = new Simulator(demo.state, { log: demo.log, open: demo.open, quirks: demo.quirks, triggers: demo.triggers });
    const product = DEMO_PRODUCTS[0]!;
    sim.addProduct(product);
    const request = { productId: product.id, title: "Add a greeting", approvePlan: true, clientId: "first-summary" };
    const id = sim.startFirstTask(request);
    expect(sim.startFirstTask(request)).toBe(id);
    expect(sim.getState().setup?.done).toBe(true);
    until(sim, () => taskOf(sim, id).agent?.roleId === "planner" && !!taskOf(sim, id).todo);
    const todo = taskOf(sim, id).todo;
    sim.tick();
    const firstAction = taskOf(sim, id).statusLine;
    sim.tick();
    expect(taskOf(sim, id).statusLine).not.toBe(firstAction);
    expect(mainLine(taskOf(sim, id))).toBe(todo);
    expect(next(sim, id)).toBe("Next: your plan check");
    expect(timeLeft(sim.getState(), taskOf(sim, id))).toBeUndefined();
    until(sim, () => item(sim, "plan") !== undefined);
    expect(taskOf(sim, id).todo).toBeUndefined();
    expect(mainLine(taskOf(sim, id))).toBe(taskOf(sim, id).statusLine);
    expect(next(sim, id)).toMatch(/^Next: design \(/);
  });

  it("shows to-do items, Next lines, and a time estimate only where finished demo tasks give enough history", () => {
    const state = createDemoState(1_000_000_000);
    const find = (id: string) => state.tasks.find((task) => task.id === id)!;
    const working = find("login-loop");
    expect(working.state).toBe("running");
    expect(mainLine(working)).toBe("Trying to prove “done” wrong");
    expect(working.statusLine).toBe("Reading the code");
    expect(nextLine(state, working)).toBe("Next: your OK to ship, or fixes by the builder if blocking issues are found");
    expect(timeLeft(state, working)).toBe("About 30 minutes left");
    // Waiting on you mid-step: the card says so, and the to-do item it was on is kept.
    const asking = find("dark-mode");
    expect(mainLine(asking)).toBe("Waiting for your answer");
    expect(asking.todo).toBe("Sketching the dark mode flow");
    expect(nextLine(state, asking)).toBe("Next: design review (Codex · sol), then your design check");
    expect(timeLeft(state, asking)).toBeUndefined();
    // The newer demo has history for architects too. On an older install without records, the same
    // working task still shows no estimate; the extra demo history must not become a guessed default.
    expect(timeLeft({ ...state, tasks: state.tasks.map((task) => ({ ...task, steps: undefined })) }, working)).toBeUndefined();
    for (const task of state.tasks.filter((entry) => ["queued", "done"].includes(entry.state))) expect(nextLine(state, task)).toBeUndefined();
  });

  it("shows a demo to-do item as plain text, with the same limit as the engine", () => {
    const marked = new Simulator(emptyState(), { prMergeAfter: 1_000 });
    const markedId = marked.addTask({ productId: "p", title: "Improve **checkout**", kind: "feature" });
    const markedRaw = "Sketching the improve **checkout** flow";
    until(marked, () => taskOf(marked, markedId).todo === plainTodo(markedRaw), true);
    const shown = taskOf(marked, markedId).todo!;
    expect(shown).toBe("Sketching the improve checkout flow");
    expect(shown).not.toMatch(/[*_`#]/);
    expect(taskOf(marked, markedId).timeline.some((entry) => entry.text === shown)).toBe(true);

    const word = "checkout".repeat(12);
    const longRaw = `Sketching the ${word} ${word} flow`;
    expect(longRaw.length).toBeGreaterThan(TODO_MAX);
    const long = new Simulator(emptyState(), { prMergeAfter: 1_000 });
    const longId = long.addTask({ productId: "p", title: `Improve ${word} ${word}`, kind: "feature" });
    until(long, () => taskOf(long, longId).todo === plainTodo(longRaw), true);
    const capped = taskOf(long, longId).todo!;
    expect(capped).toBe(plainTodo(longRaw));
    expect(capped.length).toBeLessThanOrEqual(TODO_MAX);
    expect(capped.endsWith("…")).toBe(true);

    const when = 1_000_000_000;
    for (const state of [createDemoState(when), createPortfolioDemo(when).state]) {
      for (const task of state.tasks) {
        if (!task.todo) continue;
        expect(task.todo, task.title).toBe(plainTodo(task.todo));
        expect(task.todo.length, task.title).toBeLessThanOrEqual(TODO_MAX);
      }
    }
  });

  it("gives the portfolio's working tasks their to-do items and Next lines", () => {
    const portfolio = createPortfolioDemo(1_000_000_000).state;
    const running = portfolio.tasks.filter((task) => task.state === "running");
    expect(running.length).toBeGreaterThan(0);
    for (const task of running) {
      expect(task.todo).toBeTruthy();
      expect(mainLine(task)).toBe(task.todo);
      expect(task.statusLine).not.toBe(task.todo);
      expect(nextLine(portfolio, task)).toMatch(/^Next: /);
    }
  });
});
