/** Keep macOS from idling to sleep while Petrina owns work that is still in progress. */
export class IdleSleepAssertion {
  private active = false;
  private attempted = false;
  private child?: { stop: () => void };

  constructor(private readonly options: {
    platform?: NodeJS.Platform;
    pid?: number;
    /** Tests can observe engine activity without starting a real system process. */
    observe?: (active: boolean) => void;
    /** Tests can exercise process lifetime and spawn failures without calling caffeinate. */
    spawn?: (command: string, args: readonly string[]) => { stop: () => void };
  } = {}) {}

  setActive(active: boolean): void {
    if (active === this.active) return;
    this.active = active;
    if (this.options.observe) {
      try { this.options.observe(active); } catch { /* Test observation must not affect engine work. */ }
      return;
    }
    if (active) {
      if ((this.options.platform ?? process.platform) !== "darwin" || this.attempted) return;
      // One attempt per active period: a missing or immediately exiting caffeinate must not
      // turn every activity update into another process launch.
      this.attempted = true;
      try {
        this.child = (this.options.spawn ?? spawnCaffeinate)(
          "/usr/bin/caffeinate",
          ["-i", "-w", String(this.options.pid ?? process.pid)],
        );
      } catch {
        // Sleep prevention is best effort. It must never stop the engine from running.
      }
      return;
    }
    this.attempted = false;
    const child = this.child;
    this.child = undefined;
    try { child?.stop(); } catch { /* It may have exited already. */ }
  }

  shutdown(): void {
    this.setActive(false);
  }
}

function spawnCaffeinate(command: string, args: readonly string[]): { stop: () => void } {
  const child = Bun.spawn([command, ...args], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  return { stop: () => child.kill() };
}
