// The board: one grid of task cards. Each card carries its own pipeline, read from its plan,
// and the board orders cards by what they need: the coordinator first, then working, then
// waiting, then the queue in priority order, with finished work folded away at the end.

import type { Stage, Task } from "./model.js";
import { queueOf } from "./scheduler.js";

export interface PipelineStep {
  /** A short name, e.g. "Build" or "Your check". */
  label: string;
  state: "done" | "current" | "next";
}

const ROLE_STEP: Readonly<Record<string, string>> = {
  planner: "Plan",
  researcher: "Research",
  architect: "Design",
  "design-reviewer": "Design",
  "ux-designer": "Screens",
  builder: "Build",
  tester: "Test",
  "code-reviewer": "Review",
  shipper: "Ship",
};

function stepLabel(stage: Stage): string {
  if (stage.kind === "converge") return "Design";
  if (stage.kind === "review-chain") return "Review";
  return ROLE_STEP[stage.roleId] ?? stage.title;
}

/**
 * The steps a card shows, from the task's own plan: planning first, then each stage, with
 * the coordinator's design check as its own step. A plan check folds into Plan and a delivery
 * check into Ship, because those are the moments the coordinator approves them. Stages the
 * plan does not have are simply absent. Queued tasks have no pipeline yet.
 */
export function pipelineOf(task: Task): PipelineStep[] {
  if (task.state === "queued") return [];
  const finished = task.state === "pr-open" || task.state === "done";
  const steps: { label: string; from: number; to: number }[] = [{ label: "Plan", from: -1, to: -1 }];
  const stages = task.plan?.stages ?? [];
  stages.forEach((stage, index) => {
    const last = steps.at(-1)!;
    if (stage.kind === "gate" && stage.gate === "plan" && last.label === "Plan") {
      last.to = index;
      return;
    }
    if (stage.kind === "gate" && stage.gate === "delivery") {
      steps.push({ label: "Ship", from: index, to: index });
      return;
    }
    const label = stage.kind === "gate" ? "Your check" : stepLabel(stage);
    if (label === "Ship" && last.label === "Ship") {
      last.to = index;
      return;
    }
    if (label === last.label && label !== "Your check") {
      last.to = index;
      return;
    }
    steps.push({ label, from: index, to: index });
  });
  return steps.map((step) => {
    let state: PipelineStep["state"];
    if (finished || task.stageIndex > step.to) state = "done";
    else if (task.stageIndex >= step.from && !(task.state === "cancelled")) state = "current";
    else state = "next";
    return { label: step.label, state };
  });
}

/** A step named with where the task stands on it, for its tooltip: "Plan, done", "Build, now", "Review, next". */
export function stepTip(step: PipelineStep): string {
  return `${step.label}, ${step.state === "current" ? "now" : step.state}`;
}

/** The step the task is on, for a card's "Build · 4 of 6". */
export function currentStep(steps: readonly PipelineStep[]): { label: string; index: number } | undefined {
  const index = steps.findIndex((step) => step.state === "current");
  return index < 0 ? undefined : { label: steps[index]!.label, index };
}

export type BoardSection = "needs-you" | "working" | "waiting" | "queue" | "done";

export const BOARD_SECTIONS: readonly { id: BoardSection; title: string }[] = [
  { id: "needs-you", title: "Needs you" },
  { id: "working", title: "Working" },
  { id: "waiting", title: "Waiting" },
  { id: "queue", title: "Queue" },
  { id: "done", title: "Done" },
];

export function sectionOf(task: Task): BoardSection {
  switch (task.state) {
    case "needs-you":
    case "failed":
      return "needs-you";
    case "running":
      return "working";
    case "waiting":
    case "paused":
    case "pr-open":
      return "waiting";
    case "queued":
      return "queue";
    case "done":
    case "cancelled":
      return "done";
  }
}

const WAITING_ORDER: Partial<Record<Task["state"], number>> = { waiting: 0, paused: 1, "pr-open": 2 };

/**
 * Every section's cards in board order. Agents waiting on the coordinator while holding a slot
 * come first among those that need them; the queue keeps its priority order (held tasks keep
 * their place); finished work is newest first.
 */
export function boardSections(tasks: readonly Task[], visible: (task: Task) => boolean = () => true): Record<BoardSection, Task[]> {
  const started = (task: Task) => task.startedAt ?? task.createdAt;
  const pick = (section: BoardSection) => tasks.filter((task) => sectionOf(task) === section && visible(task));
  return {
    "needs-you": pick("needs-you").sort((a, b) => Number(b.holdsSlot) - Number(a.holdsSlot) || Number(a.state === "failed") - Number(b.state === "failed") || started(a) - started(b)),
    working: pick("working").sort((a, b) => started(a) - started(b)),
    waiting: pick("waiting").sort((a, b) => (WAITING_ORDER[a.state] ?? 9) - (WAITING_ORDER[b.state] ?? 9) || started(a) - started(b)),
    queue: queueOf(tasks).filter(visible),
    done: pick("done").sort((a, b) => (b.finishedAt ?? 0) - (a.finishedAt ?? 0)),
  };
}
