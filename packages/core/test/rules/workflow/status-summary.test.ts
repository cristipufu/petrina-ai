import { summaryAt } from '../../fixtures/summary.js';
import { describe, expect, it } from "vitest";

import { OTHERS_CONTINUE, clearRunningTools, mainLine, plainTodo, retryingWords } from "../../../src/summary.js";
import { journeyView } from "../../../src/journey.js";

describe("the to-do item as plain text", () => {
  it("is one line with formatting marks removed", () => {
    expect(plainTodo("- [ ] **Working out** what the `engine` records\nper _step_")).toBe("Working out what the engine records per step");
    expect(plainTodo("## Read the [design brief](https://example.com/brief)")).toBe("Read the design brief");
    expect(plainTodo("1. Check ~~old~~ new <b>screens</b>")).toBe("Check old new screens");
    // Words that only look like formatting keep their spelling.
    expect(plainTodo("Update snake_case_names and 2 * 3")).toBe("Update snake_case_names and 2 * 3");
    expect(plainTodo("  \n ** \n")).toBeUndefined();
  });

  it("is at most about 100 characters, with an ellipsis", () => {
    const long = plainTodo(`Working out ${"what the engine records about each step ".repeat(5)}`)!;
    expect(long.length).toBeLessThanOrEqual(100);
    expect(long.endsWith("…")).toBe(true);
    expect(long).not.toContain("  ");
  });
});

describe("a card's main line", () => {
  const base = { statusLine: "Running a command", todo: "Working out what the engine records per step" };

  it("is the to-do item while the agent works, and the status line otherwise", () => {
    expect(mainLine({ ...base, state: "running" })).toBe(base.todo);
    expect(mainLine({ state: "running", statusLine: "Reading the code" })).toBe("Reading the code");
    for (const state of ["needs-you", "waiting", "paused", "failed", "cancelled", "done", "pr-open"] as const) {
      expect(mainLine({ ...base, state, statusLine: "Waiting for your answer" })).toBe("Waiting for your answer");
    }
  });
});

describe("a tool that retries by itself", () => {
  const reconnecting = retryingWords("Codex", "network");

  const base = { statusLine: "Reading the code", todo: "Working out what the engine records per step", retrying: reconnecting };

  it("names the tool, and claims a lost connection only when the tool reported one", () => {
    expect(reconnecting).toBe("Reconnecting to Codex. Trying automatically.");
    expect(retryingWords("Grok", "transient")).toBe("Grok hit a temporary problem. Retrying automatically.");
    expect(retryingWords("Grok", "transient")).not.toMatch(/connect/i);
  });

  it("comes ahead of the saved to-do item and the latest action while the task works", () => {
    expect(mainLine({ ...base, state: "running" })).toBe(reconnecting);
    // A wait for the coordinator still comes first.
    expect(mainLine({ ...base, state: "needs-you", statusLine: "Waiting for your permission" })).toBe("Waiting for your permission");
    // Once useful work resumes, the to-do item is the main line again.
    const { retrying: _retrying, ...resumed } = base;
    expect(mainLine({ ...resumed, state: "running" })).toBe(base.todo);
    expect(OTHERS_CONTINUE).toBe("The others continue.");
  });

  it("shows on the live flow step instead of the stale action", () => {
    const { state, task } = summaryAt("code-reviewer");
    const context = { ...state, tasks: [task] };
    const liveText = (view: ReturnType<typeof journeyView>) => view.nodes.find((node) => node.state === "now")?.live;
    expect(liveText(journeyView(task, context))).toBe(task.statusLine);
    task.retrying = reconnecting;
    expect(liveText(journeyView(task, context))).toBe(reconnecting);
  });

  it("does not survive a restart or a stopped step, on the task or on any agent working at once", () => {
    const task = { state: "running" as const, statusLine: reconnecting, retrying: reconnecting, hunt: { stageId: "s", round: 1, reported: {}, work: { "review-0": { attempts: 1, retrying: reconnecting, activity: "Reading the code" } } } };
    clearRunningTools(task);
    expect(task.retrying).toBeUndefined();
    expect(task.statusLine).toBe("Continuing work");
    expect(task.hunt.work["review-0"].retrying).toBeUndefined();
    expect(task.hunt.work["review-0"].activity).toBe("Reading the code");
  });
});
