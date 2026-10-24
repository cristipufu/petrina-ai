import { expect, it } from "vitest";
import { TOOL_CHECK_LINGER_MS } from "../../../src/index.js";
import { deferred, toolCheckFixture } from "../../fixtures/tool-checks.js";

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
  f.scripts.set("codex", request => { request.onGone(gone.promise); return { status: "unknown" }; });
  await f.coordinator.check("codex");
  gone.reject(new Error("The process list was unavailable"));
  await f.coordinator.check("codex");
  expect(f.result("codex")).toMatchObject({ status: "unknown", detail: "The process list was unavailable" });
  expect(f.calls).toHaveLength(1); expect(f.clock.pending.size).toBe(0);
  await f.coordinator.shutdown();
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
