import { expect, it, vi } from "vitest";
import { demoProfileChoices } from "@petrina/core";
import { ProfileChoiceController } from "../../../src/profile-choices.js";

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
