import { BUILT_IN_ROLES, createTaskState, DEFAULT_PROFILES, DEMO_PRODUCTS, KNOWN_TOOLS, type Role, type Task } from "@petrina/core";
import type { PromptContext } from "../../src/prompts.js";

/** Explicit prompt data, independent of demo task ordering, completed work and runtime effects. */
export function promptTask(extra: Partial<Task> = {}): Task {
  const task = createTaskState({ productId: "shop", title: "Fix slow first load", description: "The first page takes four seconds on phones.", backlog: true },
    DEMO_PRODUCTS, { id: "prompt-task", timelineId: "created", now: 1_000_000_000, priority: 0 });
  return structuredClone({ ...task, kind: "bug", risk: { level: "medium", why: "A fix to how people sign in and pay, in one place." }, ...extra });
}

export function promptContext(role: Role, screen?: PromptContext["screen"]): PromptContext {
  return {
    task: promptTask(), product: DEMO_PRODUCTS[0]!, role, roles: BUILT_IN_ROLES,
    profiles: DEFAULT_PROFILES, tools: KNOWN_TOOLS,
    worktree: "/tmp/worktree", branch: "petrina/task", base: "main", defaultBranch: "main", sections: [],
    ...(screen ? { screen } : {}),
  };
}
