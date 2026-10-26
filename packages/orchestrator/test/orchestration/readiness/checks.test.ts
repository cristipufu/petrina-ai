import { expect, it } from "vitest";
import { TOOL_CHECK_LINGER_MS } from "../../../src/index.js";
import { deferred, toolCheckFixture } from "../../fixtures/tool-checks.js";

const outcome = (work: Promise<unknown>) => work.then(() => ({ kind: "value" as const }), error => ({ kind: "error" as const, error }));

it.each(["ready", "logged-out", "unknown"] as const)("publishes the actual %s observation without guessing from previous readiness", async status => {
  const f = toolCheckFixture();
  f.checks.set("gh", { id: "gh", status: "ready", account: "old-account", detail: "old-detail", at: 1 });
  f.scripts.set("gh", () => ({ status, ...(status === "ready" ? { account: "current-account" } : { detail: "Current observation" }) }));
  const job = f.coordinator.check("gh");
  expect(f.coordinator.running("gh")).toBe(job);
  expect(f.published[0]).toEqual({ id: "gh", status: "ready", account: "old-account", detail: "old-detail", at: 1, checking: true });
  await job;
  expect(f.result("gh")).toEqual({ id: "gh", status, at: 100, ...(status === "ready" ? { account: "current-account" } : { detail: "Current observation" }) });
  expect(f.coordinator.running("gh")).toBeUndefined();
  expect(f.calls.map(call => call.id)).toEqual(["gh"]);
});

it("reports absence immediately without publishing Checking or running a probe", async () => {
  const f = toolCheckFixture(); f.missing.add("grok");
  const job = f.coordinator.check("grok");
  expect(f.result("grok")).toEqual({ id: "grok", status: "not-installed", at: 100 });
  await job;
  expect(f.published).toHaveLength(1); expect(f.calls).toEqual([]);
});

it("joins concurrent and synchronous subscriber requests before starting another copy", async () => {
  const f = toolCheckFixture(), release = deferred<{ status: "ready" }>();
  const joined: Promise<void>[] = [];
  f.scripts.set("codex", () => release.promise);
  f.events.publish = check => { if (check.checking) joined.push(f.coordinator.check("codex")); };
  const first = f.coordinator.check("codex");
  expect(joined).toEqual([first]);
  expect(f.coordinator.check("codex")).toBe(first);
  expect(f.calls).toHaveLength(1);
  release.resolve({ status: "ready" }); await first;
  expect(f.published.map(check => Boolean(check.checking))).toEqual([true, false]);
});

it("checks independent tools without waiting for a slow peer", async () => {
  const f = toolCheckFixture(), slow = deferred<{ status: "unknown" }>();
  f.scripts.set("codex", () => slow.promise); f.scripts.set("grok", () => ({ status: "ready" }));
  const pending = f.coordinator.check("codex");
  await f.coordinator.check("grok");
  expect(f.result("grok")?.status).toBe("ready");
  expect(f.coordinator.running("codex")).toBe(pending);
  slow.resolve({ status: "unknown" }); await pending;
});

it.each([true, false])("joins requests during cleanup and recovers after confirmation (before deadline: %s)", async early => {
  const f = toolCheckFixture(), gone = deferred<void>();
  f.scripts.set("codex", request => { request.onGone(gone.promise); return { status: "unknown", detail: "Startup failed" }; });
  await f.coordinator.check("codex");
  f.scripts.set("codex", () => ({ status: "ready" }));
  const pending = f.coordinator.check("codex");
  expect(f.coordinator.check("codex")).toBe(pending);
  expect(f.calls).toHaveLength(1); expect(f.clock.pending.size).toBe(1);
  if (early) gone.resolve();
  else f.clock.advance(TOOL_CHECK_LINGER_MS);
  await pending;
  if (!early) {
    expect(f.calls).toHaveLength(1);
    expect(f.result("codex")?.status).toBe("unknown");
    expect(f.result("codex")?.detail).toContain("still stopping after its last check");
    gone.resolve(); await gone.promise;
    await f.coordinator.check("codex");
  }
  expect(f.calls).toHaveLength(2); expect(f.result("codex")?.status).toBe("ready");
  expect(f.clock.pending.size).toBe(0);
});

