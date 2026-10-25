export interface RemovalClock { now(): number; sleep(ms: number): Promise<unknown> }

/** Keep each admitted service read's allowance intact, even near the end of the admission window. */
export async function confirmContainerRemoval(read: () => Promise<readonly string[]>, timeout: number, clock: RemovalClock): Promise<boolean> {
    const deadline = clock.now() + timeout;
    for (;;) {
      if (clock.now() >= deadline) return false;
      try { if (!(await read()).length) return true; }
      catch (error) { if (clock.now() >= deadline) return false; throw error; }
      const left = deadline - clock.now();
      if (left <= 0) return false;
      await clock.sleep(Math.min(50, left));
    }
}
