// Capability and deadline decisions take explicit effects, without native imports.
/** A started native helper. Callers retain ownership of the process identity. */
export interface HelperProcess { kill(signal?: "SIGKILL"): unknown }
export type ProcessHelper = (command: string, args: readonly string[], options: {
  timeout: number;
  windowsHide: true
}, done: (error: Error | null) => void) => HelperProcess;
/** Schedule a future deadline, returning its cancellation. */
export type ProcessDeadline = (expired: () => void, ms: number) => () => void;

export interface ProcessHost {
  /** POSIX process groups support group signals and group ownership observations. */
  readonly groups: boolean;
  readonly ownedSpawn: { readonly detached: boolean; readonly windowsHide: true };
  /** Windows can stop a live parent's tree. Absence means this native operation is unavailable. */
  readonly stopTree?: (pid: number, timeoutMs: number) => Promise<boolean>;
}

export function processHostFor(platform: NodeJS.Platform, helper: ProcessHelper, arm: ProcessDeadline): ProcessHost {
  const groups = platform !== "win32";
  return {
    groups,
    ownedSpawn: { detached: groups, windowsHide: true },
    ...(!groups ? { stopTree: (pid: number, timeoutMs: number): Promise<boolean> => {
      if (!Number.isSafeInteger(pid) || pid <= 0 || !(timeoutMs > 0 && timeoutMs <= 2_147_483_647)) return Promise.resolve(false);
      const budget = Math.ceil(timeoutMs);
      if (budget > 2_147_483_647) return Promise.resolve(false);
      return new Promise<boolean>(resolve => {
        let cancel: (() => void) | undefined;
        let child: HelperProcess | undefined;
        let settled = false;
        const finish = (success: boolean) => {
          if (settled) return;
          settled = true;
          cancel?.();
          resolve(success);
        };
        try {
          child = helper("taskkill", ["/pid", String(pid), "/T", "/F"], { timeout: budget, windowsHide: true }, error => finish(!error));
          if (!settled) cancel = arm(() => {
            if (settled) return;
            finish(false);
            try { child?.kill("SIGKILL"); } catch { /* The helper already stopped. */ }
          }, budget);
        } catch {
          finish(false);
          try { child?.kill("SIGKILL"); } catch { /* The helper already stopped. */ }
        }
      });
    } } : {}),
  };
}