it("keeps every registered owner until all cleanup is confirmed", async () => {
  const f = toolCheckFixture(), first = deferred<void>(), second = deferred<void>();
  f.scripts.set("codex", request => { request.onGone(first.promise); request.onGone(second.promise); return { status: "unknown" }; });
  await f.coordinator.check("codex");
  first.resolve(); await first.promise;
  const pending = f.coordinator.check("codex");
  f.clock.advance(TOOL_CHECK_LINGER_MS); await pending;
  expect(f.calls).toHaveLength(1);
  expect(f.result("codex")?.detail).toContain("still stopping");
  second.resolve(); await second.promise;
  f.scripts.set("codex", () => ({ status: "ready" }));
  await f.coordinator.check("codex");
  expect(f.calls).toHaveLength(2);
});

it("treats rejected cleanup inspection as unknown and never as permission to start another process", async () => {
  const f = toolCheckFixture(), gone = deferred<void>();
  const failure = new Error("The process list was unavailable");
  f.scripts.set("codex", request => { request.onGone(gone.promise); return { status: "unknown" }; });
  await f.coordinator.check("codex");
  gone.reject(failure);
  await f.coordinator.check("codex");
  expect(f.result("codex")).toMatchObject({ status: "unknown", detail: "The process list was unavailable" });
  expect(f.calls).toHaveLength(1); expect(f.clock.pending.size).toBe(0);
  const stopped = await outcome(f.coordinator.shutdown());
  expect(stopped.kind).toBe("error");
  if (stopped.kind !== "error") throw new Error("Failed native cleanup became a successful shutdown");
  expect(stopped.error).toBe(failure);
});

for (const failure of [new Error("Native cleanup failed"), undefined]) it(`retains the exact single cleanup rejection ${failure === undefined ? "undefined" : "Error"} after refusing another probe`, async () => {
  const f = toolCheckFixture(), gone = deferred<void>();
  f.scripts.set("codex", request => { request.onGone(gone.promise); return { status: "unknown" }; });
  try {
    await f.coordinator.check("codex");
    gone.reject(failure);
    await f.coordinator.check("codex");
    expect(f.calls).toHaveLength(1);
    expect(f.result("codex")?.status).toBe("unknown");
    expect(f.coordinator.pending().stopping).toEqual(["codex"]);
    const stopped = await outcome(f.coordinator.shutdown());
    expect(stopped.kind).toBe("error");
    if (stopped.kind !== "error") throw new Error("Unconfirmed cleanup became success");
    expect(stopped.error).toBe(failure);
    expect(f.coordinator.pending().stopping).toEqual(["codex"]);
    expect(f.clock.pending.size).toBe(0);
  } finally { gone.resolve(); await outcome(f.coordinator.shutdown()); }
});

for (const failure of [new Error("First cleanup failed"), undefined]) for (const peerFails of [false, true]) it(`joins a late registered cleanup ${peerFails ? "rejection" : "confirmation"} before reporting ${failure === undefined ? "undefined" : "Error"}`, async () => {
  const f = toolCheckFixture(), first = deferred<void>(), peer = deferred<void>(), handoff = deferred<void>();
  let peerCompleted = false, peerJob: Promise<void> | undefined, stopping: Promise<unknown> | undefined;
  const peerCleanup = peer.promise.then(() => { peerCompleted = true; });
  f.scripts.set("codex", request => { request.onGone(first.promise); return { status: "unknown" }; });
  f.scripts.set("grok", async request => { await handoff.promise; request.onGone(peerCleanup); return { status: "ready" }; });
  try {
    await f.coordinator.check("codex");
    peerJob = f.coordinator.check("grok");
    stopping = f.coordinator.shutdown();
    const reported = outcome(stopping).then(result => ({ result, peerCompleted }));
    first.reject(failure);
    handoff.resolve(); await peerJob;
    expect(f.coordinator.pending().checking).toEqual([]);
    expect(f.coordinator.pending().stopping).toEqual(["codex", "grok"]);
    if (peerFails) peer.reject(undefined); else peer.resolve();
    const stopped = await reported;
    expect(stopped.result.kind).toBe("error");
    if (stopped.result.kind !== "error") throw new Error("Native cleanup failure was discarded");
    if (peerFails) {
      expect(stopped.result.error).toBeInstanceOf(AggregateError);
      const errors: unknown[] = (stopped.result.error as AggregateError).errors;
      expect(errors).toHaveLength(2); expect(errors[0]).toBe(failure); expect(errors[1]).toBeUndefined();
      expect(f.coordinator.pending().stopping).toEqual(["codex", "grok"]);
    } else {
      expect(stopped.result.error).toBe(failure);
      expect(stopped.peerCompleted).toBe(true);
      expect(f.coordinator.pending().stopping).toEqual(["codex"]);
    }
    expect(f.calls.map(call => call.id)).toEqual(["codex", "grok"]);
    expect(f.calls.every(call => call.request.signal.aborted)).toBe(true);
  } finally { handoff.resolve(); first.resolve(); peer.resolve(); await Promise.allSettled([peerJob, stopping]); await outcome(f.coordinator.shutdown()); }
});

