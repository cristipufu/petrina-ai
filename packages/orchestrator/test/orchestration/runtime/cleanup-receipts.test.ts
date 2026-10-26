import { expect, it } from "vitest";
import { CleanupReceipts } from "../../../src/cleanup-receipts.js";
import { deferred } from "../../fixtures/tool-checks.js";

const outcome = <T>(work: Promise<T>) => work.then(value => ({ kind: "value" as const, value }), error => ({ kind: "error" as const, error }));

for (const value of [true, false, undefined, null, 1]) it(`requires literal cleanup confirmation: ${String(value)}`, async () => {
  const receipts = new CleanupReceipts(), owner = {};
  const result = await outcome(receipts.request("task", owner, async () => value as boolean));
  expect(result.kind).toBe(value === true ? "value" : "error");
  expect(receipts.has("task")).toBe(value !== true);
  expect(receipts.pending).toBe(0);
  const waited = await outcome(receipts.wait("task"));
  expect(waited.kind).toBe(result.kind);
  if (result.kind === "error" && waited.kind === "error") expect(waited.error).toBe(result.error);
});

for (const mode of ["throw", "reject"] as const) for (const error of [new Error("Stop failed"), undefined]) it(`retains ${mode} ${String(error)} after its scheduling entry disappears`, async () => {
  const receipts = new CleanupReceipts(), owner = {};
  const stopped = receipts.request("task", owner, () => { if (mode === "throw") throw error; return Promise.reject(error); });
  expect(await outcome(stopped)).toEqual({ kind: "error", error });
  expect(await outcome(receipts.wait("task"))).toEqual({ kind: "error", error });
  expect(receipts.has("task")).toBe(true);
});

it("publishes a single stop before synchronous reentry and preserves the actual callback receiver", async () => {
  const receipts = new CleanupReceipts(), owner = {}, gate = deferred<boolean>();
  let calls = 0, reentered: Promise<void> | undefined;
  const first = receipts.request("task", owner, () => {
    calls++;
    reentered = receipts.request("task", owner, () => { throw new Error("A second stop was started"); });
    expect(receipts.has("task")).toBe(true);
    expect(receipts.pending).toBe(1);
    return gate.promise;
  });
  expect(reentered).toBe(first);
  gate.resolve(true);
  await first;
  expect(calls).toBe(1);
  expect(receipts.size).toBe(0);
});

it("keeps different tasks and working copies independent while their native cleanup is pending", async () => {
  const receipts = new CleanupReceipts(), left = deferred<void>(), right = deferred<void>();
  receipts.observe("left", {}, left.promise, "copy-a");
  receipts.observe("right", {}, right.promise, "copy-b");
  await receipts.wait("left", "other-copy");
  right.resolve();
  await receipts.wait("right");
  expect(receipts.has("left")).toBe(true);
  expect(receipts.has("right")).toBe(false);
  left.resolve();
  await receipts.wait("left", "copy-a");
  expect(receipts.size).toBe(0);
});

it("joins a cleanup registered by the first owner's completion before returning", async () => {
  const receipts = new CleanupReceipts(), first = deferred<void>(), next = deferred<void>();
  receipts.observe("task", {}, first.promise);
  void first.promise.then(() => receipts.observe("task", {}, next.promise));
  let completed = false;
  const waiting = receipts.wait("task").then(() => { completed = true; });
  first.resolve();
  await first.promise;
  await Promise.resolve();
  expect(completed).toBe(false);
  next.resolve();
  await waiting;
  expect(receipts.size).toBe(0);
});

it("reports a bounded failed stop without hanging on a native exit that never arrives", async () => {
  const receipts = new CleanupReceipts(), owner = {}, neverExited = deferred<void>();
  receipts.observe("task", owner, neverExited.promise, "copy");
  const stopped = receipts.request("task", owner, async () => {
    receipts.incomplete("task", owner, "copy");
    return false;
  }, "copy");
  const result = await outcome(stopped);
  expect(result.kind).toBe("error");
  expect(await outcome(receipts.wait("task"))).toEqual(result);
  expect(receipts.has("task")).toBe(true);
  // Independent fixture completion cannot erase the previously unconfirmed result.
  neverExited.resolve();
  await neverExited.promise;
  expect((await outcome(receipts.wait("task"))).kind).toBe("error");
});

