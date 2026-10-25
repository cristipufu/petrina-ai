import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import type { CheckRun, JourneyProductCheck } from "@petrina/core";
import { completeCheckExecution } from "@petrina/test-support/check-execution-facts";
import { CheckAttempts } from "../../../src/components/CheckAttempts";
import { lookup } from "../../../src/lib";
import { oneTaskFixture } from "../../fixtures/state";

const NOW = 1_000_000_000;
const report = (ok: boolean): CheckRun => ({ name: "Tests", command: "tests", ok, output: "Original diagnostic", ms: 100 });
function render(checks: readonly JourneyProductCheck[]) {
  const state = oneTaskFixture(NOW), host = document.createElement("div");
  host.innerHTML = renderToStaticMarkup(<CheckAttempts checks={checks} find={lookup(state)} now={NOW} />);
  return { host, badges: [...host.querySelectorAll(".journey-check-list .label")] };
}

for (const code of [0, 7]) it(`uses complete exit ${code} for both summary and badge ahead of a stale terminal label`, () => {
  const { host, badges } = render([{ name: "Tests", result: code === 0 ? "fail" : "pass", run: { ...report(code === 0), execution: completeCheckExecution(code) } }]);
  expect(host.textContent).toContain(code === 0 ? "1 of 1 passed" : "1 of 1 failed");
  expect(badges.map(badge => badge.textContent)).toEqual([code === 0 ? "Passed" : "Failed"]);
});

for (const retained of [false, true]) for (const ok of [false, true]) it(`does not promote legacy ${ok} to native proof (retained run=${retained})`, () => {
  const saved = report(ok), { host, badges } = render([{ name: "Tests", result: ok ? "pass" : "fail", ...(retained ? { run: saved } : {}) }]);
  expect(host.textContent).toContain("0 of 1 passed"); expect(host.textContent).toContain("Checks unverified");
  expect(badges[0]!.textContent).toContain("Unverified");
  expect(host.querySelectorAll(".journey-check-list .ok, .journey-check-list .bad")).toHaveLength(0);
  expect(host.textContent).toContain(`Original reported result: ${ok ? "passed" : "failed"}`);
  if (retained) expect(host.textContent).toContain(saved.output);
  expect(saved.execution).toBeUndefined();
});

it("preserves each live lifecycle ahead of carried interruption facts and timing", () => {
  const old: CheckRun = { ...report(true), execution: completeCheckExecution(0), startedAt: NOW - 600_000, endedAt: NOW - 590_000,
    interruption: { source: "macOS power log", at: NOW - 595_000, event: "An older sleep observation" },
  };
  const { host, badges } = render((['pending', 'running', 'stopped', 'skipped'] as const).map(result => ({ name: result, result, run: old, ...(result === 'running' ? { startedAt: NOW - 120_000 } : {}) })));
  expect(badges.map(badge => badge.textContent)).toEqual(["Pending", "Running", "Stopped — verification incomplete", "Skipped"]);
  expect(host.textContent).toContain("0 of 4 passed · in progress");
  expect(host.querySelectorAll(".journey-check-list .ok, .journey-check-list .bad")).toHaveLength(0);
  const rows = [...host.querySelectorAll(".journey-check-list li")];
  expect(rows[1]!.textContent).toContain("2m so far"); expect(rows[0]!.textContent).not.toContain("so far");
  expect(rows[3]!.textContent).toContain("no execution");
  expect(old.interruption?.event).toBe("An older sleep observation"); expect(old.endedAt).toBe(NOW - 590_000);
});

for (const kind of ['start', 'exit'] as const) it(`keeps ${kind} uncertainty distinct from an ordinary failure`, () => {
  const execution = kind === 'start'
    ? { ...completeCheckExecution(0), started: false, exit: { status: "unreported" as const }, stdout: "incomplete" as const, stderr: "incomplete" as const, failure: { kind: "start" as const, message: "Program could not start" } }
    : { ...completeCheckExecution(0), exit: { status: "unreported" as const } };
  const { host, badges } = render([{ name: "Tests", result: "fail", run: { ...report(false), execution } }]);
  expect(host.textContent).toContain("0 of 1 passed");
  expect(badges[0]!.textContent).toBe(kind === 'start' ? "Could not start" : "Exit was not reported");
  expect(host.querySelectorAll(".journey-check-list .bad")).toHaveLength(0);
  expect(host.textContent).toContain("Original reported result: failed"); expect(host.textContent).toContain("Original diagnostic");
});
