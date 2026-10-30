import { expect, it } from "vitest";
import { observedCheck } from "../../fixtures/check-repairs.js";
import { validationRunFixture } from "../../fixtures/validation-run.js";

for (const phase of ["inspection", "copy", "log"] as const) it(`rechecks admission after ${phase} and cleans preparation before requesting requeue`, async () => {
  const f = validationRunFixture({ holdAt: phase });
  try {
    const work = f.run(); await f.entered;
    f.closeAdmission(); f.release(); await work;
    expect(f.decisions.map(value => value.kind)).toEqual(["requeue"]);
    expect(f.record.resumeQueued).toBe(true);
    expect(f.record.startedAt).toBeUndefined(); expect(f.record.clientPid).toBeUndefined(); expect(f.record.run).toBeUndefined(); expect(f.record.result).toBeUndefined();
    expect([f.record.commit, f.record.tree, f.record.queueOrder, f.record.queuedAt]).toEqual([f.original.commit, f.original.tree, f.original.queueOrder, f.original.queuedAt]);
    expect(f.notes).toEqual([]);
    expect(f.calls.filter(call => ["inspection", "copy", "log", "command"].includes(call))).toEqual(phase === "inspection" ? ["inspection"] : phase === "copy" ? ["inspection", "copy"] : ["inspection", "copy", "log"]);
    expect(f.calls.at(-1)).toBe("cleanup");
  } finally { await f.close(); }
});

for (const phase of ["inspection", "copy", "log"] as const) for (const reason of ["task", "shutdown"] as const) it(`preserves the first ${reason} stop during ${phase}`, async () => {
  const f = validationRunFixture({ holdAt: phase });
  try {
    const work = f.run(); await f.entered;
    f.stop.abort(reason); f.stop.abort(reason === "task" ? "shutdown" : "task"); f.release(); await work;
    expect(f.decisions.map(value => value.kind)).toEqual([reason === "shutdown" ? "requeue" : "finish"]);
    expect(f.record.resumeQueued).toBe(reason === "shutdown" ? true : undefined);
    expect(f.record.result).toBe(reason === "shutdown" ? undefined : "stopped");
    expect(f.record.startedAt).toBeUndefined(); expect(f.record.clientPid).toBeUndefined(); expect(f.record.run).toBeUndefined();
    expect(f.notes).toEqual([]); expect(f.calls).not.toContain("command");
    expect(f.calls.at(-1)).toBe("cleanup");
  } finally { await f.close(); }
});

for (const phase of ["admission", "start evidence", "log registration"] as const) for (const count of [0, 1, 2]) it(`keeps truthful ${phase} results with ${count} refused saves`, async () => {
  const f = validationRunFixture({ fail: { phase, count }, cleanup: false });
  try {
    await f.run();
    expect(f.remaining()).toBe(0);
    expect(f.decisions.map(value => value.kind)).toEqual(["hold"]);
    expect(f.record.result).toBe(count ? "not run" : "passed");
    expect([f.record.commit, f.record.tree, f.record.queueOrder, f.record.queuedAt]).toEqual([f.original.commit, f.original.tree, f.original.queueOrder, f.original.queuedAt]);
    if (count) {
      expect(f.record.detail).toBe(f.failure.message);
      expect(f.record.startedAt).toBeUndefined(); expect(f.record.clientPid).toBeUndefined(); expect(f.record.run).toBeUndefined(); expect(f.record.stoppingAt).toBeUndefined();
      expect(f.record.durationMs).toBe(0); expect(f.notes).toEqual([]); expect(f.calls).not.toContain("command");
      expect(f.calls.includes("inspection")).toBe(phase !== "admission");
      expect(f.calls.filter(call => call === "cleanup")).toHaveLength(count === 1 ? 1 : 0);
      if (count === 2) expect(f.decisions[0]!.detail).toBe(String(f.failure));
    } else {
      expect(f.record.startedAt).toBe(300); expect(f.record.waitingMs).toBe(200); expect(f.record.durationMs).toBe(20);
      expect(f.notes).toEqual(["started", "stopping"]); expect(f.record.run!.ok).toBe(true);
      expect(f.calls.indexOf("log closed")).toBeLessThan(f.calls.indexOf("cleanup"));
    }
  } finally { await f.close(); }
});

for (const [name, result, expected] of [
  ["passed", observedCheck(0), "passed"], ["failed", observedCheck(7), "failed"],
  ["legacy report", { name: "Legacy", command: "old", ok: true, ms: 0, output: "Earlier reported success" }, "did not finish"],
  ["unavailable", null, "not run"],
] as const) it(`derives ${name} outcome only from the command adapter's supplied observations`, async () => {
  const f = validationRunFixture({ result });
  try {
    await f.run();
    expect(f.decisions.map(value => value.kind)).toEqual(["finish"]);
    expect(f.record.result).toBe(expected);
    expect(f.calls.indexOf("log closed")).toBeLessThan(f.calls.indexOf("cleanup"));
    if (name === "legacy report") expect(f.record.run!.execution).toBeUndefined();
  } finally { await f.close(); }
});

it("waits for the command adapter to settle after cancellation before cleanup or release", async () => {
  const f = validationRunFixture({ holdAt: "command" });
  try {
    const work = f.run(); await f.entered;
    f.stop.abort("task");
    expect(f.decisions).toEqual([]); expect(f.calls).not.toContain("cleanup");
    f.release(); await work;
    expect(f.record.result).toBe("stopped"); expect(f.decisions.map(value => value.kind)).toEqual(["finish"]);
    expect(f.calls.indexOf("log closed")).toBeLessThan(f.calls.indexOf("cleanup"));
  } finally { await f.close(); }
});

it("retains deferred preparation when cleanup cannot confirm removal", async () => {
  const f = validationRunFixture({ holdAt: "copy", cleanup: false });
  try {
    const work = f.run(); await f.entered; f.closeAdmission(); f.release(); await work;
    expect(f.decisions.map(value => value.kind)).toEqual(["hold"]); expect(f.record.resumeQueued).toBe(true);
    expect(f.record.result).toBeUndefined(); expect(f.record.run).toBeUndefined();
    expect(f.decisions[0]!.detail).toContain("prepared copy's cleanup");
  } finally { await f.close(); }
});
