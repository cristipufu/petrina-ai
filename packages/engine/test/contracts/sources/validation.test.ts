import { engineCaseFixtures, type EngineCaseOwner } from "../../fixtures/engine-cases.js";
import { expectRejection } from "@petrina/test-support/rejections";
import { afterAll, expect, it, spyOn } from "bun:test";
import { join } from "node:path";
import type { TaskSource, WorkChoice } from "@petrina/core";

import { Coordination } from "../../../src/coordination.js";

const cases = engineCaseFixtures();
afterAll(() => cases.close());


async function prepareFixture(owner: EngineCaseOwner) {
  const root = owner.root;
  const engine = owner.open(root, { admissionsClosed: true, agentCommand: () => undefined, usageCommands: { codex: null, grok: null, antigravity: null } });
  await engine.waitUntilReady(); await Promise.all([...engine.backgroundWork]);
  engine.s.products.push({ id: "p", name: "Product", repo: "local/p", tone: "blue" });
  const task = engine.task(engine.addTask({ productId: "p", title: "Source choices", backlog: true }))!;
  engine.raise(task, "plan", "Check the plan", false);
  return { engine, task, sources: engine["sources"] };
}

function fixture<T>(owner: EngineCaseOwner, body: (fixture: Awaited<ReturnType<typeof prepareFixture>>) => Promise<T>): Promise<T> {
  return owner.prepare(async () => { const value = await prepareFixture(owner); owner.check(); return body(value); });
}
const choice = (name: string): WorkChoice => ({ productId: "p", startFrom: { kind: "branch", name }, delivery: "local" });
const resolved = (branch: string): TaskSource => ({ product: { id: "p", name: "Product", repo: "local/p" }, start: { kind: "branch", branch }, destination: { mode: "local", kind: "branch", repo: "local/p", branch: "main" }, confirmed: false });

it("saves in-flight single-product validation and blocks edits and approval until it finishes", async () => {
  return cases.use("petrina-source-validation-", owner => fixture(owner, async ({ engine, task, sources }) => {
  let finish: ((source: TaskSource) => void) | undefined;
  owner.onStop(() => finish?.(resolved("one")));
  const resolve = spyOn(sources, "resolve");
  owner.onStop(() => resolve.mockRestore());
  resolve.mockImplementation(() => new Promise(done => { finish = done; }));
  try {
    const pending = engine.setTaskStart(task.id, choice("one"));
    expect(task.workValidating).toBe(true);
    expect(engine.store.load()!.tasks.find(entry => entry.id === task.id)!.workValidating).toBe(true);
    await expectRejection(engine.setTaskStart(task.id, choice("two")), "Wait for validation");
    expect(() => sources.confirm(task)).toThrow("Wait for every product choice");
    finish!(resolved("one")); await pending;
    expect(task.workValidating).toBe(false); expect(task.workError).toBeUndefined();
    expect(task.proposedSource?.start.branch).toBe("one");
  } finally { resolve.mockRestore(); await owner.stop(engine); }

  }));
});

it("rejects a source edit for an absent shared product without clearing the lead choice, including through coordination", async () => {
  return cases.use("petrina-source-validation-", owner => fixture(owner, async ({ engine, task }) => {
  task.workRows = [{ choice: { ...choice("one"), lead: true } }];
  const before = JSON.stringify(task.workRows);
  try {
    const bad = { ...choice("missing"), productId: "missing", lead: true };
    await expectRejection(engine.setTaskStart(task.id, bad), "not in this task's product choices");
    expect(JSON.stringify(task.workRows)).toBe(before);
    const result = await new Coordination(engine).call("task.source", { taskId: task.id, choice: bad, requestId: "missing-product" });
    expect(result.outcome).toBe("invalid"); expect(JSON.stringify(task.workRows)).toBe(before);
  } finally { await owner.stop(engine); }

  }));
});

it("shows an addition's validation error without an Error prefix", async () => {
  return cases.use("petrina-source-validation-", owner => fixture(owner, async ({ engine, task, sources }) => {
  const source = resolved("main"); source.product = { id: "new", name: "New", repo: "acme/new" };
  task.workRows = [{ choice: { ...choice("main"), productId: "new", repo: "acme/new" }, source }];
  const resolve = spyOn(sources, "resolve");
  owner.onStop(() => resolve.mockRestore());
  resolve.mockRejectedValue(new Error("The branch is not on GitHub"));
  try {
    await sources.configureAddition(task, "acme/new", "New", join(engine.dataDir, "unused-clone"));
    expect(task.workRows[0]!.error).toBe("The branch is not on GitHub");
  } finally { resolve.mockRestore(); await owner.stop(engine); }

  }));
});
