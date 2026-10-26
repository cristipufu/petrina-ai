import { expect, it, vi } from "vitest";
import { scopesFor } from "../../../src/repository-context.js";
import { waitForAgentUsage } from "../../../src/agent-step-state.js";
import { DeliveryObservationFailure, deliveryWorkflowFixture } from "../../fixtures/delivery-workflow.js";

it("prepares every unpublished product before the first publication and finalizes companions once", async () => {
  const f = deliveryWorkflowFixture(), task = f.add("shared", ["a", "b"]);
  expect(await f.run(task)).toBe("stop");
  const calls = f.events.filter(value => /^(prepare|lookup|publish|companions):/.test(value));
  expect(calls).toEqual(["prepare:shared:a", "prepare:shared:b", "lookup:shared:a", "publish:shared:a", "lookup:shared:b", "publish:shared:b", "companions:shared"]);
  expect(f.published.map(row => row.product)).toEqual(["a", "b"]);
  expect(task.state).toBe("done");
  expect(task.finishedAt).toBe(f.now());
  expect(f.counts).toMatchObject({ companions: 1, delivered: 1, done: 1 });
  f.workflow.finishMany(task);
  expect(f.counts).toMatchObject({ companions: 1, delivered: 1, done: 1 });
  f.admission.finishDeliveryTurn(task.id);
  expect(f.admission.entries()).toEqual([]);
});

for (const result of ["back", "continue", "stop"] as const) it(`never publishes after a native phase returns ${result}`, async () => {
  const f = deliveryWorkflowFixture(), task = f.add("shared", ["a", "b"]);
  if (result === "back") f.hooks.readyToShip = async () => "back";
  else f.hooks.prepare = async () => result;
  expect(await f.run(task)).toBe(result === "back" ? "continue" : result);
  expect(f.published).toEqual([]);
  expect(f.events.some(value => value === "prepare:shared:b")).toBe(false);
});

for (const at of ["ready", "prepare"] as const) it(`discards every shared preparation when the destination epoch changes during ${at}`, async () => {
  const f = deliveryWorkflowFixture(), task = f.add("shared", ["a", "b"]);
  let released = false;
  const release = () => { if (!released) { released = true; f.admission.releaseDeliveryTurn(task.id); } };
  if (at === "ready") f.hooks.readyToShip = async scope => { if (scope.work.productId === "b") release(); return "ready"; };
  else f.hooks.prepare = async scope => { f.prepareObservation(scope); if (scope.work.productId === "b") release(); return "ready"; };
  expect(await f.run(task)).toBe("continue");
  expect(released).toBe(true);
  expect(scopesFor(task).every(({ work }) => !work.shipping?.prepared)).toBe(true);
  expect(f.published).toEqual([]);
  expect(f.admission.epoch(task)).toBe(1);
});

it("keeps a live driver's original destination request when it yields before delivery", async () => {
  const f = deliveryWorkflowFixture(), first = f.add("first"), second = f.add("second"), third = f.add("third");
  second.state = "waiting"; third.state = "waiting"; third.startedAt = 0;
  expect(f.admission.waitingForTurn(first)).toBeUndefined();
  expect(f.admission.waitingForTurn(second)).toContain("first");
  f.admission.finishDeliveryTurn(second.id);
  expect(f.admission.waitingForTurn(third)).toContain("first");
  f.admission.releaseDeliveryTurn(first.id);
  expect(f.admission.waitingForTurn(third)).toBe("Waiting for “second” to finish delivering to main");
  expect(f.admission.waitingForTurn(second)).toBeUndefined();
  expect(f.events).toEqual([]);
  second.state = "running";
  expect(await f.run(second)).toBe("stop");
  f.admission.finishDeliveryTurn(second.id);
  third.state = "running";
  expect(await f.run(third)).toBe("stop");
  f.admission.finishDeliveryTurn(third.id);
  expect(f.published.map(row => row.task)).toEqual(["second", "third"]);
  expect(f.admission.entries()).toEqual([]);
});

it("reacquires a released delivery turn before a live decision resumes publication", async () => {
  const f = deliveryWorkflowFixture(), first = f.add("first"), second = f.add("second");
  expect(f.admission.waitingForTurn(first)).toBeUndefined();
  f.drivers.add(first.id); first.state = "needs-you"; f.admission.syncDeliveryTurns();
  expect(f.admission.waitingForTurn(second)).toBeUndefined();
  first.state = "running";
  expect(() => f.workflow.beforePublishing(f.scope(first))).toThrow(DeliveryObservationFailure);
  expect(f.published).toEqual([]);
  expect(await f.run(second)).toBe("stop"); f.admission.finishDeliveryTurn(second.id);
  expect(await f.run(first)).toBe("stop"); f.admission.finishDeliveryTurn(first.id);
  expect(f.published.map(row => row.task)).toEqual(["second", "first"]);
});

