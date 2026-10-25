import type { SourcePointer, Task } from "@petrina/core";
import * as git from "./git.js";

/** Optional navigation must never describe an old checkout as current research. */
export async function currentSourcePointers(task: Task, pointers: readonly SourcePointer[]): Promise<SourcePointer[]> {
  const copies = task.repositories?.filter((work) => !work.removed) ?? [{ productId: task.productId, worktree: task.worktree }];
  const heads = new Map<string, Promise<string | undefined>>();
  const seen = new Set<string>();
  const eligible: { pointer: SourcePointer; path: string }[] = [];
  for (const pointer of pointers.slice(0, 16)) {
    const path = copies.find((work) => work.productId === pointer.productId)?.worktree;
    if (!path || /[\r\n\0]/.test(pointer.path)) continue;
    let head = heads.get(path);
    if (!head) { head = git.head(path).catch(() => undefined); heads.set(path, head); }
    if (await head !== pointer.revision.toLowerCase()) continue;
    const key = `${pointer.productId}:${pointer.path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    eligible.push({ pointer, path });
  }
  const present = new Set<SourcePointer>();
  await Promise.all([...new Set(eligible.map((entry) => entry.path))].map(async (path) => {
    const group = eligible.filter((entry) => entry.path === path);
    const checked = await git.run(["git", "cat-file", "--batch-check=%(objecttype)"], path, group.map(({ pointer }) => `${pointer.revision}:${pointer.path}\n`).join("")).catch(() => undefined);
    if (checked?.code !== 0) return;
    const types = checked.stdout.split("\n");
    group.forEach(({ pointer }, index) => { if (/^(?:blob|tree|commit|tag)$/.test(types[index] ?? "")) present.add(pointer); });
  }));
  return eligible.filter(({ pointer }) => present.has(pointer)).slice(0, 8).map(({ pointer }) => pointer);
}
