import { IdleSleepHold, idleSleepEffects } from "@petrina/platform/idle-sleep-policy";

/** Native composition of the portable best-effort hold; no display assertion. */
export class IdleSleepAssertion extends IdleSleepHold {
  constructor(options: {
    platform?: NodeJS.Platform;
    pid?: number;
    observe?: (active: boolean) => void;
    spawn?: (command: string, args: readonly string[]) => { stop(): void };
  } = {}) {
    super(idleSleepEffects({
      platform: () => options.platform ?? process.platform,
      pid: () => options.pid ?? process.pid,
      spawn: (command, args) => (options.spawn ?? spawnCaffeinate)(command, args),
      ...(options.observe ? { observe: (active: boolean) => options.observe!(active) } : {}),
    }));
  }
}

function spawnCaffeinate(command: string, args: readonly string[]): { stop(): void } {
  const child = Bun.spawn([command, ...args], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  return { stop: () => child.kill() };
}
