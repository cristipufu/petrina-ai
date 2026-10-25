import { expect, it } from "vitest";
import type { CheckRun, TaskSource } from "@petrina/core";
import { completeCheckExecution } from "@petrina/test-support/check-execution-facts";
import { productRows } from "../../../src/product-context.js";
import { repositoryTask } from "../../fixtures/tasks.js";

const checkRun = (changes: Partial<CheckRun> = {}): CheckRun => ({
  name: "Suite", command: "run-checks", ok: true, ms: 20, output: "Saved command output",
  execution: completeCheckExecution(0), ...changes,
});

it.each([
  ["complete pass", {}, "passed"],
  ["complete command failure", { ok: false, execution: completeCheckExecution(7) }, "failed"],
  ["startup unavailable despite a reported pass", { execution: { ...completeCheckExecution(0), started: false, exit: { status: "unreported" }, stdout: "incomplete", stderr: "incomplete", failure: { kind: "start", message: "Program unavailable" } } }, "could not start"],
  ["legacy reported pass without execution facts", { execution: undefined }, "unverified — execution details were not recorded"],
  ["legacy reported failure without execution facts", { ok: false, execution: undefined }, "unverified — execution details were not recorded"],
  ["interrupted reported pass", { interrupted: true }, "stopped"],
  ["timed-out reported pass", { execution: { ...completeCheckExecution(0), timedOut: true } }, "did not finish"],
  ["unreported exit despite a reported pass", { execution: { ...completeCheckExecution(0), exit: { status: "unreported" } } }, "exit was not reported"],
  ["incomplete output despite a reported pass", { execution: { ...completeCheckExecution(0), stdout: "incomplete" } }, "output did not finish"],
  ["unconfirmed cleanup despite a reported pass", { execution: { ...completeCheckExecution(0), cleanup: "unconfirmed" } }, "cleanup is unconfirmed"],
  ["reported pass contradicting a nonzero exit", { execution: completeCheckExecution(7) }, "unverified — recorded results disagree"],
  ["reported failure contradicting a zero exit", { ok: false }, "unverified — recorded results disagree"],
] satisfies readonly (readonly [string, Partial<CheckRun>, string])[])("labels %s from execution truth", (_name, changes, label) => {
  const rows = productRows({ repositories: [{ productId: "shop", delivery: "local", completedStages: [], checks: { at: 100, results: [checkRun(changes)] } }] });
  expect(rows?.[0]?.afterCopy).toBe(`; base version: not prepared; last completed review: none; inspect the full change\nBuilder report: not yet built. Checks: Suite: ${label}\nReview guide: use this product’s REVIEW.md at its saved base version.`);
});

it("keeps absent single-product membership distinct from an explicitly empty shared map", () => {
  expect(productRows(repositoryTask(false))).toBeUndefined();
  expect(productRows({})).toBeUndefined();
  expect(productRows({ repositories: [] })).toEqual([]);
});

it("keeps product order, source, copy, versions and report text while labeling each check", () => {
  const source: TaskSource = {
    product: { id: "api", name: "API", repo: "local/api" },
    start: { kind: "branch", branch: "stable" },
    destination: { kind: "branch", mode: "local", repo: "local/api", branch: "main" },
    confirmed: true,
  };
  const task = repositoryTask();
  task.activeProductId = "a";
  task.repositories = [
    { productId: "api", delivery: "local", completedStages: [], source, worktree: "private API copy", baseSha: "base-version", reviewedSha: "reviewed-version", report: { summary: "Kept report", changes: [] }, checks: { at: 100, results: [checkRun(), checkRun({ name: "Lint", ok: false, execution: completeCheckExecution(2) }), checkRun({ name: "Legacy", execution: undefined })] } },
    { productId: "shop", delivery: "local", completedStages: [] },
  ];
  const before = structuredClone(task);
  expect(productRows(task)).toEqual([
    { productId: "api", beforeCopy: "Works on: API (from stable)\nCommit to local/api · main\nProduct id: api; copy: ", copy: "private API copy", afterCopy: "; base version: base-version; last completed review: reviewed-version\nBuilder report: Kept report. Checks: Suite: passed, Lint: failed, Legacy: unverified — execution details were not recorded\nReview guide: use this product’s REVIEW.md at its saved base version." },
    { productId: "shop", beforeCopy: "shop\nProduct id: shop; copy: ", copy: "preparing", afterCopy: "; base version: not prepared; last completed review: none; inspect the full change\nBuilder report: not yet built. Checks: Not run\nReview guide: use this product’s REVIEW.md at its saved base version." },
  ]);
  expect(task).toEqual(before);
});

it("shows Not run for no check record or an empty result list", () => {
  const rows = productRows({ repositories: [
    { productId: "unconfigured", delivery: "local", completedStages: [] },
    { productId: "empty", delivery: "local", completedStages: [], checks: { at: 100, results: [] } },
  ] });
  expect(rows?.map(row => row.afterCopy)).toEqual([
    "; base version: not prepared; last completed review: none; inspect the full change\nBuilder report: not yet built. Checks: Not run\nReview guide: use this product’s REVIEW.md at its saved base version.",
    "; base version: not prepared; last completed review: none; inspect the full change\nBuilder report: not yet built. Checks: Not run\nReview guide: use this product’s REVIEW.md at its saved base version.",
  ]);
});
