import { expect, it } from "vitest";
import { beginPetrinaStep, endPetrinaStep, WorkflowObserver, type WorkflowContext } from "../../../src/index.js";
import { workflowFixture } from "../../fixtures/workflow.js";
import { setupAttempt, setupRequirement } from "../../fixtures/check-setup.js";

it("reports bounded recorded setup outcomes separately from product-check counts and links the owning node", () => {
  const { task, state } = workflowFixture();
  const context: WorkflowContext = { roles: state.roles, profiles: state.profiles, products: state.products, inbox: [], now: 5 };
  const step = beginPetrinaStep(task, "checks", 1), observer = new WorkflowObserver();
  observer.baseline(task, context);
  step.checkSetups = JSON.parse(JSON.stringify(Array.from({ length: 15 }, (_, index) => {
    const attempt = setupAttempt([setupRequirement]);
    attempt.id = `setup-${index}`;
    attempt.results[0]!.run.output = "Do not expand the complete setup output in a compact event";
    return attempt;
  })));
  endPetrinaStep(task, { outcome: "Checks unverified", reason: "The local setup changed" }, 5);
  const event = observer.observe(task, context).find(event => event.kind === "node.finished")!;
  expect(event.localSetup).toMatchObject({ count: 15, omittedEarlier: 3, attempts: Array.from({ length: 12 }, (_, index) => ({ id: `setup-${index + 3}`, state: "verified", productId: "shop" })) });
  expect(event.refs).toMatchObject({ node: { taskId: task.id, nodeId: step.id } });
  expect(event.checks).toMatchObject({ attempts: 0, configured: 0, ran: 0, passed: 0, failed: 0, unfinished: 0, skipped: 0 });
  expect(JSON.stringify(event)).not.toContain("Do not expand");
  expect(observer.observe(task, context)).toEqual([]);
});
