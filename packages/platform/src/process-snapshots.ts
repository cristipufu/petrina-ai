// Parsing a completed observation has no native effects.
export const CLEANUP_INCOMPLETE = "Petrina could not confirm every child process stopped. Some may still be running.";

export type ChildState = "running" | "ended" | "unknown";

export type ProcessState = "running" | "finished" | "absent" | "unknown";

export type ObservedProcess = { pid: number; state: ProcessState; sources: readonly string[] };

export function parseDescendants(stdout: string, roots: readonly number[]): number[] {
  const children = new Map<number, number[]>();
  for (const line of stdout.split("\n")) {
    const [pid, ppid] = line.trim().split(/\s+/).map(Number);
    if (pid && ppid) children.set(ppid, [...(children.get(ppid) ?? []), pid]);
  }
  const found = new Set<number>(roots);
  const queue = [...roots];
  while (queue.length) for (const pid of children.get(queue.shift()!) ?? []) if (!found.has(pid)) found.add(pid), queue.push(pid);
  return [...found].filter((pid) => !roots.includes(pid));
}

export function parseProcessState(stdout: string, pid: number): ProcessState {
  for (const line of stdout.split("\n")) {
    const [id, , state] = line.trim().split(/\s+/);
    if (Number(id) !== pid) continue;
    // An older snapshot without a state column cannot tell a defunct process from a running one.
    return state === undefined ? "unknown" : state.startsWith("Z") ? "finished" : "running";
  }
  return "absent";
}

export function parseChildState(stdout: string, pid: number): ChildState {
  const state = parseProcessState(stdout, pid);
  return state === "finished" || state === "absent" ? "ended" : state;
}

/** Only a complete list positively naming every still-present target as defunct confirms it ended. */
export function stoppedProcessStates(list: string | undefined, present: readonly number[], observer: number): { ended: boolean; processes: ObservedProcess[] } {
  const complete = list !== undefined && list.split("\n").some((line) => Number(line.trim().split(/\s+/)[0]) === observer);
  const members = (group: number) => list!.split("\n").map((line) => line.trim().split(/\s+/)).filter(([, pgid]) => Number(pgid) === group).map(([pid]) => Number(pid));
  const processes = present.flatMap((target): ObservedProcess[] => {
    if (!complete) return [{ pid: Math.abs(target), state: "unknown", sources: [target < 0 ? "group" : "target"] }];
    if (target > 0) return [{ pid: target, state: parseProcessState(list!, target), sources: ["target"] }];
    const listed = members(-target);
    return listed.length ? listed.map((pid) => ({ pid, state: parseProcessState(list!, pid), sources: ["group"] })) : [{ pid: -target, state: "absent", sources: ["group"] }];
  });
  return { ended: complete && processes.every(({ state }) => state === "finished"), processes };
}