it("refreshes every unpublished shared preparation after yielding its turn for a hold", async () => {
  const f = deliveryWorkflowFixture(), task = f.add("shared", ["a", "b"]);
  let held = false;
  f.hooks.prepare = async scope => {
    if (scope.work.productId === "b" && !held) {
      held = true; task.held = true;
      throw new DeliveryObservationFailure("waiting", "This task is on hold");
    }
    f.prepareObservation(scope);
    return "ready";
  };
  await expect(f.run(task)).rejects.toMatchObject({ kind: "waiting" });
  // Compose the same actual wait-state leaf and destination finally used by the live Driver.
  waitForAgentUsage(task, "This task is on hold", f.now(), () => "ready");
  f.admission.finishDeliveryTurn(task.id);
  expect(scopesFor(task).every(({ work }) => !work.shipping?.prepared)).toBe(true);
  expect(f.published).toEqual([]);
  expect(f.admission.entries()).toEqual([]);
  task.held = false; task.state = "running";
  for (const { work } of scopesFor(task)) f.observations.set(work, { head: `new-head-${work.productId}`, candidate: `new-candidate-${work.productId}` });
  expect(await f.run(task)).toBe("stop");
  expect(f.published.map(row => row.candidate)).toEqual(["new-candidate-a", "new-candidate-b"]);
  expect(f.events.filter(value => value.startsWith("prepare:"))).toEqual(["prepare:shared:a", "prepare:shared:b", "prepare:shared:a", "prepare:shared:b"]);
});

it("refreshes all shared products before publishing after an unchanged product confirms its address", async () => {
  const f = deliveryWorkflowFixture(), task = f.add("shared", ["a", "c", "b"]);
  f.hooks.head = async scope => {
    if (scope.work.productId !== "b") return f.observations.get(scope.work)!.head;
    expect(f.admission.yieldForDecision(task)).toBe(true);
    return scope.work.baseSha!;
  };
  expect(await f.run(task)).toBe("continue");
  expect(scopesFor(task).slice(0, 2).every(({ work }) => !work.shipping?.prepared)).toBe(true);
  expect(scopesFor(task)[2]!.work.nothingToPublish).toBe(true);
  expect(f.published).toEqual([]);
  expect(f.admission.epoch(task)).toBe(1);
});

for (const mode of ["pull-request", "release"] as const) for (const stop of ["shared pool pause", "shared engine drain", "single pool pause"] as const)
it(`keeps prepared ${mode} candidates through a ${stop} without local destination turns`, async () => {
  const f = deliveryWorkflowFixture(), task = f.add("prepared", stop.startsWith("shared") ? ["a", "b"] : ["a"], mode);
  const candidates: string[] = [];
  f.hooks.prepare = async scope => {
    f.prepareObservation(scope); candidates.push(scope.work.shipping!.prepared!.tested);
    if (candidates.length === scopesFor(task).length) {
      if (stop.endsWith("drain")) f.state.draining = true; else f.state.paused = true;
    }
    return "ready";
  };
  await expect(f.run(task)).rejects.toMatchObject({ kind: "waiting" });
  expect(candidates).toHaveLength(scopesFor(task).length);
  expect(scopesFor(task).map(({ work }) => work.shipping?.prepared?.tested)).toEqual(candidates);
  expect(f.admission.entries()).toEqual([]);
  expect(f.published).toEqual([]);
  const preparedCalls = f.events.filter(value => value.startsWith("prepare:"));
  f.state.paused = false; f.state.draining = false;
  expect(await f.run(task)).toBe("stop");
  expect(f.published.map(row => row.candidate)).toEqual(candidates);
  expect(f.events.filter(value => value.startsWith("prepare:"))).toEqual(preparedCalls);
  expect(f.admission.entries()).toEqual([]);
});

for (const flag of ["paused", "draining", "stopped", "extraRecovery"] as const) it(`blocks new publication while ${flag}, but settles an admitted publication first`, async () => {
  const f = deliveryWorkflowFixture(), task = f.add("blocked"); f.state[flag] = true;
  await expect(f.run(task)).rejects.toMatchObject({ kind: "waiting" });
  expect(f.events).toEqual([]);
  const work = f.scope(task).work;
  f.prepareObservation(f.scope(task)); work.shipping!.step = "update";
  f.hooks.checkDelivery = async scope => { scope.work.landed = { branch: "main", sha: "recorded-existing-publication" }; return "stop"; };
  expect(await f.run(task)).toBe("stop");
  expect(f.events.filter(value => /^(lookup|publish|prepare|login):/.test(value))).toEqual(["lookup:blocked:a"]);
  expect(f.published).toEqual([]);
});

