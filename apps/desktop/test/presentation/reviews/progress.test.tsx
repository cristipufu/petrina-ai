import { oneTaskFixture } from "../../fixtures/state";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { type Task } from "@petrina/core";
import { ReviewView } from "../../../src/components/sheet/ReviewTab";
import { lookup } from "../../../src/lib";

describe("empty review progress", () => {
  const state = oneTaskFixture(1_000_000_000);

  const stages: NonNullable<Task["plan"]>["stages"] = [
    { id: "build", kind: "do", title: "Build", roleId: "builder", profileIds: ["opus-high"] },
    { id: "review", kind: "review-chain", title: "Review", roleId: "code-reviewer", profileIds: ["opus-high", "sol-high"] },
    { id: "approval", kind: "gate", title: "Delivery check", roleId: "release-manager", gate: "delivery", profileIds: [] },
    { id: "delivery", kind: "do", title: "Delivery", roleId: "release-manager", profileIds: ["opus-high"] },
  ];

  const checks = { at: state.now, results: [{ name: "Tests", command: "bun test", ms: 1_000, ok: true, output: "" }] };

  const waiting = "Reviews start after the build.";

  const reviewing = "No findings reported yet.";

  const passed = "Nothing to fix. Every reviewer passed it.";

  const cases: { name: string; extra: Partial<Task>; message: string }[] = [
    { name: "before planning", extra: { stageIndex: -1 }, message: waiting },
    { name: "during the build", extra: { stageIndex: 0 }, message: waiting },
    { name: "before the first review report", extra: { stageIndex: 1, hunt: { stageId: "review", round: 1, reported: {}, findings: 0 } }, message: reviewing },
    { name: "while another reviewer is pending", extra: { stageIndex: 1, hunt: { stageId: "review", round: 1, reported: { "0": true }, findings: 0 } }, message: reviewing },
    { name: "before the review round settles", extra: { stageIndex: 1, hunt: { stageId: "review", round: 1, reported: { "0": true, "1": true }, findings: 0 } }, message: reviewing },
    { name: "at delivery approval", extra: { stageIndex: 2, state: "needs-you" }, message: passed },
    { name: "while publishing", extra: { stageIndex: 3 }, message: passed },
    { name: "while awaiting merge", extra: { stageIndex: 3, state: "pr-open" }, message: passed },
    { name: "after completion", extra: { stageIndex: 4, state: "done" }, message: passed },
    { name: "without a review in the plan", extra: { stageIndex: 4, state: "done", plan: { rationale: "No review", plannerProfileId: "sonnet-medium", stages: [] } }, message: waiting },
    { name: "before a later planned review", extra: { stageIndex: 2, plan: { rationale: "Two reviews", plannerProfileId: "sonnet-medium", stages: [...stages, { ...stages[1]!, id: "final-review" }] } }, message: reviewing },
  ];

  for (const kind of ["single product", "single product with checks", "several products"] as const) {
    for (const { name, extra, message } of cases)
it(`shows ${name} for ${kind}`, () => {
      const task: Task = {
        ...state.tasks[0]!, state: "running", findings: [], hunt: undefined,
        plan: { rationale: "Review together", plannerProfileId: "sonnet-medium", stages },
        checks: kind === "single product with checks" ? checks : undefined,
        repositories: kind === "several products" ? state.products.slice(0, 2).map((product) => ({ productId: product.id, source: { product: { ...product, defaultBranch: "main" }, start: { kind: "default", branch: "main" }, destination: { mode: "pull-request", kind: "new-pr", repo: product.repo, branch: "main" }, confirmed: true }, delivery: "pull-request", completedStages: [], checks })) : undefined,
        ...extra,
      };
      const host = document.createElement("div");
      host.innerHTML = renderToStaticMarkup(<ReviewView now={state.now} task={task} find={lookup(state)} />);
      const sections = kind === "several products" ? [...host.children] : [host];
      expect(sections).toHaveLength(kind === "several products" ? 3 : 1);
      for (const section of sections) {
        expect(section.textContent).toContain(message);
        for (const other of [waiting, reviewing, passed].filter((text) => text !== message)) expect(section.textContent).not.toContain(other);
      }
      if (kind === "several products") expect(sections[2]!.querySelector("h2")?.textContent).toBe("Together");
    });

  }
});
