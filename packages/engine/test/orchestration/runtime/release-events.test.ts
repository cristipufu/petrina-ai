import { expect, it } from "bun:test";
import { ReleaseEvents } from "../../release-events.js";
import { expectRejection } from "@petrina/test-support/rejections";

it("releases current and future waits once without releasing another key", async () => {
  const events = new ReleaseEvents(), signal = new AbortController().signal;
  let otherReleased = false;
  const first = events.wait("first", signal), peer = events.wait("first", signal);
  const other = events.wait("other", signal).then(() => { otherReleased = true; });
  events.release("first");
  await Promise.all([first, peer]);
  expect(otherReleased).toBe(false);
  await events.wait("first", signal); events.release("first");
  expect(otherReleased).toBe(false);
  events.release("other"); await other;
  expect(otherReleased).toBe(true);
});

it("cancels only its own waiter, preserving another participant waiting for the same release", async () => {
  const events = new ReleaseEvents(), first = new AbortController(), peer = new AbortController();
  const cancelled = expectRejection(events.wait("shared", first.signal), "The scripted release was cancelled");
  let peerReleased = false;
  const waiting = events.wait("shared", peer.signal).then(() => { peerReleased = true; });
  first.abort(); await cancelled;
  expect(peerReleased).toBe(false);
  events.release("shared"); await waiting;
  expect(peerReleased).toBe(true);
  peer.abort(); await events.wait("shared", new AbortController().signal);
});

it("rejects an already-cancelled wait even when the event was released", async () => {
  const events = new ReleaseEvents(), stopped = new AbortController();
  stopped.abort(); events.release("done");
  await expectRejection(events.wait("done", stopped.signal), "The scripted release was cancelled");
  await expectRejection(events.wait("waiting", stopped.signal), "The scripted release was cancelled");
  await events.wait("done", new AbortController().signal);
});
