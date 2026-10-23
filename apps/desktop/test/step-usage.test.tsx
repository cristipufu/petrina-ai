import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDemoState, journeyView, type JourneyNode, type NodeUsage, type State, type Task } from "@petrina/core";
import { StepUsage } from "../src/components/StepUsage";
import { lookup } from "../src/lib";

const read = vi.hoisted(() => vi.fn());
vi.mock("../src/engine", () => ({ sim: { usage: read } }));
const base = createDemoState(1_800_000_000_000);
const task = base.tasks.find(task => task.id === "pricing-refresh")!;
const context = { roles: base.roles, profiles: base.profiles, tasks: base.tasks, inbox: base.inbox };
const node = journeyView(task, context).nodes.find(node => node.kind === "agent")!;
const reported = (total = 12_500): NodeUsage => ({ view: "node", taskId: task.id, nodeId: node.id, tokens: { value: total, atLeast: false }, detail: { input: { value: 1000, atLeast: false }, output: { value: 500, atLeast: false }, cacheRead: { value: 11000, atLeast: false }, cacheWrite: { atLeast: false } }, breakdownIncomplete: true, explanation: "", runs: [] });
let host: HTMLDivElement, root: Root;
beforeEach(() => { read.mockReset(); host = document.createElement("div"); document.body.append(host); root = createRoot(host); });
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });
async function render(selected: JourneyNode = node, state: State = base, selectedTask: Task = task) {
  await act(async () => root.render(<StepUsage node={selected} task={selectedTask} state={state} find={lookup(state)} />));
}

it("shows Analytics labels and compact totals, with missing parts left unreported", async () => {
  read.mockResolvedValue(reported()); await render();
  const section = host.querySelector('section[aria-label="Usage"]')!;
  expect(section.textContent).toContain("13k tokens");
  expect([...section.querySelectorAll("dt")].map(dt => dt.textContent)).toEqual(["New input", "Reused from cache", "Written to cache", "Output"]);
  expect(section.querySelectorAll("dd")[2]!.textContent).toBe("not reported");
  expect(section.querySelector('[aria-live="polite"]')).not.toBeNull();
});

it("updates an open step when its final report is saved", async () => {
  read.mockResolvedValueOnce({ ...reported(), empty: "pending" });
  const live = { ...node, endedAt: undefined };
  await render(live); expect(host.textContent).toContain("not reported yet");
  read.mockResolvedValueOnce(reported());
  await render(live, { ...base, work: { since: 1, version: (base.work?.version ?? 0) + 1 } });
  expect(host.textContent).toContain("13k tokens");
});

it("clears old totals immediately on node and task changes, ignoring late responses", async () => {
  read.mockResolvedValueOnce(reported()); await render();
  let finish!: (view: NodeUsage) => void;
  read.mockImplementationOnce(() => new Promise<NodeUsage>(resolve => { finish = resolve; }));
  await render({ ...node, id: "other-node" });
  expect(host.textContent).not.toContain("13k");
  read.mockRejectedValueOnce(new Error("Disconnected"));
  await render(node, base, { ...task, id: "other-task" });
  await act(async () => finish(reported(999_000)));
  expect(host.textContent).not.toContain("999k");
  expect(host.textContent).not.toContain("13k");
});

it("explains untracked, future and non-agent steps without figures", async () => {
  read.mockResolvedValue({ ...reported(), empty: "unavailable" }); await render();
  expect(host.textContent).toContain("cannot be shown on its own");
  for (const kind of ["petrina", "you", "wait"] as const) {
    await render({ ...node, kind });
    expect(host.textContent).toContain("No agent token use");
    expect(host.querySelector(".num")).toBeNull();
  }
  await render({ ...node, state: "next" });
  expect(host.textContent).toContain("has not started");
  expect(read).toHaveBeenCalledTimes(1);
});

