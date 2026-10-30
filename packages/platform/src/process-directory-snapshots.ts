import type { ProcessState } from "./process-snapshots.js";

/** Complete command-list facts scoped to a caller-owned folder. No raw native grammar crosses this port. */
export interface ProcessFolderSnapshot { readonly pids: readonly number[]; readonly states: ReadonlyMap<number, ProcessState>; readonly commands?: readonly string[] }

export function namesProcessFolder(command: string, directory: string): boolean {
  return command.includes(`${directory}/`) || command.includes(`${directory} `) || command.endsWith(directory);
}

/** Preserve the completed-list and first-row state interpretation used by browser cleanup. */
export function processFolderSnapshot(list: string, directory: string): ProcessFolderSnapshot {
  const pids: number[] = [];
  const commands: string[] = [];
  const states = new Map<number, ProcessState>();
  for (const line of list.split("\n")) {
    const match = /^(\d+)\s+(.*)$/.exec(line.trim());
    if (!match) continue;
    const pid = Number(match[1]);
    const state = line.trim().split(/\s+/)[2];
    if (!states.has(pid)) states.set(pid, state === undefined ? "unknown" : state.startsWith("Z") ? "finished" : "running");
    if (namesProcessFolder(match[2]!, directory)) {
      pids.push(pid);
      commands.push(line);
    }
  }
  return { pids, states, commands };
}
