// Parsing a completed observation has no native effects.
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