it.each([true, false])("names actual seats, tools, models and separate starts with partial report wording (tool name recorded: %s)", async recorded => {
  const amount = { value: 600, atLeast: true };
  const view = reported(600); view.tokens = amount;
  view.detail.input = { value: 400, atLeast: true };
  view.runs = [1, 2].map(start => ({ key: `run-${start}`, roleId: "code-reviewer", toolId: start === 1 ? "codex" : "grok", model: start === 1 ? "sol" : "Grok 4.7", seat: 1, start, tokens: { value: 300, atLeast: false }, detail: view.detail, models: [] }));
  const state = recorded ? base : { ...base, tools: base.tools.filter(tool => tool.id !== "grok") };
  read.mockResolvedValue(view); await render(node, state);
  expect(host.textContent).toContain("> 600 tokens");
  expect(host.textContent).toContain("Seat 1 · Start 1");
  expect(host.textContent).toContain("Seat 1 · Start 2");
  expect(host.textContent).toContain("Codex · sol");
  expect(host.textContent).toContain(recorded ? "Grok · Grok 4.7" : "grok · Grok 4.7");
  expect(host.textContent).toContain("> 400");
  expect(host.textContent).not.toContain("At least");
  expect(host.textContent).not.toContain("at least");
});

it.each(["pending", "unreported"] as const)("shows a plain message without missing-value rows for %s usage", async empty => {
  read.mockResolvedValue({ ...reported(), empty, tokens: { atLeast: false }, breakdownIncomplete: false });
  await render({ ...node, endedAt: empty === "pending" ? undefined : 100 });
  expect(host.textContent).toContain(empty === "pending" ? "Token use is not reported yet." : "The tool did not report token use for this step.");
  expect(host.querySelector("dl")).toBeNull();
  expect(host.textContent).not.toContain("At least");
  expect(host.textContent).not.toContain("breakdown");
});

it.each(["a turn still working", "older work left out"])("explains %s without blaming the tool's complete breakdown", async reason => {
  const view = reported(100);
  view.tokens.atLeast = true;
  view.detail = Object.fromEntries(Object.entries(view.detail).map(([key, amount]) => [key, { ...amount, value: 25, atLeast: reason === "older work left out" }])) as NodeUsage["detail"];
  view.breakdownIncomplete = false;
  view.explanation = reason === "a turn still working" ? "Token use for a turn still working is not reported yet." : "Some older turns could not be separated safely from nearby steps and are left out.";
  read.mockResolvedValue(view); await render();
  expect(host.textContent).toContain("> 100 tokens");
  expect(host.textContent).toContain(view.explanation);
  expect(host.textContent).not.toContain("The tool did not report every part");
});

it("shows every reported model split for a single start", async () => {
  const view = reported(15_100);
  view.runs = [{ key: "one", roleId: "builder", toolId: "claude-code", model: "Opus, Haiku", start: 1, tokens: view.tokens, detail: view.detail, models: [{ label: "Opus", tokens: 12_000 }, { label: "Haiku", tokens: 3_100 }] }];
  read.mockResolvedValue(view); await render();
  expect(host.textContent).toContain("Opus: 12k · Haiku: 3.1k");
  expect(host.querySelector('.step-usage-runs')).toBeNull();
});
it("names frozen maintenance roles in separate starts even after deletion from Library", async () => {
  const role = { ...base.roles[0]!, id: "retired-maintainer", name: "Original maintainer" };
  const saved = { ...task, maintenance: { routineId: "daily", routineName: "Daily", scheduledAt: 0, queuedAt: 0, zone: "UTC", focus: "Inspect", input: "Inspect", role, profile: base.profiles[0]!, product: base.products[0]! } };
  const view = reported(); view.runs = [1, 2].map(start => ({ key: `start-${start}`, roleId: role.id, toolId: "codex", model: "sol", start, tokens: view.tokens, detail: view.detail, models: [] }));
  read.mockResolvedValue(view); await render(node, base, saved);
  expect(host.textContent).toContain("Original maintainer · Start 1"); expect(host.textContent).toContain("Original maintainer · Start 2");
});
