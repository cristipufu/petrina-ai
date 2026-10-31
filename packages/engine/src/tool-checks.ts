// The tools check: is each tool installed and logged in. First run, the Library, the planner and Stuck
// items all read the answers from the state. Each check runs on its own, so a slow one never holds up
// the others; a second ask joins the one under way; and a tool a check gave up on is gone before the
// next check starts it again, so copies never pile up.

import { CHECK_NAMES, checkOf, type CheckId, type Id, type ToolCheck } from "@petrina/core";
import { ToolCheckCoordinator, TOOL_CHECK_LINGER_MS, type ToolCheckClock } from "@petrina/orchestrator";
import { notReady, ToolProblem, type RuntimeTask } from "./engine-options.js";
import type { Kernel } from "./kernel.js";
import { AGENT_CHECK_TIMEOUT_MS } from "@petrina/agent-runtime/probe";
import { isAuthRequired } from "@petrina/agent-runtime/failures";
import { ADAPTERS } from "@petrina/agent-runtime/tools";
import { NativeToolProbe } from "./tool-probe.js";

/** Everything the tools check looks at, in the order it is shown. */
export const CHECKS: readonly CheckId[] = ["claude-code", "codex", "grok", "antigravity", "opencode", "pi", "gh", "git"];

const clock: ToolCheckClock = {
  now: () => Date.now(),
  wait: (ms, signal) => new Promise(resolve => {
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    signal.addEventListener("abort", finish, { once: true });
    if (signal.aborted) finish();
  }),
};

/** A saved participant's readiness recheck may take one agent check, after the previous copy of its tool has stopped. */
export function readinessLimitMs(timeoutMs: number | undefined): number {
  return (timeoutMs ?? AGENT_CHECK_TIMEOUT_MS) + TOOL_CHECK_LINGER_MS;
}

export class ToolChecks {
  private readonly checks: ToolCheckCoordinator;

  constructor(private readonly k: Kernel) {
    this.checks = new ToolCheckCoordinator({
      stopped: () => k.stopped,
      current: id => checkOf(k.s.setup?.checks, id),
      publish: check => {
        this.put(check.id, check);
        k.commit();
      },
    }, k.options.toolProbe ?? new NativeToolProbe(k), clock);
  }

  /** Quitting stops tool-check agents too, and waits for their remaining programs before exiting. */
  async shutdown(): Promise<void> {
    await this.checks.shutdown(CHECKS.filter(id => ADAPTERS[id] !== undefined));
  }

  /** Check every tool again, each on its own, so a slow one never holds up the others. */
  async checkAll(): Promise<void> {
    await Promise.all(CHECKS.map((id) => this.check(id)));
  }

  check(id: CheckId): Promise<void> {
    return this.checks.check(id);
  }

  /** The check of this tool under way, to join without starting another. */
  running(id: CheckId): Promise<void> | undefined {
    return this.checks.running(id);
  }

  pending() { return this.checks.pending(); }

  status(id: CheckId) {
    return checkOf(this.k.s.setup?.checks, id).status;
  }

  /** A tool would not start: why, in a form the coordinator can act on. */
  async problem(toolId: Id, error: unknown): Promise<ToolProblem> {
    const id = toolId as CheckId;
    const detail = error instanceof Error ? error.message : String(error);
    if (isAuthRequired(error)) {
      this.put(id, { id, status: "logged-out", at: Date.now() });
      this.k.commit();
      return new ToolProblem(id, "logged-out", detail);
    }
    await this.check(id);
    const status = this.status(id);
    return new ToolProblem(id, notReady(status) ? status : "wont-start", detail);
  }

  /** Before a delivery to GitHub: the GitHub CLI must be logged in, or nothing ships. Couldn't check: it goes ahead. */
  async needGitHub(task: RuntimeTask): Promise<void> {
    const before = task.statusLine;
    task.statusLine = "Checking the GitHub login";
    this.k.commit();
    await this.check("gh");
    const status = this.status("gh");
    if (notReady(status)) throw new ToolProblem("gh", status);
    // Checked: the card no longer says so while the delivery's next steps run.
    if (task.statusLine === "Checking the GitHub login") {
      task.statusLine = before;
      this.k.commit();
    }
  }

  /** Retry on a Stuck item about a tool: true while the tool is still not installed or not logged in. */
  async stillNotReady(toolId: CheckId, task: RuntimeTask | undefined): Promise<boolean> {
    await this.check(toolId);
    const status = this.status(toolId);
    if (!notReady(status)) return false;
    if (task) {
      this.k.log(task, "warn", `Checked ${CHECK_NAMES[toolId]} again: it is still ${status === "logged-out" ? "not logged in" : "not installed"}`);
      this.k.commit();
    }
    return true;
  }

  private put(id: CheckId, check: ToolCheck): void {
    const setup = this.k.s.setup;
    if (!setup) return;
    const next = { ...check, id };
    if (!next.checking) delete next.checking;
    setup.checks = [...setup.checks.filter((entry) => entry.id !== id), next].sort((a, b) => CHECKS.indexOf(a.id) - CHECKS.indexOf(b.id));
    // The Library, the planner and the review's voters read the agent tools' status here too.
    const tool = this.k.s.tools.find((entry) => entry.id === id);
    if (tool && (next.status === "ready" || notReady(next.status))) tool.status = next.status;
  }
}
