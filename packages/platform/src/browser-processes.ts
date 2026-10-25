import { processHost } from "./process-host.js";
import { descendants, descendantsKnown, processList } from "./process-tree.js";
import { processFolderSnapshot, type ProcessFolderSnapshot } from "./process-directory-snapshots.js";

/** Only the process operations consumed by an owned browser stop. */
export interface BrowserProcessControl {
  readonly observer: number;
  readonly groups: boolean;
  readonly stopTree?: (pid: number, ms: number) => Promise<boolean>;
  descendants(roots: readonly number[]): Promise<number[] | undefined>;
  descendantsKnown(roots: readonly number[], budget: number): Promise<number[] | undefined>;
  readFolder(directory: string): Promise<ProcessFolderSnapshot | undefined>;
  exists(pid: number): boolean;
  forceKill(pids: readonly number[]): void;
}

export const browserProcesses: BrowserProcessControl = {
  observer: process.pid,
  groups: processHost.groups,
  ...(processHost.stopTree ? { stopTree: (pid: number, ms: number) => processHost.stopTree!(pid, ms) } : {}),
  descendants,
  descendantsKnown,
  async readFolder(directory) {
    const column = process.platform === "linux" ? "args=" : "command=";
    const stdout = await processList(["-axww", "-o", `pid=,ppid=,stat=,${column}`], 2_000, 32 * 1024 * 1024);
    return stdout === undefined ? undefined : processFolderSnapshot(stdout, directory);
  },
  exists(pid) {
    try { process.kill(pid, 0); return true; }
    catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
  },
  forceKill(pids) {
    for (const pid of pids) {
      // The adapter's caller owns these targets for this stop attempt. No saved PID establishes ownership.
      try { process.kill(-pid, "SIGKILL"); } catch { /* Not a process group leader. */ }
      try { process.kill(pid, "SIGKILL"); } catch { /* Already gone. */ }
    }
  },
};
