import { execFile } from "node:child_process";

export const CLEANUP_INCOMPLETE = "Petrina could not confirm every child process stopped. Some may still be running.";

/** Descendants of these exact processes, captured before stopping their parents loses the relationship. */
export function descendants(roots: readonly number[], timeout = 4_000): Promise<number[] | undefined> {
  return readProcessList(timeout).then((stdout) => stdout === undefined ? undefined : parseDescendants(stdout, roots));
}

/** Retry a failed snapshot within a fixed budget. `undefined` means no complete snapshot was obtained. */
export async function descendantsKnown(
  roots: readonly number[],
  budget = 3_200,
  read: (timeout: number) => Promise<string | undefined> = readProcessList,
): Promise<number[] | undefined> {
  const started = Date.now();
  for (const attempt of [1_000, 2_000]) {
    const left = budget - (Date.now() - started);
    if (left < 50) break;
    const stdout = await read(Math.min(attempt, left));
    if (stdout !== undefined) return parseDescendants(stdout, roots);
  }
  return undefined;
}

/** Parse one successful `ps` snapshot. An empty list is a valid result. */
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

export function readProcessList(timeout: number): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile("ps", ["-A", "-o", "pid=,ppid="], { timeout }, (error, stdout) => resolve(error ? undefined : stdout));
  });
}
