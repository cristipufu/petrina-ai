import { acquireCheckPlace } from "../../../src/check-admission.js";
import { describe as originalDescribe } from "vitest";
import { expect, it } from "vitest";
import { checkAdmission, Aborted, WaitingForUsage } from "../../fixtures/check-admission.js";

originalDescribe("tasks' checks take turns on one machine", () => {
for (const checkRuns of [1, 2]) it(`hands a released place to the waiting task before a new arrival (limit ${checkRuns})`, async () => {
    const admission = checkAdmission(checkRuns);
    const held: (() => void)[] = [];
    try {
      const acquire = () => admission.acquire();
      for (let i = 0; i < checkRuns; i++) held.push(await acquire());
      const started: string[] = [];
      const queued = acquire().then((release) => { started.push("waiting task"); held.push(release); return release; });
      held[0]!();
      // Arrive in the same turn, before the waiting task's promise resumes.
      const newcomer = acquire().then((release) => { started.push("new arrival"); held.push(release); return release; });
      const releaseWaiting = await queued;
      expect(started).toEqual(["waiting task"]);
      // A repeated completion must not hand out a second place.
      held[0]!();
      await Promise.resolve();
      expect(started).toEqual(["waiting task"]);
      releaseWaiting();
      await newcomer;
      expect(started).toEqual(["waiting task", "new arrival"]);
    } finally {
      for (const release of held) release();

    }
  });
});

originalDescribe("tasks' checks take turns on one machine", () => {
it("skips a cancelled waiter and rejects an already cancelled run without taking a place", async () => {
    const admission = checkAdmission(1);
    const held: (() => void)[] = [];
    try {
      const acquire = (signal = new AbortController().signal) => admission.acquire(signal);
      const cancelled = new AbortController();
      cancelled.abort();
      expect(await acquire(cancelled.signal).then(() => "started", (error) => error)).toBeInstanceOf(Aborted);
      const releaseFirst = await acquire();
      held.push(releaseFirst);
      // Already aborted requests must also reject while the queue is occupied.
      expect(await acquire(cancelled.signal).then(() => "started", (error) => error)).toBeInstanceOf(Aborted);
      const controller = new AbortController();
      const waiting = acquire(controller.signal).then(() => "started", (error) => error);
      const next = acquire().then((release) => { held.push(release); return release; });
      controller.abort();
      expect(await waiting).toBeInstanceOf(Aborted);
      releaseFirst();
      const releaseNext = await next;
      releaseNext();
      const releaseBusy = await acquire();
      held.push(releaseBusy);
      const late = new AbortController();
      const handedOff = acquire(late.signal).then(() => "started", (error) => error);
      const follower = acquire().then((release) => { held.push(release); return release; });
      releaseBusy();
      // Abort after the place was reserved, before the waiting continuation runs.
      late.abort();
      expect(await handedOff).toBeInstanceOf(Aborted);
      const releaseFollower = await follower;
      releaseFollower();
      // Cancellation and repeated releases leave the queue usable.
      held.push(await acquire());
    } finally {
      for (const release of held) release();

    }
  });
});

originalDescribe("tasks' checks take turns on one machine", () => {
for (const draining of [false, true]) it(`${draining ? "releases" : "requeues"} a reserved check place when ${draining ? "draining" : "paused"} during its handoff`, async () => {
    const admission = checkAdmission(1);
    const held: (() => void)[] = [];
    try {
      const acquire = () => admission.acquire();
      const release = await acquire();
      held.push(release);
      const starts: string[] = [];
      const waiting = acquire().then(place => { starts.push("waiting"); held.push(place); return place; }, error => error);
      const follower = acquire().then(place => { starts.push("follower"); held.push(place); return place; }, error => error);
      release();
      // The queue has reserved the released place, but the next check has not been admitted.
      if (draining) { admission.state.draining = true; admission.queue.pump(); }
      else admission.pause(true);
      if (draining) {
        expect(await waiting).toBeInstanceOf(WaitingForUsage);
        expect(await follower).toBeInstanceOf(WaitingForUsage);
      } else {
        await Promise.resolve();
        expect(starts).toEqual([]);
        expect(admission.queue.running).toBe(0);
        expect(admission.queue.waiting).toBe(2);
        admission.pause(false);
        const first = await waiting;
        expect(starts).toEqual(["waiting"]);
        expect(first.waited).toBe(true);
        first();
        const next = await follower;
        expect(starts).toEqual(["waiting", "follower"]);
        next();
      }
      release();
      admission.state.draining = false;
      admission.pause(false);
      held.push(await acquire());
      expect(admission.queue.running).toBe(1);
      held.at(-1)!();
      expect(admission.queue.running).toBe(0);
    } finally {
      for (const release of held) release();

    }
  });
});


it("keeps method-backed wait notices on their effect owner through admission", async () => {
  class Effects {
    paused = true;
    events: string[] = [];
    subscriptions = 0;
    admissions = 0;
    stopped() { return false; }
    prerequisite() { return false; }
    closed() { return this.paused; }
    draining() { return false; }
    reason() { return "Waiting for the pool to resume"; }
    subscribe(_changed: () => void) { this.subscriptions++; return () => { this.subscriptions--; }; }
    onWait(words?: string) { this.events.push(words ?? "waiting"); }
    admitted() { this.admissions++; }
  }
  const fixture = checkAdmission();
  fixture.pause(true);
  const effects = new Effects(), controller = new AbortController();
  const work = acquireCheckPlace(fixture.queue, controller.signal, fixture.queue.reserveOrder(), effects)
    .then(place => ({ place }), error => ({ error }));
  try {
    expect(effects.events).toEqual(["Waiting for the pool to resume"]);
    effects.paused = false;
    fixture.pause(false);
    const result = await work;
    expect(result).not.toHaveProperty("error");
    expect(effects.admissions).toBe(1);
    expect(effects.subscriptions).toBe(0);
  } finally {
    controller.abort();
    const settled = await work;
    if ("place" in settled) settled.place();
    fixture.pause(false);
  }
  expect(fixture.queue.running).toBe(0);
  expect(fixture.queue.waiting).toBe(0);
});
