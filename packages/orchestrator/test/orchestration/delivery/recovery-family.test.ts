import { expect, it } from "vitest";
import { blockingDependencies, resumeTaskState, type ShippingRecord } from "@petrina/core";
import { CARRIED_OVER } from "../../../src/delivery-recovery.js";
import { executionFor, scopesFor } from "../../../src/repository-context.js";
import { deferred } from "../../fixtures/check-setup.js";
import { deliveryRecoveryFixture, observations } from "../../fixtures/delivery-recovery.js";
import type { GitHubCreated } from "../../../src/ports/github.js";

const pr = { number: 1, url: "https://github.com/acme/demo/pull/1", state: "open" as const };
const release = { tag: "v0.1.0", url: "https://github.com/acme/demo/releases/tag/v0.1.0" };

for (const mode of ["pull-request", "release"] as const) it(`keeps the ${mode} that went out while the task was cancelled`, async () => {
  const f = deliveryRecoveryFixture(["a"], mode); f.prepared();
  f.task.state = "cancelled"; f.task.column = "done"; f.task.statusLine = "Cancelled";
  f.observations.lookup.add({ found: true, text: mode, evidence: mode === "release" ? { kind: "release", release } : { kind: "pr", pr } });
  await f.monitor.settleCancelled(f.task.id);
  expect(f.task.state).toBe("cancelled"); expect(f.task.column).toBe("done"); expect(f.task.statusLine).toBe("Cancelled");
  expect(f.scope.work.shipping).toBeUndefined();
  if (mode === "pull-request") {
    expect(f.scope.work.pr).toMatchObject(pr);
    expect(f.notes).toContain(`Pull request #1 went out while you cancelled it: ${pr.url}`);
  } else {
    expect(f.scope.work.release).toEqual(release);
    expect(f.notes).toContain(`Release v0.1.0 went out while you cancelled it: ${release.url}`);
  }
  expect(f.published).toEqual([]); expect(f.state.inbox).toEqual([]);
  expect(f.recoveryEvents).not.toContain(`delivered:${f.task.id}`);
  expect(f.recoveryEvents).not.toContain(`done:${f.task.id}`);
  expect(f.observations.lookup.pending).toEqual([]);
});

it("keeps unknown cancelled delivery preparation, records its warning once, and later records the observed publication", async () => {
  const f = deliveryRecoveryFixture(); const shipping = f.prepared(); f.task.state = "cancelled";
  for (let attempt = 0; attempt < 2; attempt++) {
    f.observations.lookup.add({ found: "unknown", text: "GitHub could not be asked" });
    await f.monitor.settleCancelled(f.task.id);
    expect(f.scope.work.shipping).toBe(shipping); expect(f.scope.work.pr).toBeUndefined();
  }
  expect(f.notes).toHaveLength(1); expect(f.state.inbox).toEqual([]);
  f.observations.lookup.add({ found: true, text: "pull request #1", evidence: { kind: "pr", pr } });
  await f.monitor.settleCancelled(f.task.id);
  expect(f.scope.work.pr).toMatchObject(pr); expect(f.scope.work.shipping).toBeUndefined();
  expect(f.scope.work.cleanup).toBeUndefined(); expect(f.task.state).toBe("cancelled");
  expect(f.published).toEqual([]);
});

it("joins a cancelled delivery observation and refuses overlapping observers or an active driver", async () => {
  const f = deliveryRecoveryFixture(); f.prepared(); f.task.state = "cancelled";
  const answer = deferred<{ found: false; text: string }>();
  f.observations.lookup.effect(() => answer.promise);
  f.drivers.add(f.task.id);
  await f.monitor.settleCancelled(f.task.id); expect(f.observations.lookup.pending).toHaveLength(1);
  const operation = f.monitor.settleCancelled(f.task.id, true);
  try {
    await f.monitor.settleCancelled(f.task.id, true);
    expect(f.recoveryEvents.filter(entry => entry === "lookup:a")).toHaveLength(1);
    answer.resolve({ found: false, text: "No publication" }); await operation;
    expect(f.scope.work.shipping).toBeUndefined(); expect(f.task.state).toBe("cancelled");
  } finally { answer.resolve({ found: false, text: "No publication" }); await operation; }
});

