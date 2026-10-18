import { execFile } from "node:child_process";

/** Descendants of these exact processes, captured before stopping their parents loses the relationship. */
export function descendants(roots: readonly number[], timeout = 4_000): Promise<number[]> {
  return new Promise((resolve) => {
    execFile("ps", ["-A", "-o", "pid=,ppid="], { timeout }, (error, stdout) => {
      if (error) return resolve([]);
      const children = new Map<number, number[]>();
      for (const line of stdout.split("\n")) {
        const [pid, ppid] = line.trim().split(/\s+/).map(Number);
        if (pid && ppid) children.set(ppid, [...(children.get(ppid) ?? []), pid]);
      }
      const found = new Set<number>(roots);
      const queue = [...roots];
      while (queue.length) for (const pid of children.get(queue.shift()!) ?? []) if (!found.has(pid)) found.add(pid), queue.push(pid);
      resolve([...found].filter((pid) => !roots.includes(pid)));
    });
  });
}
