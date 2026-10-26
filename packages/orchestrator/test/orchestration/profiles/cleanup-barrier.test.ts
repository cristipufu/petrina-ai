import { expect, it, vi } from "vitest";
import { demoProfileChoices } from "@petrina/core";
import { ProfileChoiceController, type ProfileChoiceEffects } from "../../../src/profile-choices.js";
import { ControlledClock, waitDuring } from "../../fixtures/clock.js";
import { deferred } from "../../fixtures/tool-checks.js";

const outcome = (work: Promise<unknown>) => work.then(() => ({ kind: "value" as const }), error => ({ kind: "error" as const, error }));

function profileFixture() {
  const clock = new ControlledClock(), scripts = new Map<string, ProfileChoiceEffects["probe"]>();
  const calls: { tool: string; signal: AbortSignal }[] = [];
  const effects: ProfileChoiceEffects = {
    now: clock.now, stopped: () => false,
    arm: (expired, ms) => clock.after(ms, () => { expired(); return undefined; }),
    probe(tool, model, signal, onGone) {
      expect(this).toBe(effects); calls.push({ tool, signal });
      const script = scripts.get(tool);
      if (!script) throw new Error(`Unexpected configuration probe: ${tool}`);
      return script(tool, model, signal, onGone);
    },
  };
  return { reader: new ProfileChoiceController(effects), scripts, calls, clock };
}

it("waits for a failed startup's process cleanup before opening another configuration probe", async () => {
  let release!: () => void, queued!: () => void;
  const gone = { promise: new Promise<void>(resolve => { release = resolve; }), resolve: () => release() };
  const waiting = { promise: new Promise<void>(resolve => { queued = resolve; }), resolve: () => queued() };
  const start = vi.fn<ConstructorParameters<typeof ProfileChoiceController>[0]["probe"]>()
    .mockImplementationOnce(async (_tool, _model, _signal, onGone) => { onGone(gone.promise); throw new Error("Could not open"); })
    .mockImplementationOnce(async (_tool, _model, _signal, onGone) => { onGone(Promise.resolve()); return demoProfileChoices("codex"); });
  const reader = new ProfileChoiceController({ now: () => 1, stopped: () => false, probe: start,
    arm: (_expired, milliseconds) => { if (milliseconds !== 3_000) throw new Error("Unexpected deadline"); waiting.resolve(); return () => {}; },
  });
  try {
    await expect(reader.read("codex")).rejects.toThrow("Could not open");
    const next = reader.read("codex");
    await waiting.promise;
    expect(start).toHaveBeenCalledTimes(1);
    gone.resolve();
    expect((await next).toolId).toBe("codex");
    expect(start).toHaveBeenCalledTimes(2);
  } finally { gone.resolve(); await reader.stop(); }
});

for (const failure of [new Error("Configuration cleanup failed"), undefined]) it(`keeps ${failure === undefined ? "undefined" : "Error"} cleanup failure blocking replacement and shutdown`, async () => {
  const f = profileFixture(), gone = deferred<void>();
  f.scripts.set("codex", async (_tool, _model, _signal, onGone) => { onGone(gone.promise); return demoProfileChoices("codex"); });
  try {
    expect((await f.reader.read("codex")).toolId).toBe("codex");
    gone.reject(failure);
    const replacement = await outcome(f.reader.read("codex", undefined, true));
    expect(replacement.kind).toBe("error");
    if (replacement.kind !== "error") throw new Error("An unconfirmed probe admitted a replacement");
    expect(replacement.error).toBe(failure);
    expect(f.calls).toHaveLength(1);
    expect(f.reader.activity().stopping).toEqual(["codex"]);
    const stopped = await outcome(f.reader.stop());
    expect(stopped.kind).toBe("error");
    if (stopped.kind !== "error") throw new Error("Configuration cleanup failure became success");
    expect(stopped.error).toBe(failure);
    expect(f.reader.activity().stopping).toEqual(["codex"]);
    expect(f.clock.pending.size).toBe(0);
  } finally { gone.resolve(); await outcome(f.reader.stop()); }
});

for (const failure of [new Error("First configuration cleanup failed"), undefined]) for (const peerFails of [false, true]) it(`joins the late configuration cleanup ${peerFails ? "rejection" : "confirmation"} before reporting ${failure === undefined ? "undefined" : "Error"}`, async () => {
  const f = profileFixture(), first = deferred<void>(), peer = deferred<void>(), handoff = deferred<void>();
  let peerCompleted = false, peerRead: Promise<unknown> | undefined, stopping: Promise<void> | undefined;
  const peerCleanup = peer.promise.then(() => { peerCompleted = true; });
  f.scripts.set("codex", async (_tool, _model, _signal, onGone) => { onGone(first.promise); return demoProfileChoices("codex"); });
  f.scripts.set("grok", async (_tool, _model, _signal, onGone) => { await handoff.promise; onGone(peerCleanup); return demoProfileChoices("grok"); });
  try {
    await f.reader.read("codex");
    peerRead = f.reader.read("grok");
    await waitDuring(() => f.calls.length === 2, peerRead, "the held configuration request");
    stopping = f.reader.stop();
    const reported = outcome(stopping).then(result => ({ result, peerCompleted }));
    first.reject(failure);
    handoff.resolve(); await peerRead;
    expect(f.reader.activity().checking).toEqual([]);
    expect(f.reader.activity().stopping).toEqual(["codex", "grok"]);
    if (peerFails) peer.reject(undefined); else peer.resolve();
    const stopped = await reported;
    expect(stopped.result.kind).toBe("error");
    if (stopped.result.kind !== "error") throw new Error("Configuration cleanup failure was discarded");
    if (peerFails) {
      expect(stopped.result.error).toBeInstanceOf(AggregateError);
      const errors: unknown[] = (stopped.result.error as AggregateError).errors;
      expect(errors).toHaveLength(2); expect(errors[0]).toBe(failure); expect(errors[1]).toBeUndefined();
      expect(f.reader.activity().stopping).toEqual(["codex", "grok"]);
    } else {
      expect(stopped.result.error).toBe(failure);
      expect(stopped.peerCompleted).toBe(true);
      expect(f.reader.activity().stopping).toEqual(["codex"]);
    }
    expect(f.calls.map(call => call.tool)).toEqual(["codex", "grok"]);
    expect(f.calls.every(call => call.signal.aborted)).toBe(true);
  } finally { handoff.resolve(); first.resolve(); peer.resolve(); await Promise.allSettled([peerRead, stopping]); await outcome(f.reader.stop()); }
});

for (const failure of [new Error("Model choices unavailable"), undefined]) it(`joins ordinary ${failure === undefined ? "undefined" : "Error"} model-choice failure without calling it failed cleanup`, async () => {
  const f = profileFixture(), request = deferred<void>();
  f.scripts.set("codex", async () => { await request.promise; throw failure; });
  const reading = f.reader.read("codex");
  const observed = outcome(reading);
  let stopping: Promise<void> | undefined;
  try {
    await waitDuring(() => f.calls.length === 1, reading, "the pending model-choice request");
    stopping = f.reader.stop();
    request.resolve();
    const result = await observed;
    expect(result.kind).toBe("error");
    if (result.kind !== "error") throw new Error("The ordinary request unexpectedly succeeded");
    expect(result.error).toBe(failure);
    await stopping;
    expect(f.reader.activity()).toEqual({ checking: [], stopping: [] });
    expect(f.calls[0]!.signal.aborted).toBe(true);
  } finally { request.resolve(); await Promise.allSettled([reading, stopping]); await outcome(f.reader.stop()); }
});