it("keeps a cleanup failure from an opening that never returned a session", async () => {
  const receipts = new CleanupReceipts(), native = deferred<void>(), error = new Error("Opening cleanup failed");
  receipts.observe("task", {}, native.promise, "copy");
  native.reject(error);
  expect(await outcome(receipts.wait("task"))).toEqual({ kind: "error", error });
  expect(receipts.has("task")).toBe(true);
});

for (const failure of ["incomplete", "native-rejection"] as const) it(`wakes a failed barrier while its raw stop remains pending: ${failure}`, async () => {
  const receipts = new CleanupReceipts(), owner = {}, native = deferred<void>(), rawStop = deferred<boolean>();
  const error = new Error("The native cleanup could not finish");
  receipts.observe("task", owner, native.promise, "copy");
  const stopping = receipts.request("task", owner, () => rawStop.promise, "copy");
  if (failure === "incomplete") receipts.incomplete("task", owner, "copy");
  else native.reject(error);
  try {
    const result = await outcome(stopping);
    expect(result.kind).toBe("error");
    if (failure === "native-rejection") expect(result).toEqual({ kind: "error", error });
    expect((await outcome(receipts.wait("task", "copy"))).kind).toBe("error");
    expect(receipts.has("task")).toBe(true);
    expect(receipts.pending).toBe(1);
  } finally { native.resolve(); rawStop.resolve(true); }
  await rawStop.promise;
  expect((await outcome(receipts.wait("task"))).kind).toBe("error");
});

it("requests every peer even when one stop throws, and waits for the held peer before reporting failure", async () => {
  const receipts = new CleanupReceipts(), peer = deferred<boolean>(), error = new Error("First stop threw");
  const calls: number[] = [];
  const work = [() => { calls.push(1); throw error; }, () => { calls.push(2); return peer.promise; }]
    .map(stop => receipts.request("task", {}, stop));
  expect(calls).toEqual([1, 2]);
  let completed = false;
  const waiting = outcome(receipts.wait("task")).then(result => { completed = true; return result; });
  await Promise.resolve();
  expect(completed).toBe(false);
  peer.resolve(true);
  expect(await waiting).toEqual({ kind: "error", error });
  await Promise.allSettled(work);
});

it("does not convert an incomplete callback into success when stop subsequently reports true", async () => {
  const receipts = new CleanupReceipts(), owner = {};
  const result = await outcome(receipts.request("task", owner, async () => {
    receipts.incomplete("task", owner);
    return true;
  }));
  expect(result.kind).toBe("error");
  expect(await outcome(receipts.wait("task"))).toEqual(result);
});

it("does not let a cleanup identity move between tasks or working copies", async () => {
  const receipts = new CleanupReceipts(), owner = {}, native = deferred<void>();
  receipts.observe("task", owner, native.promise, "copy");
  expect(() => receipts.request("other", owner, async () => true, "copy")).toThrow("cannot move");
  expect(() => receipts.request("task", owner, async () => true, "other-copy")).toThrow("cannot move");
  native.resolve();
  await receipts.wait();
});

for (const first of ["native", "stop"] as const) for (const nativeError of [new Error("Native failure"), undefined]) it(`preserves both distinct cleanup errors, ${first} first and native ${String(nativeError)}`, async () => {
  const receipts = new CleanupReceipts(), owner = {}, native = deferred<void>(), rawStop = deferred<boolean>();
  const stopError = new Error("Stop failure");
  receipts.observe("task", owner, native.promise);
  const stopped = outcome(receipts.request("task", owner, () => rawStop.promise));
  if (first === "native") { native.reject(nativeError); await outcome(native.promise); rawStop.reject(stopError); }
  else { rawStop.reject(stopError); await stopped; native.reject(nativeError); }
  await Promise.allSettled([native.promise, rawStop.promise]);
  const result = await outcome(receipts.wait("task"));
  expect(result.kind).toBe("error");
  if (result.kind !== "error") throw new Error("Two failed cleanup observations became success");
  expect(result.error).toBeInstanceOf(AggregateError);
  expect((result.error as AggregateError).errors).toEqual([nativeError, stopError]);
  expect(await outcome(receipts.wait("task"))).toEqual(result);
});
