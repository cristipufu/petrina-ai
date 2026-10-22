import { describe, expect, it } from "vitest";
import { READINESS_FRESH_MS, readinessGate, readinessOutcome, uncertain, type ReadinessWait } from "../src/readiness.js";
import type { ToolCheck } from "../src/setup.js";

const now = 1_800_000_000_000;
const limit = 33_000;
const grok = (check: Partial<ToolCheck>): ToolCheck => ({ id: "grok", status: "unknown", ...check });
const waited = (at: number): ReadinessWait => ({ at, toolId: "grok", previous: { status: "unknown", at: at - 3_600_000 }, check: "started" });

describe("a saved participant's readiness decision", () => {
  it("treats only Couldn't check and no answer as uncertain", () => {
    expect(["unknown", "unchecked", undefined].map((status) => uncertain(status as ToolCheck["status"] | undefined))).toEqual([true, true, true]);
    expect((["ready", "logged-out", "not-installed"] as const).map(uncertain)).toEqual([false, false, false]);
  });

  it("keeps real login and install answers, whether or not a recheck was recorded", () => {
    for (const wait of [undefined, waited(now - 1_000)]) {
      expect(readinessGate(grok({ status: "logged-out", at: now }), wait, now, limit, true)).toEqual({ kind: "fresh", reason: "its saved tool is logged out" });
      expect(readinessGate(grok({ status: "not-installed", at: now }), wait, now, limit, true)).toEqual({ kind: "fresh", reason: "its saved tool is not installed" });
    }
    // An ordinary check already under way may still replace that answer, so it is joined, never repeated.
    expect(readinessGate(grok({ status: "logged-out", at: now - 1, checking: true }), undefined, now, limit, true)).toEqual({ kind: "wait", record: true });
  });

  it("rechecks once when the uncertain answer is five minutes old, has no time or never came", () => {
    const record = { kind: "wait", record: true };
    expect(readinessGate(grok({ at: now - READINESS_FRESH_MS }), undefined, now, limit, false)).toEqual(record);
    expect(readinessGate(grok({ at: now - 2 * READINESS_FRESH_MS }), undefined, now, limit, false)).toEqual(record);
    expect(readinessGate(grok({ at: undefined }), undefined, now, limit, false)).toEqual(record);
    expect(readinessGate(grok({ status: "unchecked" }), undefined, now, limit, false)).toEqual(record);
    expect(readinessGate(undefined, undefined, now, limit, false)).toEqual(record);
    // A check already under way is joined, however recent the last answer.
    expect(readinessGate(grok({ at: now - 1, checking: true }), undefined, now, limit, false)).toEqual(record);
  });

  it("follows the usual selection, without a probe, while an uncertain answer is recent", () => {
    expect(readinessGate(grok({ at: now - READINESS_FRESH_MS + 1 }), undefined, now, limit, true)).toEqual({ kind: "fresh", reason: "its saved tool's recent readiness check was inconclusive" });
  });

  it("waits within the recorded limit, then decides from the latest answer without another probe", () => {
    const wait = waited(now - 1_000);
    expect(readinessGate(grok({ checking: true, at: wait.previous.at }), wait, now, limit, false)).toEqual({ kind: "wait", record: false });
    // Not running and no answer yet (a check that could not start, or a restart): still only the remaining limit.
    expect(readinessGate(grok({ at: wait.previous.at }), wait, now, limit, false)).toEqual({ kind: "wait", record: false });
    expect(readinessGate(grok({ at: wait.at }), wait, now, limit, false)).toEqual({ kind: "fresh", reason: "its saved tool's readiness recheck was inconclusive" });
    expect(readinessGate(grok({ status: "unchecked", at: now }), wait, now, limit, true)).toEqual({ kind: "fresh", reason: "its saved tool's readiness recheck was inconclusive" });
    // A recent answer after the limit, or an old one, never starts a second automatic recheck.
    const expired = waited(now - limit);
    expect(readinessGate(grok({ at: expired.previous.at }), expired, now, limit, true)).toEqual({ kind: "fresh", reason: "its saved tool did not answer its readiness recheck in time" });
    expect(readinessGate(grok({ at: expired.previous.at }), expired, now + 2 * READINESS_FRESH_MS, limit, true)).toEqual({ kind: "fresh", reason: "its saved tool did not answer its readiness recheck in time" });
  });

  it("lets a running ordinary check settle past the limit only where that protection already applies", () => {
    const expired = waited(now - limit - 1);
    expect(readinessGate(grok({ checking: true }), expired, now, limit, true)).toEqual({ kind: "wait", record: false });
    expect(readinessGate(grok({ checking: true }), expired, now, limit, false)).toEqual({ kind: "fresh", reason: "its saved tool did not answer its readiness recheck in time" });
  });

  it("reports what the recheck found once it answered or its limit passed", () => {
    const wait = waited(now - 1_000);
    expect(readinessOutcome(grok({ checking: true }), wait, now, limit)).toBeUndefined();
    expect(readinessOutcome(grok({ status: "ready", at: now }), wait, now, limit)).toEqual({ ...wait, outcome: "ready" });
    expect(readinessOutcome(grok({ status: "logged-out", at: now }), wait, now, limit)).toEqual({ ...wait, outcome: "logged-out" });
    expect(readinessOutcome(grok({ at: wait.previous.at }), wait, now + limit, limit)).toEqual({ ...wait, outcome: "no answer" });
    expect(readinessOutcome(grok({ checking: true }), wait, now + limit, limit)).toEqual({ ...wait, outcome: "no answer" });
  });
});
