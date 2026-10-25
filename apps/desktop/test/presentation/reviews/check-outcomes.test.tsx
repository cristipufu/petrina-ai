import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import type { CheckRun, Task } from "@petrina/core";
import { completeCheckExecution } from "@petrina/test-support/check-execution-facts";
import { ReviewView } from "../../../src/components/sheet/ReviewTab";
import { lookup } from "../../../src/lib";
import { oneTaskFixture } from "../../fixtures/state";

const report = (name: string, ok: boolean): CheckRun => ({ name, command: `check ${name}`, ok, output: "Original saved output", ms: 100 });
function render(runs: readonly CheckRun[], shared = false) {
  const state = oneTaskFixture(), base = state.tasks[0]!, checks = { at: state.now, results: runs };
  const task: Task = { ...base, findings: [], checks: shared ? undefined : checks,
    repositories: shared ? [{ productId: base.productId, delivery: "local", completedStages: [], checks }] : undefined,
  };
  const host = document.createElement("div");
  host.innerHTML = renderToStaticMarkup(<ReviewView task={task} now={state.now} find={lookup(state)} />);
  return { host, header: [...host.querySelectorAll("h2")].find(heading => heading.textContent?.startsWith("Checks "))!.textContent!, badges: [...host.querySelectorAll(".issue-status .label")] };
}

for (const code of [0, 7]) it(`labels a complete exit ${code} from its actual execution facts`, () => {
  const { header, badges } = render([{ ...report("Tests", code === 0), execution: completeCheckExecution(code) }]);
  expect(header).toContain(code === 0 ? "all 1 passed" : "1 of 1 failed");
  expect(badges.map(badge => badge.textContent)).toEqual([code === 0 ? "Passed" : "Failed"]);
  expect(badges[0]!.classList.contains(code === 0 ? "ok" : "bad")).toBe(true);
});

for (const shared of [false, true]) for (const ok of [false, true]) it(`keeps a legacy reported ${ok} unverified (shared=${shared})`, () => {
  const saved = report("Legacy", ok), { host, header, badges } = render([saved], shared);
  expect(header).toContain("1 unverified"); expect(header).not.toContain("all 1 passed");
  expect(badges[0]!.textContent).toContain("execution details were not recorded");
  expect(host.querySelectorAll(".issue-status .ok, .issue-status .bad")).toHaveLength(0);
  expect(host.textContent).toContain(`Original reported result: ${ok ? "passed" : "failed"}`);
  expect(host.textContent).toContain(saved.output);
  expect(saved.execution).toBeUndefined();
});

it("keeps a command that never started unavailable, with its original report separate", () => {
  const run: CheckRun = { ...report("Missing program", false), execution: { ...completeCheckExecution(0), started: false, exit: { status: "unreported" }, stdout: "incomplete", stderr: "incomplete", failure: { kind: "start", message: "Program could not start" } } };
  const { host, header, badges } = render([run]);
  expect(header).toContain("1 unverified"); expect(badges[0]!.textContent).toBe("Could not start");
  expect(host.querySelectorAll(".issue-status .bad")).toHaveLength(0);
  expect(host.textContent).toContain("Original reported result: failed");
});

it("does not show a reported pass as complete when cleanup is unconfirmed", () => {
  const { host, header, badges } = render([{ ...report("Cleanup", true), execution: { ...completeCheckExecution(0), cleanup: "unconfirmed" }, cleanupIncomplete: true }]);
  expect(header).toContain("1 unverified"); expect(badges[0]!.textContent).toBe("Cleanup is unconfirmed");
  expect(host.querySelectorAll(".issue-status .ok, .issue-status .bad")).toHaveLength(0);
  expect(host.textContent).toContain("Original reported result: passed");
  expect(host.textContent).toContain("could not confirm every child process stopped");
});

it("counts a real failure, incomplete legacy observation and complete pass separately", () => {
  const { host, header, badges } = render([
    { ...report("Failed", false), execution: completeCheckExecution(7) }, report("Legacy", true), { ...report("Passed", true), execution: completeCheckExecution(0) },
  ]);
  expect(header).toContain("1 still failing, 1 unverified");
  expect(badges[0]!.textContent).toBe("Failed"); expect(badges[1]!.textContent).toContain("Unverified"); expect(badges[2]!.textContent).toBe("Passed");
  expect(host.querySelectorAll(".issue-status .bad")).toHaveLength(1); expect(host.querySelectorAll(".issue-status .ok")).toHaveLength(1);
});
