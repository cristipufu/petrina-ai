import { FixtureOperations, type FixtureOperationEffects } from "./fixture-operations.js";

export async function flushOperations(): Promise<void> { for (let i = 0; i < 12; i++) await Promise.resolve(); }

/** Controlled ownership/deadline effects. No application, process, filesystem, or guessed completion. */
export function fixtureOperationControl() {
  class Effects implements FixtureOperationEffects {
    readonly label = "Private fixture";
    readonly allowanceMs = 5_000;
    readonly events: string[] = [];
    readonly timers = new Map<number, { expired(): void; ms: number }>();
    cancelled = 0;
    next = 0;
    stopEffect: () => void | Promise<void> = () => {};
    disposeEffect: () => void | Promise<void> = () => {};
    stop() { this.events.push("stop"); return this.stopEffect(); }
    dispose() { this.events.push("dispose"); return this.disposeEffect(); }
    arm(expired: () => void, ms: number) {
      const id = ++this.next;
      this.timers.set(id, { expired, ms });
      return () => { this.cancelled++; this.timers.delete(id); };
    }
  }
  const effects = new Effects(), owner = new FixtureOperations(effects);
  return { effects, owner, expire() {
    const entry = [...effects.timers][0];
    if (!entry) throw new Error("No cleanup deadline is armed");
    effects.timers.delete(entry[0]); entry[1].expired();
  } };
}
