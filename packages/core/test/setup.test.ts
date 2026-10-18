import { describe, expect, it } from "vitest";
import { createDemoState, createFirstRunDemo, DEMO_PRODUCTS } from "../src/demo.js";
import { Simulator } from "../src/sim.js";
import type { InboxItem, InboxKind, RunState, State } from "../src/model.js";
import { inboxSummary } from "../src/navigation.js";
import { CHECK_NAMES, firstTaskTip, fixFor, isGuide, toolsGate, usableAgentTools, wontStartFix, type CheckId, type CheckStatus, type Platform, type ToolCheck } from "../src/setup.js";

const checks = (statuses: Partial<Record<CheckId, CheckStatus>>): ToolCheck[] => Object.entries(statuses).map(([id, status]) => ({ id: id as CheckId, status: status! }));
const all = { git: "ready", node: "ready", gh: "ready" } as const;
/** Sentences in a text: ends of sentences, ignoring dots inside names like Node.js. */
const sentences = (text: string) => text.split(/[.!?](?:\s|$)/).filter((part) => part.trim()).length;

describe("which agent tools the squad uses", () => {
  it("uses the Ready ones, and only if none is Ready, the ones Petrina couldn't check", () => {
    expect(usableAgentTools(checks({ "claude-code": "ready", codex: "ready" }))).toEqual(["claude-code", "codex"]);
    expect(usableAgentTools(checks({ "claude-code": "unknown", codex: "ready" }))).toEqual(["codex"]);
    expect(usableAgentTools(checks({ "claude-code": "unknown", codex: "logged-out" }))).toEqual(["claude-code"]);
    expect(usableAgentTools(checks({ "claude-code": "not-installed", codex: "logged-out" }))).toEqual([]);
  });

  it("changes nothing before any check has answered", () => {
    expect(usableAgentTools(undefined)).toEqual(["claude-code", "codex"]);
    expect(usableAgentTools([])).toEqual(["claude-code", "codex"]);
  });

  it("keeps Grok available after the merge and applies the same login rules", () => {
    expect(usableAgentTools(checks({ "claude-code": "ready", codex: "ready", grok: "ready" }))).toEqual(["claude-code", "codex", "grok"]);
    expect(usableAgentTools(checks({ "claude-code": "unknown", codex: "logged-out", grok: "ready" }))).toEqual(["grok"]);
    expect(usableAgentTools(checks({ "claude-code": "unknown", codex: "logged-out", grok: "logged-out" }))).toEqual(["claude-code"]);
    expect(usableAgentTools(checks({ "claude-code": "unknown", codex: "unknown", grok: "not-installed" }))).toEqual(["claude-code", "codex"]);
    expect(toolsGate(checks({ ...all, "claude-code": "unknown", codex: "logged-out", grok: "ready" })).notes.join(" ")).not.toContain("so it will try");
  });
});

