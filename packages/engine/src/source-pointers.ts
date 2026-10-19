import type { SourcePointer, Task } from "@petrina/core";
import * as git from "./git.js";

/** Optional navigation must never describe an old checkout as current research. */
export async function currentSourcePointers(task: Task, pointers: readonly SourcePointer[]): Promise<SourcePointer[]> {
  const copies = task.repositories ?? [{ productId: task.productId, worktree: task.worktree }];
  const heads = new Map<string, Promise<string | undefined>>();
  const seen = new Set<string>();
  const current: SourcePointer[] = [];
  for (const pointer of pointers.slice(0, 16)) {
    if (current.length === 8) break;
    const path = copies.find((work) => work.productId === pointer.productId)?.worktree;
    if (!path) continue;
    let head = heads.get(path);
    if (!head) { head = git.head(path).catch(() => undefined); heads.set(path, head); }
    if (await head !== pointer.revision.toLowerCase()) continue;
    const key = `${pointer.productId}:${pointer.path}`;
    if (seen.has(key)) continue;
    const present = await git.run(["git", "cat-file", "-e", `${pointer.revision}:${pointer.path}`], path).catch(() => undefined);
    if (present?.code !== 0) continue;
    seen.add(key);
    current.push(pointer);
  }
  return current;
}