for (const found of ["unknown", "other"] as const) it(`leaves an interrupted ${found} observation to the coordinator without publishing`, async () => {
  const f = deliveryRecoveryFixture(); f.prepared(); f.restart();
  f.observations.lookup.add({ found, text: "Observation requires a decision" });
  expect(await f.run(f.task)).toBe("stop");
  expect(f.task.state).toBe("needs-you"); expect(f.task.holdsSlot).toBe(false); expect(f.task.agent).toBeUndefined();
  expect(f.state.inbox.map(item => item.kind)).toEqual(["shipping"]);
  expect(f.state.inbox[0]!.body).toContain("will not publish it again on its own");
  expect(f.notes).toContain("Shipping was interrupted after a restart. Observation requires a decision");
  expect(f.published).toEqual([]);
  const decision = f.state.inbox[0]!;
  f.recovery.checkShipping(decision.id);
  expect(f.task.state).toBe("waiting"); expect(f.state.inbox).toEqual([]);
  f.observations.lookup.add({ found: true, text: "pull request #1", evidence: { kind: "pr", pr } });
  expect(await f.run(f.task)).toBe("stop");
  expect(f.task.state).toBe("pr-open"); expect(f.scope.work.pr).toMatchObject(pr); expect(f.published).toEqual([]);
});

it("does not mistake an unavailable fresh lookup for an empty answer", async () => {
  const f = deliveryRecoveryFixture(); f.prepared(); delete f.scope.work.shipping!.step;
  f.observations.lookup.add({ found: "unknown", text: "could not check GitHub for this task's pull request" });
  await expect(f.recovery.checkDelivery(f.scope, f.signal)).rejects.toThrow("could not check GitHub");
  expect(f.scope.work.pr).toBeUndefined(); expect(f.published).toEqual([]); expect(f.state.inbox).toEqual([]);
  f.observations.lookup.add({ found: false, text: "No pull request" });
  expect(await f.recovery.checkDelivery(f.scope, f.signal)).toBe("continue");
});

for (const mode of ["pull-request", "release"] as const) it(`looks again when GitHub says a ${mode} already exists after its first answer was lost`, async () => {
  const f = deliveryRecoveryFixture(["a"], mode), shipping = f.prepared();
  const creates = observations<GitHubCreated>();
  creates.add({ ok: false, exists: false, error: "answer lost" });
  creates.add({ ok: false, exists: true, error: "already exists" });
  const calls: string[] = [];
  const create = async () => { calls.push("create"); return creates.read(); };
  const publish = () => mode === "pull-request"
    ? f.recovery.createPullRequest(f.scope, f.signal, { create, find: async () => { calls.push("find"); return pr; } })
    : f.recovery.createRelease(f.scope, f.signal, { create, find: async () => { calls.push("find"); return release; }, tag: async () => { calls.push("tag"); return shipping.prepared!.tested; } });
  await expect(publish()).rejects.toThrow("GitHub did not");
  expect(f.scope.work.shipping).toBe(shipping); expect(f.scope.work.pr).toBeUndefined(); expect(f.scope.work.release).toBeUndefined();
  f.observations.lookup.add({ found: false, text: "Listing has not caught up" });
  expect(await f.recovery.checkDelivery(f.scope, f.signal)).toBe("continue");
  expect(await publish()).toBe("done");
  expect(f.task.state).toBe(mode === "pull-request" ? "pr-open" : "done");
  expect(calls).toEqual(["create", "create", "find", ...(mode === "release" ? ["tag"] : [])]);
  expect(creates.pending).toEqual([]); expect(f.scope.work.shipping).toBeUndefined();
  expect(f.recoveryEvents.filter(event => event === `delivered:${f.task.id}`)).toHaveLength(1);
});

it("refuses a duplicate create with no matching observation and a release whose tag changed", async () => {
  const f = deliveryRecoveryFixture(); f.prepared();
  await expect(f.recovery.createPullRequest(f.scope, f.signal, {
    create: async () => ({ ok: false, exists: true, error: "already exists" }), find: async () => undefined,
  })).rejects.toThrow("none matches this work");
  expect(f.scope.work.pr).toBeUndefined(); expect(f.scope.work.shipping).toBeDefined();
  const r = deliveryRecoveryFixture(["a"], "release"); r.prepared();
  await expect(r.recovery.createRelease(r.scope, r.signal, {
    create: async () => ({ ok: false, exists: true, error: "already exists" }), find: async () => release, tag: async () => "different-commit",
  })).rejects.toThrow("not at the tested commit");
  expect(r.scope.work.release).toBeUndefined(); expect(r.scope.work.shipping).toBeDefined();
});