describe("the Tools screen with Grok", () => {
  it("goes on with Grok alone, since the squad can run a whole task on it", () => {
    const gate = toolsGate(checks({ ...all, "claude-code": "not-installed", codex: "logged-out", grok: "ready" }));
    expect(gate).toEqual({ ok: true, notes: ["Only Grok is set up, so agents will review each other's work on the same tool, and setting up Claude Code or Codex gives a second opinion."] });
    expect(toolsGate(checks({ ...all, "claude-code": "logged-out", codex: "not-installed", grok: "unknown" }))).toMatchObject({ ok: true, notes: [expect.stringContaining("Only Grok is set up"), "Petrina couldn't confirm Grok, so it will try it and tell you if it can't start."] });
  });

  it("names Grok only when it is installed", () => {
    expect(toolsGate(checks({ ...all, "claude-code": "not-installed", codex: "logged-out", grok: "logged-out" })).missing).toBe("To go on, Petrina needs Claude Code, Codex or Grok, and the fix is above.");
    expect(toolsGate(checks({ ...all, "claude-code": "not-installed", codex: "logged-out", grok: "not-installed" })).missing).toBe("To go on, Petrina needs Claude Code or Codex, and the fix is above.");
    // Grok not installed: the notes are as they were with two tools.
    expect(toolsGate(checks({ ...all, "claude-code": "ready", codex: "logged-out", grok: "not-installed" })).notes).toEqual(["Only Claude Code is set up, so agents will review each other's work on the same tool, and setting up Codex gives a second opinion."]);
  });

  it("counts Grok among the second opinions and the tools Petrina couldn't confirm", () => {
    expect(toolsGate(checks({ ...all, "claude-code": "ready", codex: "not-installed", grok: "logged-out" })).notes).toEqual(["Only Claude Code is set up, so agents will review each other's work on the same tool, and setting up Codex or Grok gives a second opinion."]);
    expect(toolsGate(checks({ ...all, "claude-code": "ready", codex: "not-installed", grok: "unknown" })).notes).toEqual(["Petrina couldn't confirm Grok, so agents will review each other's work on Claude Code alone until Grok checks out as Ready."]);
    expect(toolsGate(checks({ ...all, "claude-code": "ready", codex: "unknown", grok: "unknown" })).notes).toEqual(["Petrina couldn't confirm Codex and Grok, so agents will review each other's work on Claude Code alone until one of them checks out as Ready."]);
    // Grok still checking: no note its answer could take back.
    expect(toolsGate(checks({ ...all, "claude-code": "ready", codex: "not-installed", grok: "unchecked" })).notes).toEqual([]);
    // Two Ready tools: no single-tool note.
    expect(toolsGate(checks({ ...all, "claude-code": "not-installed", codex: "ready", grok: "ready" })).notes).toEqual([]);
  });
});

describe("the Tools screen's Continue", () => {
  it("goes on with Git, Node.js and one agent tool that is Ready or couldn't be checked, without waiting for slower rows", () => {
    expect(toolsGate(checks({ ...all, "claude-code": "ready", codex: "ready" }))).toEqual({ ok: true, notes: [] });
    // Codex and the GitHub CLI still checking: Continue does not wait for them.
    expect(toolsGate(checks({ git: "ready", node: "unknown", "claude-code": "ready" })).ok).toBe(true);
  });

  it("says in one sentence what is missing", () => {
    const noAgents = toolsGate(checks({ ...all, "claude-code": "not-installed", codex: "logged-out" }));
    expect(noAgents).toMatchObject({ ok: false, missing: "To go on, Petrina needs Claude Code or Codex, and the fix is above." });
    const noGit = toolsGate(checks({ ...all, git: "not-installed", "claude-code": "ready" }));
    expect(noGit.missing).toBe("To go on, Petrina needs Git, and the fix is above.");
    const waiting = toolsGate(checks({ "claude-code": "ready", node: "ready" }));
    expect(waiting).toMatchObject({ ok: false, missing: "Waiting for the check of Git." });
  });

  it("notes a single tool, tools it will only try, and a GitHub CLI that is not ready", () => {
    const one = toolsGate(checks({ git: "ready", node: "ready", gh: "logged-out", "claude-code": "unknown", codex: "not-installed" }));
    expect(one.ok).toBe(true);
    expect(one.notes).toEqual([
      "Only Claude Code is set up, so agents will review each other's work on the same tool, and setting up Codex gives a second opinion.",
      "Petrina couldn't confirm Claude Code, so it will try it and tell you if it can't start.",
      "You can set up the GitHub CLI later, but Petrina needs it logged in before it opens your first pull request.",
    ]);
    for (const note of one.notes) expect(sentences(note)).toBe(1);
  });

  it("notes the same tool when the other is one Petrina couldn't check, since the squad uses only the Ready one", () => {
    const uncertain = toolsGate(checks({ ...all, "claude-code": "ready", codex: "unknown" }));
    expect(usableAgentTools(checks({ "claude-code": "ready", codex: "unknown" }))).toEqual(["claude-code"]);
    expect(uncertain).toEqual({ ok: true, notes: ["Petrina couldn't confirm Codex, so agents will review each other's work on Claude Code alone until Codex checks out as Ready."] });
    // Both uncertain: the squad tries both, so no same-tool note, only that it will try them.
    expect(toolsGate(checks({ ...all, "claude-code": "unknown", codex: "unknown" })).notes).toEqual(["Petrina couldn't confirm Claude Code and Codex, so it will try them and tell you if one can't start."]);
    // The other still checking: no note its answer could take back.
    expect(toolsGate(checks({ ...all, "claude-code": "ready" })).notes).toEqual([]);
  });
});