for (const kind of ["proof", "acceptance"] as const) it(`looks up existing publication before returning for a ${kind} decision`, async () => {
  const f = deliveryWorkflowFixture(), task = f.add("gap");
  f.prepareObservation(f.scope(task));
  if (kind === "proof") {
    task.proofRequests = [{ id: "proof", text: "Required", reason: "Evidence", productIds: ["a"], requestedBy: { stageId: "review", round: 0, seat: "voter", roleId: "code-reviewer", profileId: "review" }, reviewedVersions: {}, ownerStageId: "review", status: "unverified", source: "review-result" }];
    f.hooks.proofApprovalCurrent = async () => false;
  } else task.brief = { summary: "Gap", forUsers: [], areas: [], risks: [], acceptance: [{ text: "Unavailable requirement", verification: "blocked" }] };
  expect(await f.run(task)).toBe("continue");
  expect(f.events.filter(value => /^(lookup|proof|decision|publish):/.test(value))).toEqual(["lookup:gap:a", ...(kind === "proof" ? ["proof:gap"] : []), `decision:gap:${kind}`]);
  expect(f.published).toEqual([]);
});

for (const original of [new Error("Original native phase failure"), undefined]) it(`preserves ${original === undefined ? "undefined" : "Error"} phase rejections and releases a changed stage`, async () => {
  const f = deliveryWorkflowFixture(), task = f.add("failure", ["a", "b"]);
  f.hooks.prepare = async () => { task.stageIndex = 0; throw original; };
  let failed = false, caught: unknown;
  try { await f.run(task); } catch (error) { failed = true; caught = error; }
  expect(failed).toBe(true); expect(caught).toBe(original);
  expect(f.admission.entries()).toEqual([]);
  expect(f.published).toEqual([]);
});

it("retries source movement through the native preparation effect and preserves aborts", async () => {
  const f = deliveryWorkflowFixture(), task = f.add("source");
  f.hooks.publish = async () => { throw new DeliveryObservationFailure("source-moved", "Main advanced"); };
  const explanations: string[] = [];
  f.hooks.prepareAgain = async (_scope, why) => { explanations.push(why); return "again"; };
  expect(await f.run(task)).toBe("continue"); expect(explanations).toEqual(["Main advanced"]);
  const controller = new AbortController(); controller.abort();
  await expect(f.run(task, controller.signal)).rejects.toMatchObject({ kind: "aborted" });
});

for (const kind of ["decision", "refresh"] as const) it(`keeps the established ${kind} handoff result`, async () => {
  const f = deliveryWorkflowFixture(), task = f.add("handoff");
  f.hooks.prepare = async () => { throw new DeliveryObservationFailure(kind); };
  expect(await f.run(task)).toBe("continue"); expect(f.published).toEqual([]);
});

for (const [failure, synchronous] of [[new Error("Closed PR lookup failed"), false], [undefined, true]] as const)
it(`joins every closed-PR lookup before propagating ${synchronous ? "synchronous undefined" : "rejected Error"}`, async () => {
  vi.useFakeTimers();
  const f = deliveryWorkflowFixture(), task = f.add("closed", ["a", "b", "c"], "pull-request");
  for (const { work } of scopesFor(task)) work.pr = { number: 1, url: "https://example.invalid/closed", state: "closed", openedAt: f.now() };
  let release!: () => void;
  const released = new Promise<void>(resolve => { release = resolve; });
  let returned = false;
  f.hooks.closedPullRequest = scope => {
    if (scope.work.productId === "a") { if (synchronous) throw failure; return Promise.reject(failure); }
    return released.then(() => "closed" as const);
  };
  const pending = f.run(task).then(() => ({ failed: false, error: undefined }), error => ({ failed: true, error })).then(result => { returned = true; return result; });
  try {
    let checkpoint = false; setTimeout(() => { checkpoint = true; }, 0); await vi.runAllTimersAsync();
    expect(checkpoint).toBe(true);
    expect(f.events).toEqual(["closed:closed:a", "closed:closed:b", "closed:closed:c"]);
    expect(returned).toBe(false);
    release();
    expect(await pending).toEqual({ failed: true, error: failure });
    expect(f.published).toEqual([]);
  } finally { release(); await pending; vi.useRealTimers(); }
});

it("clears only unpublished versions in the shared paused finally, preserving every admitted result", async () => {
  const f = deliveryWorkflowFixture(), task = f.add("cleanup", ["a", "b", "c"]);
  const [a, b, c] = scopesFor(task);
  a!.work.landed = { branch: "main", sha: "recorded-landed" };
  b!.work.shipping = { moves: 0, failures: 0, step: "push" };
  f.hooks.checkDelivery = async () => { task.state = "paused"; return "stop"; };
  expect(await f.run(task)).toBe("stop");
  expect(f.events.filter(value => value.startsWith("clear:"))).toEqual(["clear:cleanup:c"]);
  expect(a!.work.landed).toEqual({ branch: "main", sha: "recorded-landed" });
  expect(b!.work.shipping?.step).toBe("push"); expect(c!.work.landed).toBeUndefined();
});
