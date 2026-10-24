// Native process capabilities and effects. Callers retain ownership and cleanup policy.
import { execFile, type ChildProcess } from "node:child_process";

export type ProcessHelper = (command: string, args: readonly string[], options: { timeout: number; windowsHide: true }, done: (error: Error | null) => void) => Pick<ChildProcess, "kill">;
const execute: ProcessHelper = (command, args, options, done) => execFile(command, [...args], options, error => done(error));
/** Schedule a future deadline, returning its cancellation. */
export type ProcessDeadline = (expired: () => void, ms: number) => () => void;
const deadline: ProcessDeadline = (expired, ms) => { const timer = setTimeout(expired, ms); return () => clearTimeout(timer); };

export interface ProcessHost {
  /** POSIX process groups support group signals and group ownership observations. */
  readonly groups: boolean;
  readonly ownedSpawn: { readonly detached: boolean; readonly windowsHide: true };
  /** Windows can stop a live parent's tree. Absence means this native operation is unavailable. */
  readonly stopTree?: (pid: number, timeoutMs: number) => Promise<boolean>;
}

/** Inject the native helper privately in contract tests; never replace process-wide commands. */
export function createProcessHost(platform: NodeJS.Platform = process.platform, helper: ProcessHelper = execute, arm: ProcessDeadline = deadline): ProcessHost {
  const groups = platform !== "win32";
  return {
    groups,
    ownedSpawn: { detached: groups, windowsHide: true },
    ...(!groups ? { stopTree: (pid: number, timeoutMs: number): Promise<boolean> => {
      if (!Number.isSafeInteger(pid) || pid <= 0 || !(timeoutMs > 0 && timeoutMs <= 2_147_483_647)) return Promise.resolve(false);
      return new Promise<boolean>(resolve => {
        let cancel: (() => void) | undefined, child: Pick<ChildProcess, "kill"> | undefined, settled = false;
        const finish = (success: boolean) => {
          if (settled) return;
          settled = true; cancel?.(); resolve(success);
        };
        try {
          child = helper("taskkill", ["/pid", String(pid), "/T", "/F"], { timeout: timeoutMs, windowsHide: true }, error => finish(!error));
          if (!settled) cancel = arm(() => {
            if (settled) return;
            finish(false);
            try { child?.kill("SIGKILL"); } catch { /* The helper already stopped. */ }
          }, timeoutMs);
        } catch {
          finish(false);
          try { child?.kill("SIGKILL"); } catch { /* The helper already stopped. */ }
        }
      });
    } } : {}),
  };
}

export const processHost = createProcessHost();