describe("fixes", () => {
  const platforms: Platform[] = ["darwin", "win32", "linux"];
  const ids = Object.keys(CHECK_NAMES) as CheckId[];

  it("give every status that is not Ready one sentence, one command and an official web guide, for each operating system", () => {
    for (const platform of platforms) {
      for (const id of ids) {
        expect(fixFor(id, "ready", platform)).toBeUndefined();
        for (const status of ["not-installed", "logged-out", "unknown"] as const) {
          const fix = fixFor(id, status, platform)!;
          expect(sentences(fix.sentence)).toBe(1);
          expect(fix.command).toMatch(/^[\w-]/);
          expect(fix.command).not.toContain("\n");
          expect(fix.guide).toMatch(/^https:\/\//);
          expect(isGuide(fix.guide)).toBe(true);
        }
        expect(isGuide(wontStartFix(id, platform).guide)).toBe(true);
        expect(sentences(wontStartFix(id, platform).sentence)).toBe(1);
      }
    }
    expect(fixFor("codex", "logged-out", "darwin")!.command).toBe("codex login");
    expect(fixFor("git", "not-installed", "darwin")!.command).toBe("xcode-select --install");
    expect(fixFor("git", "not-installed", "win32")!.sentence).toContain("in a terminal");
    expect(isGuide("https://example.com/")).toBe(false);
  });
});

describe("first run's demo", () => {
  it("has one tool Ready, one Not installed and one Not logged in, and nothing added yet", () => {
    const { state } = createFirstRunDemo(1_000_000);
    expect(state.products).toEqual([]);
    expect(state.tasks).toEqual([]);
    expect(state.setup?.done).toBe(false);
    expect(state.setup?.checks.filter((check) => ["claude-code", "codex", "gh"].includes(check.id)).map((check) => check.status)).toEqual(["ready", "not-installed", "logged-out"]);
  });

  it("starts with an empty history and records the first product and task in Analytics", () => {
    const now = 1_000_000;
    const demo = createFirstRunDemo(now);
    const sim = new Simulator(demo.state, { log: demo.log, open: demo.open, quirks: demo.quirks, triggers: demo.triggers });
    expect(sim.usage({ view: "analytics", period: "today" }).headline.turns).toBe(0);
    expect(demo.log.products()).toEqual([]);
    const product = DEMO_PRODUCTS[0]!;
    sim.addProduct(product);
    sim.addProduct(product);
    expect(demo.log.products()).toEqual([{ id: product.id, name: product.name, repo: product.repo, addedAt: now }]);
    const request = { productId: product.id, title: "Add a greeting", approvePlan: true, clientId: "first-task" };
    const taskId = sim.startFirstTask(request);
    expect(sim.startFirstTask(request)).toBe(taskId);
    // The planner takes several actions under each to-do item: advance to its result, not a fixed action count.
    for (let tick = 0; tick < 30 && !sim.getState().inbox.some((item) => item.kind === "plan"); tick += 1) sim.tick();
    expect(sim.getState().inbox.some((item) => item.kind === "plan")).toBe(true);
    expect(sim.getState().tasks).toHaveLength(1);
    const usage = sim.usage({ view: "analytics", period: "today" });
    expect(usage.headline.turns).toBeGreaterThan(0);
    expect(usage.byProduct).toContainEqual(expect.objectContaining({ productId: product.id, label: product.name }));
  });
});

/** A board just after first run: its first task in `state`, with these items in Needs you. */
function afterFirstRun(options: { approvePlan: boolean; state?: RunState; stageIndex?: number; asks?: InboxKind[] }): State {
  const demo = createDemoState(1_000_000);
  const task = { ...demo.tasks[0]!, approvePlan: options.approvePlan, state: options.state ?? "running", stageIndex: options.stageIndex ?? -1 };
  const inbox = (options.asks ?? []).map((kind, index): InboxItem => ({ id: `ask-${index}`, taskId: task.id, kind, title: kind, at: 1, blocking: false }));
  return { ...demo, tasks: [task], inbox, setup: { done: true, platform: "darwin", checks: [], firstTaskId: task.id } };
}

describe("the board's first-task tip", () => {
  it("follows Show me the plan first", () => {
    expect(firstTaskTip(afterFirstRun({ approvePlan: true }))).toMatchObject({ text: expect.stringContaining("will arrive in Needs you for your approval"), toInbox: true });
    expect(firstTaskTip(afterFirstRun({ approvePlan: true, state: "needs-you", asks: ["plan"] }))?.text).toContain("is waiting in Needs you for your approval");
    const started = firstTaskTip(afterFirstRun({ approvePlan: false }));
    expect(started).toMatchObject({ text: expect.stringContaining("The squad has started"), toInbox: false });
    expect(started?.text).not.toMatch(/approv/);
    // Approved: no plan still to come.
    expect(firstTaskTip(afterFirstRun({ approvePlan: true, stageIndex: 0 }))?.text).toContain("You approved the plan");
  });

  it("promises no plan while the first task is stuck", () => {
    for (const approvePlan of [true, false]) {
      for (const stuck of [afterFirstRun({ approvePlan, state: "failed", asks: ["stuck"] }), afterFirstRun({ approvePlan, asks: ["stuck"] }), afterFirstRun({ approvePlan, state: "failed" })]) {
        const tip = firstTaskTip(stuck)!;
        expect(tip.text).toContain("is stuck");
        expect(tip.text).not.toMatch(/plan|approv|has started/i);
        expect(tip.toInbox).toBe(true);
      }
    }
  });

  it("says nothing once dismissed, or once the first task is finished", () => {
    const dismissed = afterFirstRun({ approvePlan: true });
    expect(firstTaskTip({ ...dismissed, setup: { ...dismissed.setup!, tipDismissed: true } })).toBeUndefined();
    for (const state of ["done", "cancelled", "pr-open"] as const) expect(firstTaskTip(afterFirstRun({ approvePlan: true, state }))).toBeUndefined();
  });
});

describe("the line under Needs you", () => {
  const item = (kind: InboxKind, blocking = false): InboxItem => ({ id: kind, taskId: "t", kind, title: kind, at: 1, blocking });

  it("never says nobody is stuck next to a Stuck item", () => {
    expect(inboxSummary([item("stuck")])).toBe("1 task is stuck until you act on it.");
    expect(inboxSummary([item("stuck"), item("plan")])).toBe("1 task is stuck until you act on it. The rest wait at checkpoints.");
    expect(inboxSummary([item("question", true), item("stuck"), item("stuck")])).toBe("1 agent is waiting on you. 2 tasks are stuck until you act on them.");
    for (const items of [[item("stuck")], [item("stuck"), item("plan")], [item("question", true), item("stuck")]]) expect(inboxSummary(items)).not.toMatch(/nobody is stuck/i);
  });

  it("keeps its words when nothing is stuck", () => {
    expect(inboxSummary([])).toBe("You're not blocking anyone.");
    expect(inboxSummary([item("plan")])).toBe("Nobody is stuck. These wait at checkpoints.");
    expect(inboxSummary([item("question", true), item("plan")])).toBe("1 agent is waiting on you. The rest wait at checkpoints.");
  });

  it("does not call a screen request a checkpoint", () => {
    expect(inboxSummary([item("screen")])).toBe("You're not blocking anyone.");
    expect(inboxSummary([item("plan"), item("screen")])).toBe("Nobody is stuck. These wait at checkpoints.");
    expect(inboxSummary([item("question", true), item("screen")])).toBe("1 agent is waiting on you.");
  });
});
