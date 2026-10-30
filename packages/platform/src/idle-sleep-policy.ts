/** Portable ownership of one best-effort idle hold per active period. */
export interface IdleSleepEffects {
  available(): boolean;
  acquire(): { stop(): void };
  observe?(active: boolean): void;
}

export class IdleSleepHold {
  private active = false;
  private attempted = false;
  private child?: { stop(): void };
  constructor(private readonly effects: IdleSleepEffects) {}

  setActive(active: boolean): void {
    if (active === this.active) return;
    this.active = active;
    if (this.effects.observe) {
      try { this.effects.observe(active); } catch { /* Observation must not affect engine work. */ }
      return;
    }
    if (active) {
      if (!this.effects.available() || this.attempted) return;
      this.attempted = true;
      try { this.child = this.effects.acquire(); }
      catch { /* Sleep prevention is best effort. */ }
      return;
    }
    this.attempted = false;
    const child = this.child;
    this.child = undefined;
    try { child?.stop(); } catch { /* It may have exited already. */ }
  }

  shutdown(): void { this.setActive(false); }
}

/** Native invocation policy takes explicit machine facts; it launches nothing. */
export function idleSleepCommand(platform: NodeJS.Platform, pid: number): { command: string; args: readonly string[] } | undefined {
  return platform === "darwin" ? { command: "/usr/bin/caffeinate", args: ["-i", "-s", "-w", String(pid)] } : undefined;
}

/** Explicit fact readers keep platform/process defaults in the native composition. */
export function idleSleepEffects(options: {
  platform(): NodeJS.Platform;
  pid(): number;
  spawn(command: string, args: readonly string[]): { stop(): void };
  observe?: (active: boolean) => void;
}): IdleSleepEffects {
  return {
    available: () => options.platform() === "darwin",
    acquire: () => {
      const invocation = idleSleepCommand(options.platform(), options.pid())!;
      return options.spawn(invocation.command, invocation.args);
    },
    ...(options.observe ? { observe: (active: boolean) => options.observe!(active) } : {}),
  };
}
