import { expect, it } from "vitest";
import { readinessReviewersFixture } from "../../fixtures/readiness-reviewers.js";

function waiting() {
  const f = readinessReviewersFixture();
  const choice = f.selection.selection.choose("grok-high", f.scope, "code-reviewer", () => true, "1");
  if (choice?.kind !== "none" || !choice.readiness) throw new Error("The supplied saved participant must need a recheck");
  return { ...f, need: choice.readiness };
}

it("records each return's first wait while competing seats share one owned check and deadline", async () => {
  const f = waiting(), probe = f.holdProbe("grok"), other = { ...f.need, saved: {} };
  const work = f.own(async () => {
    const first = f.readinessController.resolve(f.need), joined = f.readinessController.resolve(other);
    expect(f.readinessController.resolve(f.need)).toBe(first);
    expect(joined).toBe(first);
    expect(f.saved.readinessWait).toMatchObject({ at: f.clock.now(), toolId: "grok", previous: { status: "unknown" }, check: "started" });
    expect(other.saved).toMatchObject({ readinessWait: { check: "joined" } });
    expect(f.clock.pending.size).toBe(1);
    expect(f.notes).toHaveLength(2);
    expect(f.notes[0]).toContain("started one recheck"); expect(f.notes[1]).toContain("joined the check under way");
    await first;
  });
  try {
    await probe.entered(work); probe.answer(); await work;
    expect(f.probes).toHaveLength(1); expect(f.clock.pending.size).toBe(0);
    expect(f.check("grok").status).toBe("ready");
  } finally { probe.answer(); await f.close(); }
});

it("spends one bounded recheck without stopping its shared probe, and observes its eventual answer", async () => {
  const f = waiting(), probe = f.holdProbe("grok");
  let scheduled = 0; f.host.schedule = () => { scheduled++; };
  try {
    const first = f.own(() => f.readinessController.resolve(f.need));
    await probe.entered(first);
    const wait = structuredClone(f.saved.readinessWait!);
    f.clock.advance(10_999); expect(f.readinessController.open(f.need)).toBe(true);
    f.clock.advance(1); await first;
    expect(f.readinessController.open(f.need)).toBe(false); expect(scheduled).toBe(1);
    expect(f.checks.running("grok")).toBeDefined(); expect(f.clock.pending.size).toBe(0);
    const late = f.own(() => {
      const waiting = f.readinessController.resolve(f.need);
      expect(f.probes).toHaveLength(1); expect(f.saved.readinessWait).toEqual(wait);
      probe.answer("unknown"); return waiting;
    });
    await late;
    expect(scheduled).toBe(2);
    await f.own(() => f.readinessController.resolve(f.need));
    expect(f.probes).toHaveLength(1); expect(f.saved.readinessWait).toEqual(wait);
  } finally { probe.answer(); await f.close(); }
});

it("releases every readiness deadline at shutdown and joins the shared probe without scheduling again", async () => {
  const f = waiting(), probe = f.holdProbe("grok");
  let scheduled = 0; f.host.schedule = () => { scheduled++; };
  try {
    const work = f.own(() => f.readinessController.resolve(f.need));
    await probe.entered(work);
    f.stop.abort(); f.readinessController.stop(); await work;
    expect(scheduled).toBe(0); expect(f.clock.pending.size).toBe(0);
    await f.checks.shutdown();
    expect(f.checks.pending()).toEqual({ checking: [], stopping: [] });
    expect(f.probes).toHaveLength(1);
    await f.readinessController.resolve({ ...f.need, saved: {} });
    expect(f.probes).toHaveLength(1);
  } finally { await f.close(); }
});

it("ends only the cancelled admission's wait while an independent return still owns the shared answer", async () => {
  const f = waiting(), probe = f.holdProbe("grok"), cancelled = new AbortController();
  try {
    const first = f.own(() => f.readinessController.resolveHeld(f.need, cancelled.signal));
    await probe.entered(first);
    const shared = f.checks.running("grok")!;
    cancelled.abort(); expect(await first).toBe(true);
    expect(f.checks.running("grok")).toBe(shared); expect(f.check("grok").checking).toBe(true);
    const second = f.own(() => f.readinessController.resolve(f.need));
    probe.answer(); await second;
    expect(f.probes).toHaveLength(1); expect(f.clock.pending.size).toBe(0);
    expect(f.readinessController.yieldHeld(f.current)).toBe(false);
  } finally { probe.answer(); await f.close(); }
});