for (const failure of [new Error("Probe request failed"), undefined]) it(`does not turn an ordinary probe ${failure === undefined ? "undefined" : "Error"} into cleanup failure`, async () => {
  const f = toolCheckFixture(), request = deferred<void>();
  f.scripts.set("codex", async () => { await request.promise; throw failure; });
  const checking = f.coordinator.check("codex"), stopping = f.coordinator.shutdown();
  try {
    request.resolve(); await checking; await stopping;
    expect(f.result("codex")?.status).toBe("unknown");
    expect(f.result("codex")?.detail).toBe(failure instanceof Error ? failure.message : String(failure));
    expect(f.coordinator.pending()).toEqual({ checking: [], stopping: [] });
  } finally { request.resolve(); await Promise.allSettled([checking, stopping]); }
});

it("keeps the selected request drain while observing cleanup registered by an unselected probe", async () => {
  const f = toolCheckFixture(), request = deferred<void>(), gone = deferred<void>();
  let peerCompleted = false;
  const cleanup = gone.promise.then(() => { peerCompleted = true; });
  f.scripts.set("codex", () => ({ status: "ready" }));
  f.scripts.set("grok", async options => { options.onGone(cleanup); await request.promise; return { status: "unknown" }; });
  await f.coordinator.check("codex");
  const unselected = f.coordinator.check("grok"), stopping = f.coordinator.shutdown(["codex"]);
  const reported = stopping.then(() => ({ peerCompleted }));
  try {
    gone.resolve();
    expect(await reported).toEqual({ peerCompleted: true });
    expect(f.coordinator.running("grok")).toBe(unselected);
    request.resolve(); await unselected;
    expect(f.coordinator.pending()).toEqual({ checking: [], stopping: [] });
  } finally { request.resolve(); gone.resolve(); await Promise.allSettled([unselected, stopping]); }
});

it("aborts a waiting recheck and retains ownership until cleanup, without starting the next probe", async () => {
  const f = toolCheckFixture(), gone = deferred<void>();
  f.scripts.set("codex", request => { request.onGone(gone.promise); return { status: "unknown" }; });
  await f.coordinator.check("codex");
  const pending = f.coordinator.check("codex");
  let finished = false;
  const stopping = f.coordinator.shutdown().then(() => { finished = true; });
  await pending;
  expect(f.calls).toHaveLength(1); expect(f.calls[0]!.request.signal.aborted).toBe(true);
  expect(f.clock.pending.size).toBe(0); expect(finished).toBe(false);
  gone.resolve(); await stopping;
  expect(finished).toBe(true);
  await f.coordinator.check("grok"); expect(f.calls).toHaveLength(1);
});

it("stops before admission if its host shuts down while publishing Checking", async () => {
  const f = toolCheckFixture();
  f.events.publish = check => { if (check.checking) f.stopHost(); };
  await f.coordinator.check("codex");
  expect(f.calls).toEqual([]);
  expect(f.result("codex")?.status).toBe("unknown");
  expect(f.result("codex")?.detail).toContain("stopped before");
  await f.coordinator.check("grok"); expect(f.calls).toEqual([]);
});

it("preserves probe failures as inconclusive observations and releases a failed publication's join", async () => {
  const f = toolCheckFixture();
  f.scripts.set("codex", () => { throw new Error("Controlled probe failure"); });
  await f.coordinator.check("codex");
  expect(f.result("codex")).toMatchObject({ status: "unknown", detail: "Controlled probe failure" });
  f.events.publish = () => { throw new Error("Controlled checkpoint failure"); };
  let failure: unknown;
  try { await f.coordinator.check("codex"); } catch (error) { failure = error; }
  expect(failure).toBeInstanceOf(Error);
  expect((failure as Error).message).toBe("Controlled checkpoint failure");
  expect(f.coordinator.running("codex")).toBeUndefined();
  f.events.publish = () => {};
  await f.coordinator.check("codex");
  expect(f.calls).toHaveLength(2);
});
