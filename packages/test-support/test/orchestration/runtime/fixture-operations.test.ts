import { expect, it } from "bun:test";
import { rejectionOf } from "../../../src/rejections.js";
import { fixtureOperationControl, flushOperations } from "../../fixtures/fixture-operations.js";

it("publishes real operation ownership before a starter synchronously requests close", async () => {
  const f = fixtureOperationControl(), work = Promise.withResolvers<number>();
  let closing!: Promise<void>, closed = false;
  const returned = f.owner.run(() => { closing = f.owner.close(); return work.promise; });
  void closing.then(() => { closed = true; }, () => {});
  try {
    expect(returned).toBe(work.promise);
    await flushOperations();
    expect(f.effects.events).toEqual(["stop"]); expect(closed).toBe(false);
    expect([...f.effects.timers.values()].map(timer => timer.ms)).toEqual([5_000]);
    work.resolve(7);
    expect(await returned).toBe(7); await closing;
    expect(f.effects.events).toEqual(["stop", "dispose"]); expect(closed).toBe(true);
    expect(f.effects.timers.size).toBe(0); expect(f.effects.cancelled).toBe(1);
  } finally { work.resolve(7); await Promise.allSettled([returned, closing]); }
});

it("publishes one closing identity before synchronous stop re-enters close", async () => {
  const f = fixtureOperationControl(); let reentered!: Promise<void>;
  f.effects.stopEffect = () => { reentered = f.owner.close(); };
  const closing = f.owner.close();
  expect(reentered).toBe(closing); expect(f.owner.close()).toBe(closing);
  expect(f.effects.events).toEqual(["stop"]);
  await closing;
  expect(f.effects.events).toEqual(["stop", "dispose"]);
  expect(f.effects.timers.size).toBe(0); expect(f.effects.cancelled).toBe(1);
});

it("refuses a new starter during close without invoking it", async () => {
  const f = fixtureOperationControl(), work = Promise.withResolvers<void>();
  const running = f.owner.run(() => work.promise), closing = f.owner.close(); let starts = 0;
  try {
    const refused = await rejectionOf(f.owner.run(async () => { starts++; }));
    expect(starts).toBe(0); expect((refused as Error).message).toContain("is closing");
    work.resolve(); await Promise.all([running, closing]);
    expect(f.effects.events).toEqual(["stop", "dispose"]);
  } finally { work.resolve(); await Promise.allSettled([running, closing]); }
});

for (const error of [new Error("Direct operation failed"), undefined]) it(`preserves a completed operation's rejection ${String(error)} and never disposes it as success`, async () => {
  const f = fixtureOperationControl(), original = Promise.reject<void>(error);
  const returned = f.owner.run(() => original);
  expect(returned).toBe(original); expect(await rejectionOf(returned)).toBe(error);
  const failed = await rejectionOf(f.owner.close());
  expect(failed).toBeInstanceOf(AggregateError); expect((failed as AggregateError).errors).toEqual([error]);
  expect(f.effects.events).toEqual(["stop"]); expect(f.effects.timers.size).toBe(0);
});

for (const error of [new Error("Starter threw"), undefined]) it(`owns synchronous starter failure ${String(error)} before disposing`, async () => {
  const f = fixtureOperationControl();
  expect(await rejectionOf(f.owner.run(() => { throw error; }))).toBe(error);
  const failed = await rejectionOf(f.owner.close());
  expect(failed).toBeInstanceOf(AggregateError); expect((failed as AggregateError).errors).toEqual([error]);
  expect(f.effects.events).toEqual(["stop"]); expect(f.effects.timers.size).toBe(0);
});

it("waits for its real stop completion as well as the operations", async () => {
  const f = fixtureOperationControl(), stop = Promise.withResolvers<void>(); let closed = false;
  f.effects.stopEffect = () => stop.promise;
  await f.owner.run(async () => {});
  const closing = f.owner.close().then(() => { closed = true; });
  try {
    await flushOperations(); expect(closed).toBe(false); expect(f.effects.events).toEqual(["stop"]);
    stop.resolve(); await closing;
    expect(closed).toBe(true); expect(f.effects.events).toEqual(["stop", "dispose"]); expect(f.effects.timers.size).toBe(0);
  } finally { stop.resolve(); await closing; }
});

it("keeps observing a pending operation after stop rejects, then preserves the stop error", async () => {
  const f = fixtureOperationControl(), work = Promise.withResolvers<void>(), error = new Error("Stop unconfirmed"); let closed = false;
  f.effects.stopEffect = () => Promise.reject(error);
  const running = f.owner.run(() => work.promise), failed = rejectionOf(f.owner.close()).then(reason => { closed = true; return reason; });
  try {
    await flushOperations(); expect(closed).toBe(false); expect(f.effects.events).toEqual(["stop"]);
    work.resolve(); await running;
    expect((await failed as AggregateError).errors).toEqual([error]);
    expect(f.effects.events).toEqual(["stop"]); expect(f.effects.timers.size).toBe(0);
  } finally { work.resolve(); await Promise.allSettled([running, failed]); }
});

it("retains resources on deadline uncertainty and still observes a later rejection", async () => {
  const f = fixtureOperationControl(), work = Promise.withResolvers<void>(), error = new Error("Late direct driver failure");
  const returned = f.owner.run(() => work.promise), caller = rejectionOf(returned), failed = rejectionOf(f.owner.close());
  try {
    f.expire(); const closingError = await failed;
    expect(closingError).toBeInstanceOf(AggregateError);
    expect((closingError as Error).message).toContain("could not be confirmed");
    expect(f.effects.events).toEqual(["stop"]); expect(f.effects.timers.size).toBe(0); expect(f.effects.cancelled).toBe(1);
    work.reject(error); expect(await caller).toBe(error); await flushOperations();
    expect(f.effects.events).toEqual(["stop"]);
  } finally { work.reject(error); await Promise.allSettled([caller, failed]); }
});

it("propagates disposer failure without reporting completed cleanup", async () => {
  const f = fixtureOperationControl(), error = new Error("Private resources still exist");
  f.effects.disposeEffect = () => { throw error; };
  expect(await rejectionOf(f.owner.close())).toBe(error);
  expect(f.effects.events).toEqual(["stop", "dispose"]); expect(f.effects.timers.size).toBe(0);
});
