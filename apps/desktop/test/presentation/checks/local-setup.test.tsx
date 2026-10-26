import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { checkProblem, type CheckSetupAttempt, type Task } from "@petrina/core";
import { completeCheckExecution } from "@petrina/test-support/check-execution-facts";
import { CheckSetupObservations, StepCheckSetups } from "../../../src/components/CheckSetupObservations";
import { ReviewView } from "../../../src/components/sheet/ReviewTab";
import { lookup } from "../../../src/lib";
import { setupObservation } from "../../fixtures/check-setup";
import { oneTaskFixture } from "../../fixtures/state";

function render(latest?: CheckSetupAttempt, extra: Partial<Parameters<typeof CheckSetupObservations>[0]> = {}) {
  const host = document.createElement("div"); host.innerHTML = renderToStaticMarkup(<CheckSetupObservations latest={latest} {...extra} />); return host;
}

it("shows an unobserved setup without claiming a current successful check", () => {
  const host = render(); expect(host.textContent).toContain("Local setup has not been observed"); expect(host.querySelector(".ok-text")).toBeNull();
});
for (const lifecycle of ["pending", "running", "stopped"] as const) it(`retains the actual ${lifecycle} observation lifecycle`, () => {
  const attempt = setupObservation(); attempt.lifecycle = lifecycle;
  const host = render(attempt); expect(host.textContent).toContain(({ pending: "waiting to run", running: "Verifying local setup", stopped: "verification stopped" })[lifecycle]);
  expect(host.querySelector(".ok-text")).toBeNull();
});
it("names the failed requirement and preserves its real recorded time and diagnostic", () => {
  const attempt = setupObservation("shop", 7), host = render(attempt);
  expect(host.textContent).toContain("Compiler version did not pass (exit 7)"); expect(host.textContent).not.toContain("compiler-record-id");
  expect(host.textContent).toContain("Before automated checks"); expect(host.querySelector("time")?.dateTime).toBe(new Date(attempt.endedAt!).toISOString());
  expect(host.textContent).toContain("Tool version 1"); expect(host.querySelector<HTMLDetailsElement>(".setup-diagnostics")?.open).toBe(false);
});
it("keeps an incomplete historical report unverified instead of promoting its ok flag", () => {
  const attempt = setupObservation(); delete attempt.results[0]!.run.execution;
  const host = render(attempt); expect(host.textContent).toContain("Local setup incomplete"); expect(host.querySelector(".ok-text")).toBeNull();
});
it("keeps a declared requirement whose program could not start unavailable", () => {
  const attempt = setupObservation(); attempt.results[0]!.run.ok = false; delete attempt.results[0]!.run.outputIdentity; attempt.results[0]!.run.output = "Compiler could not start";
  attempt.results[0]!.run.execution = { ...attempt.results[0]!.run.execution!, started: false, exit: { status: "unreported" }, stdout: "incomplete", stderr: "incomplete", failure: { kind: "start", message: "Compiler is missing" }, cleanup: "not-requested", outputCleanup: "not-requested" };
  const host = render(attempt); expect(host.textContent).toContain("Local setup unavailable"); expect(host.querySelector(".ok-text")).toBeNull();
});
it("keeps a requested refresh distinct from a verified earlier observation", () => {
  const current = setupObservation(), prior = setupObservation("shop", 7, 900_000);
  const host = render(current, { invalidated: { id: "rerun", kind: "explicit-rerun", at: 1_000_001 }, history: [prior, current] });
  expect(host.querySelector(".setup-observation")?.textContent).toContain("Fresh local setup and checks were requested");
  const history = host.querySelector<HTMLDetailsElement>(".setup-history")!;
  expect(history.open).toBe(false); expect(history.textContent).toContain("Compiler version did not pass");
  expect(host.querySelector(".setup-observation .ok-text")).toBeNull();
});
it("shows verified as a recorded past observation with no live-validity promise", () => {
  const host = render(setupObservation()); expect(host.textContent).toContain("Latest recorded observation"); expect(host.textContent).toContain("Local setup was verified");
  expect(host.textContent).toContain("Observed"); expect(host.textContent).not.toMatch(/ready now|currently valid|automatically repaired/i);
});
it("keeps a malformed observation visible as incomplete", () => {
  const attempt = setupObservation(); delete (attempt as Partial<CheckSetupAttempt>).requirements;
  const host = render(attempt); expect(host.textContent).toContain("Setup observation is malformed"); expect(host.querySelector(".ok-text")).toBeNull();
});
it("groups only the supplied step's records by product and keeps earlier phases collapsed", () => {
  const before = setupObservation("shop", 7, 800_000), after = setupObservation("shop", 0, 900_000); after.position = "after-checks";
  const billing = setupObservation("billing", 7, 950_000), host = document.createElement("div");
  host.innerHTML = renderToStaticMarkup(<StepCheckSetups attempts={[before, after, billing]} productName={id => id === "shop" ? "Shop" : "Billing"} />);
  expect([...host.querySelectorAll("h5")].map(heading => heading.textContent)).toEqual(["Shop", "Billing"]);
  expect(host.querySelector(".setup-product .setup-observation")?.textContent).toContain("After automated checks");
  expect(host.querySelector<HTMLDetailsElement>(".setup-history")?.open).toBe(false); expect(host.textContent).toContain("Before automated checks");
});

for (const shared of [false, true]) for (const code of [0, 7]) it(`keeps same-code setup drift separate from recorded product exit ${code} (shared=${shared})`, () => {
  const state = oneTaskFixture(), base = state.tasks[0]!, before = setupObservation(base.productId), after = setupObservation(base.productId, 0, 1_000_100);
  after.position = "after-checks"; after.identity!.prerequisites = { kind: "declared", observations: "e".repeat(64) };
  const run = { ...before.results[0]!.run, name: "Product tests", command: "bun test", ok: code === 0, execution: completeCheckExecution(code) };
  const checks = { current: false, at: 1_000_050, sha: before.input.sha, tree: before.input.tree, definition: before.input.definition, results: [run], environment: { ...before.identity!, setupAttempts: { before: before.id, after: after.id } } };
  const work = { productId: base.productId, delivery: "local" as const, completedStages: [], checks, checkSetup: after };
  const task: Task = { ...base, findings: [], checks: shared ? undefined : checks, checkSetup: shared ? undefined : after, repositories: shared ? [work] : undefined };
  const host = document.createElement("div"); host.innerHTML = renderToStaticMarkup(<ReviewView task={task} now={state.now} find={lookup(state)} />);
  const note = [...host.querySelectorAll("p")].find(paragraph => paragraph.textContent?.startsWith("Recorded check results"))!;
  expect(note.textContent).toBe("Recorded check results need fresh verification before delivery.");
  expect(note.textContent).not.toMatch(/earlier version|not run/i);
  expect(host.querySelector(".issue-status .label")?.textContent).toBe(code === 0 ? "Passed" : "Failed");
  expect(checkProblem(task)).toBe(code === 0 ? "unverified" : "failing");
  expect(after.input.tree).toBe(before.input.tree);
});
