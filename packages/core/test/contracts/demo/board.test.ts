import { describe, expect, it } from "vitest";
import { boardSections, currentStep, pipelineOf, stepTip, stripOf } from "../../../src/board.js";
import { createDemoState, createPortfolioDemo } from "../../../src/demo.js";
import { BUILT_IN_ROLES, composePlan } from "../../../src/library.js";
import type { Role, Task } from "../../../src/model.js";

const demo = createDemoState(1_000_000_000);

const byTitle = (title: string): Task => demo.tasks.find((task) => task.title === title)!;

const labels = (task: Task) => pipelineOf(task).map((step) => `${step.label}:${step.state}`);

describe("each card's own pipeline", () => {
  it("reads the steps from the task's plan, with the design check as its own step", () => {
    // A feature waiting for permission during its build.
    expect(labels(byTitle("Guest checkout"))).toEqual(["Plan:done", "Design:done", "Your check:done", "Build:current", "Review:next", "Ship:next"]);
    expect(currentStep(pipelineOf(byTitle("Guest checkout")))).toEqual({ label: "Build", index: 3 });
  });

  it("names every step for its tooltip, upcoming ones included", () => {
    expect(pipelineOf(byTitle("Guest checkout")).map(stepTip)).toEqual(["Plan, done", "Design, done", "Your check, done", "Build, now", "Review, next", "Ship, next"]);
  });

  it("leaves out the stages a plan does not have", () => {
    // A bug fix has no design: no Design, no Your check.
    const steps = pipelineOf(byTitle("Fix login loop on Safari")).map((step) => step.label);
    expect(steps).toEqual(["Plan", "Build", "Review", "Ship"]);
  });

  it("folds a plan check into Plan and a delivery check into Ship", () => {
    expect(labels(byTitle("Weekly email digest"))).toEqual(["Plan:current", "Design:next", "Your check:next", "Build:next", "Review:next", "Ship:next"]);
    expect(labels(byTitle("Refresh the pricing page"))).toEqual(["Plan:done", "Build:done", "Review:done", "Ship:current"]);
  });

  it("shows something new with every one of its stages", () => {
    const task = { ...byTitle("Guest checkout"), plan: composePlan({ id: "x", kind: "new", delivery: "pull-request", approveDelivery: true }), stageIndex: 0 };
    expect(pipelineOf(task).map((step) => step.label)).toEqual(["Plan", "Research", "Design", "Screens", "Your check", "Build", "Test", "Review", "Ship"]);
  });

  it("checks every step once the work is delivered, and has none while queued", () => {
    expect(pipelineOf(byTitle("Report errors to Sentry")).every((step) => step.state === "done")).toBe(true);
    expect(pipelineOf(byTitle("Export notes to PDF"))).toEqual([]);
  });

  it("derives pipeline step labels from RoleResult contracts for custom role ids", () => {
    const customRoles: readonly Role[] = [
      ...BUILT_IN_ROLES,
      { ...BUILT_IN_ROLES.find((role) => role.result === "build")!, id: "custom-implementer", name: "Implementer" },
      { ...BUILT_IN_ROLES.find((role) => role.result === "checks")!, id: "custom-acceptance", name: "Acceptance Partner" },
      { ...BUILT_IN_ROLES.find((role) => role.result === "delivery")!, id: "custom-shipper", name: "Release Publisher" },
    ];
    const base = byTitle("Fix login loop on Safari");
    const task: Task = {
      ...base,
      stageIndex: 0,
      plan: {
        plannerProfileId: "opus-high",
        rationale: "Custom role ids",
        stages: [
          { id: "c:build", kind: "do", title: "Implement", roleId: "custom-implementer", profileIds: ["opus-high"] },
          { id: "c:test", kind: "do", title: "Verify", roleId: "custom-acceptance", profileIds: ["sonnet-medium"] },
          { id: "c:review", kind: "review-chain", title: "Review", roleId: "code-reviewer", profileIds: ["sol-high"] },
          { id: "c:ship", kind: "do", title: "Publish", roleId: "custom-shipper", profileIds: ["opus-high"] },
        ],
      },
    };
    expect(pipelineOf(task, customRoles).map((step) => step.label)).toEqual(["Plan", "Build", "Test", "Review", "Ship"]);
  });
});

describe("a card's strip", () => {

  it("folds the long Usage dashboard card in the portfolio demo", () => {
    const { state } = createPortfolioDemo(1_000_000_000);
    const long = state.tasks.filter((task) => pipelineOf(task).length >= 9 && pipelineOf(task).filter((step) => step.state === "done").length >= 2);
    expect(long.length).toBeGreaterThan(0);
    for (const task of long) expect(stripOf(pipelineOf(task))[0]!.folded).toBeDefined();
  });
});

describe("board order", () => {
  it("puts what needs the coordinator first, then working, waiting, the queue in order, and done last", () => {
    const sections = boardSections(demo.tasks);
    // The same order as the inbox: agents kept waiting first, then by when the work started.
    expect(sections["needs-you"].map((task) => task.title)).toEqual(["Guest checkout", "Dark mode", "Refresh the pricing page", "Gift cards", "Weekly email digest"]);
    expect(sections.working.map((task) => task.title)).toEqual(["Fix login loop on Safari"]);
    expect(sections.queue.map((task) => task.title)).toEqual(["Export notes to PDF", "Onboarding checklist", "Search by tag", "Retry failed Stripe webhooks"]);
    // Calendar-based history can fall between the board's named tasks in some timezones.
    const named = sections.done.filter((task) => !/^h\d+$/.test(task.id));
    expect(named.map((task) => task.title)).toEqual(["Report errors to Sentry", "Fix the footer links"]);
    expect(sections.done.filter((task) => /^h\d+$/.test(task.id)).every((task) => demo.products.some((product) => product.id === task.productId))).toBe(true);
    expect(sections.done.every((task, index, tasks) => index === 0 || tasks[index - 1]!.finishedAt! >= task.finishedAt!)).toBe(true);
  });

  it("keeps every task in exactly one section, and filters", () => {
    const { state } = createPortfolioDemo(1_000_000_000);
    const sections = boardSections(state.tasks);
    expect(Object.values(sections).flat()).toHaveLength(state.tasks.length);
    expect(sections.waiting.some((task) => task.state === "pr-open")).toBe(true);
    const shopOnly = boardSections(state.tasks, (task) => task.productId === "shop");
    expect(Object.values(shopOnly).flat().every((task) => task.productId === "shop")).toBe(true);
  });
});