it("asks for the delivery approval again after the coordinator chooses to ship an older delivery again", () => {
  const f = deliveryRecoveryFixture(); f.task.approveDelivery = true;
  // A stored pre-controller record is deliberately outside the current shipping schema.
  f.scope.work.shipping = { startedAt: 1, attempts: 1, head: "old-head" } as unknown as ShippingRecord;
  f.task.state = "running"; f.scope.work.approvedFor = { mode: "pull-request", by: "coordinator", destination: "old-destination" };
  f.recovery.carryOverShipping();
  expect(f.scope.work.shipping).toEqual({ moves: 0, failures: 0, carriedOver: true });
  expect(f.task.state).toBe("needs-you"); expect(f.task.statusLine).toBe(`${CARRIED_OVER}: check GitHub, then choose`);
  expect(f.state.inbox).toHaveLength(1); expect(f.recoveryEvents.filter(event => event.startsWith("lookup:"))).toEqual([]);
  f.recovery.shipAgain(f.state.inbox[0]!.id);
  expect(f.task.stageIndex).toBe(0); expect(f.task.sub).toBe(0); expect(f.task.state).toBe("waiting");
  expect(f.scope.work.shipping).toBeUndefined(); expect(f.scope.work.approvedFor).toBeUndefined();
  expect(f.published).toEqual([]); expect(f.recoveryEvents).toContain("schedule");
});

for (const prior of ["cancelled", "paused"] as const) it(`keeps an older ${prior} delivery inert until an explicit decision`, () => {
  const f = deliveryRecoveryFixture(); f.task.state = prior;
  f.scope.work.shipping = { startedAt: 1, attempts: 1, head: "old-head" } as unknown as ShippingRecord;
  f.recovery.carryOverShipping();
  expect(f.task.state).toBe(prior); expect(f.state.inbox).toEqual([]);
  expect(f.scope.work.shipping).toEqual({ moves: 0, failures: 0, carriedOver: true });
  if (prior === "cancelled") expect(f.task.statusLine).toBe(`Cancelled. ${CARRIED_OVER}: check GitHub for what went out`);
  else {
    expect(resumeTaskState(f.task, false)).toBe(true);
    f.recovery.askCarriedOver(f.task);
    expect(f.task.state).toBe("needs-you"); expect(f.state.inbox).toHaveLength(1);
  }
  expect(f.recoveryEvents.filter(event => event.startsWith("lookup:"))).toEqual([]); expect(f.published).toEqual([]);
});

it("reads shared PR states concurrently and ignores late replies after a driver starts", async () => {
  const f = deliveryRecoveryFixture(["a", "b"]); f.task.state = "pr-open";
  const replies = [deferred<"merged" | "closed">(), deferred<"merged" | "closed">()];
  for (const [index, bound] of scopesFor(f.task).entries()) {
    bound.work.pr = { ...pr, number: index + 1, openedAt: 1 };
    f.observations.prStates.effect(() => replies[index]!.promise);
  }
  const operation = f.monitor.pollPullRequests();
  try {
    expect(f.observations.prStates.pending).toEqual([]);
    f.drivers.add(f.task.id); replies[0]!.resolve("merged"); replies[1]!.resolve("closed"); await operation;
    expect(scopesFor(f.task).map(bound => bound.work.pr!.state)).toEqual(["open", "open"]); expect(f.task.state).toBe("pr-open");
  } finally { replies[0]!.resolve("merged"); replies[1]!.resolve("closed"); await operation; }
});

for (const closed of [false, true]) it(`keeps dependents blocked with one merged PR and one ${closed ? "closed" : "open"} PR`, async () => {
  const f = deliveryRecoveryFixture(["a", "b"]); f.task.state = "pr-open";
  const works = scopesFor(f.task).map(bound => bound.work);
  for (const [index, work] of works.entries()) work.pr = { ...pr, number: index + 1, openedAt: 1 };
  const dependent = { after: [f.task.id] };
  const blockers = () => blockingDependencies(dependent, id => f.tasks.get(id));
  f.observations.prStates.add(closed ? "open" : "merged"); f.observations.prStates.add(closed ? "closed" : "open");
  await f.monitor.pollPullRequests();
  expect(f.task.state).toBe(closed ? "needs-you" : "pr-open"); expect(blockers()).toEqual([f.task]);
  expect(works.map(work => work.pr!.state)).toEqual(closed ? ["open", "closed"] : ["merged", "open"]);
  if (closed) {
    expect(f.state.inbox[0]!.title).toContain(works[1]!.source!.product.name);
    f.recovery.markDone(f.state.inbox[0]!.id);
    expect(f.task.state).toBe("pr-open"); expect(blockers()).toEqual([f.task]);
    expect(works[1]!.landingAccepted).toEqual({ at: f.now() });
  }
  f.observations.prStates.add("merged"); await f.monitor.pollPullRequests();
  expect(f.task.state).toBe("done"); expect(blockers()).toEqual([]);
  expect(works.map(work => work.pr!.state)).toEqual(closed ? ["merged", "closed"] : ["merged", "merged"]);
  expect(f.published).toEqual([]); expect(f.observations.prStates.pending).toEqual([]);
});

