import { expect, it } from "vitest";
import { completeAll } from "../../../src/parallel.js";

it("lets a slow repository operation finish before an independent failure reaches recovery", async () => {
  let resolve!: () => void;
  const release = { promise: new Promise<void>(done => { resolve = done; }), resolve: () => resolve() };
  const failure = new Error("The first repository failed");
  const events: string[] = [];
  const pending = completeAll([
    Promise.reject(failure),
    release.promise.then(() => { events.push("other repository finished"); }),
  ]).catch(error => { events.push("recovery started"); return error; });
  // Drain already queued microtasks without a timing-based sleep.
  for (let i = 0; i < 8; i++) await Promise.resolve();
  expect(events).toEqual([]);
  release.resolve();
  expect(await pending).toBe(failure);
  expect(events).toEqual(["other repository finished", "recovery started"]);
});
