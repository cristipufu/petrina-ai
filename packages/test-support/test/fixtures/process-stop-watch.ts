import type { ProgressClock } from "../../src/progress-wait.js";

export interface StopWatchEffects extends Pick<ProgressClock, "now" | "slow" | "sleep"> {
  state(): Promise<"running" | "unknown" | "ended">;
}

/** The native fixture supplies actual state reads; policy cases supply observations and advance its clock. */
export async function watchStopped(what: string, options: {
  ms: number; endsBy: number; maximumSlow: number; readAllowanceMs: number;
}, effects: StopWatchEffects): Promise<void> {
  const started = effects.now();
  if (started + options.ms * options.maximumSlow + options.readAllowanceMs + 1_000 >= options.endsBy)
    throw new Error(`Cannot watch for ${what}: it could end by itself while watched`);
  while ((await effects.state()) !== "ended") {
    if (effects.now() - started > options.ms * Math.min(options.maximumSlow, effects.slow()))
      throw new Error(`Timed out waiting for ${what}`);
    await effects.sleep(50);
  }
}