it("ignores a shared PR reply after its recorded PR row was replaced", async () => {
  const f = deliveryRecoveryFixture(["a", "b"]); f.task.state = "pr-open";
  const works = scopesFor(f.task).map(bound => bound.work), answer = deferred<"merged">();
  for (const [index, work] of works.entries()) work.pr = { ...pr, number: index + 1, openedAt: 1 };
  f.observations.prStates.effect(() => answer.promise); f.observations.prStates.add("open");
  const operation = f.monitor.pollPullRequests();
  try {
    works[0]!.pr = { ...pr, number: 3, openedAt: 2 };
    answer.resolve("merged"); await operation;
    expect(works[0]!.pr).toMatchObject({ number: 3, state: "open", openedAt: 2 }); expect(f.task.state).toBe("pr-open");
  } finally { answer.resolve("merged"); await operation; }
});

it("settles every monitored peer before propagating one publication checkpoint failure", async () => {
  const f = deliveryRecoveryFixture(), second = f.add("second", ["b"], "pull-request");
  second.productId = "b"; f.state.tasks.push(second);
  for (const current of [f.task, second]) {
    current.state = "pr-open";
    const work = executionFor(current).work;
    work.worktree = `scripted:copy:${current.id}`;
    work.pr = { ...pr, openedAt: 1 };
  }
  const failed = deferred<void>(), held = deferred<"merged">();
  f.observations.prStates.add("merged"); f.observations.prStates.effect(() => held.promise);
  let commits = 0, settled = false;
  const error = new Error("Could not save the first result");
  f.monitorHost.commit = () => { if (++commits === 1) { failed.resolve(); throw error; } };
  const operation = f.monitor.pollPullRequests().then(() => { settled = true; return undefined; }, caught => { settled = true; return caught; });
  try {
    await failed.promise;
    expect(settled).toBe(false); expect(second.state).toBe("pr-open");
    held.resolve("merged"); expect(await operation).toBe(error);
    expect(second.state).toBe("done"); expect(commits).toBe(2);
    expect(f.recoveryEvents).toContain("tidy:second");
  } finally { held.resolve("merged"); await operation; }
});

it("batches open pull request checks across single-repo and multi-repo tasks into one request per repository", async () => {
  const f = deliveryRecoveryFixture(["a", "b"]);
  f.task.state = "pr-open";
  const sharedWorks = scopesFor(f.task).map((bound) => bound.work);
  sharedWorks[0]!.pr = { ...pr, number: 1, openedAt: 1 };
  sharedWorks[1]!.pr = { ...pr, number: 101, openedAt: 1 };

  for (let index = 0; index < 11; index++) {
    const extraA = f.add(`single-a-${index}`, ["a"], "pull-request");
    extraA.productId = "a";
    extraA.state = "pr-open";
    const workA = executionFor(extraA).work;
    workA.worktree = `scripted:copy:${extraA.id}`;
    workA.pr = { ...pr, number: index + 2, openedAt: 1 };
    f.state.tasks.push(extraA);
    f.observations.prStates.add(index === 4 ? "merged" : "open");
  }
  for (let index = 0; index < 7; index++) {
    const extraB = f.add(`single-b-${index}`, ["b"], "pull-request");
    extraB.productId = "b";
    extraB.state = "pr-open";
    const workB = executionFor(extraB).work;
    workB.worktree = `scripted:copy:${extraB.id}`;
    workB.pr = { ...pr, number: index + 102, openedAt: 1 };
    f.state.tasks.push(extraB);
    f.observations.prStates.add(index === 2 ? "closed" : "open");
  }
  // Account for the 2 PRs on the shared multi-repo task as well (20 total PRs across 2 repos).
  f.observations.prStates.add("open");
  f.observations.prStates.add("open");

  await f.monitor.pollPullRequests();

  expect(f.batchCalls).toHaveLength(2);
  const byRepo = new Map(f.batchCalls.map((entry) => [entry.repo, entry.numbers]));
  expect([...byRepo.keys()].sort()).toEqual(["local/a", "local/b"]);
  expect(byRepo.get("local/a")).toHaveLength(12);
  expect(byRepo.get("local/b")).toHaveLength(8);
  expect(f.observations.prStates.pending).toEqual([]);
});
