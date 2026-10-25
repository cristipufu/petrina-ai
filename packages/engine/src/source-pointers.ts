import type { Id, SourcePointer, Task } from "@petrina/core";
import { z } from "zod";
import * as git from "./git.js";

/** One optional navigation location. Each is checked on its own, so a bad entry never costs an agent's result. */
export const SourcePointerEntry = z.object({
  productId: z.string().min(1).max(100),
  revision: z.string().regex(/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/i),
  path: z.string().trim().min(1).max(180).refine((path) => !path.startsWith("/") && !path.includes("\\") && !path.split("/").includes(".."), "Use a repository-relative location"),
}).strict();

/**
 * Keep the valid hints of an optional list, in order: at most eight distinct locations and versions, each naming one of
 * `productIds` exactly. Ids are never derived from a repository address or a name. Absent or null means none.
 * `left` says in plain words what was left out, for the task's history.
 */
export function checkSourceHints(supplied: unknown, productIds: readonly Id[]): { pointers: SourcePointer[]; left?: string } {
  if (supplied === undefined || supplied === null) return { pointers: [] };
  const entries: unknown[] = Array.isArray(supplied) ? supplied : [supplied];
  const pointers: SourcePointer[] = [];
  const seen = new Set<string>();
  let malformed = 0, outside = 0, over = 0;
  for (const entry of entries) {
    const parsed = SourcePointerEntry.safeParse(entry);
    if (!parsed.success) { malformed += 1; continue; }
    const pointer = parsed.data;
    if (!productIds.includes(pointer.productId)) { outside += 1; continue; }
    // Which version is current is known only when hints are passed on, so only exact repeats collapse here.
    const key = JSON.stringify([pointer.productId, pointer.revision.toLowerCase(), pointer.path]);
    if (seen.has(key)) continue;
    seen.add(key);
    if (pointers.length === 8) { over += 1; continue; }
    pointers.push(pointer);
  }
  const reasons = [
    outside ? `${outside} did not name one of this task's products by its exact id` : "",
    malformed ? `${malformed} ${malformed === 1 ? "was not a" : "were not"} repository location${malformed === 1 ? "" : "s"} at a full source version` : "",
    over ? `${over} went past the limit of eight` : "",
  ].filter(Boolean);
  const count = outside + malformed + over;
  return { pointers, ...(count ? { left: `Left out ${count} optional source location${count === 1 ? "" : "s"}: ${reasons.join("; ")}. Kept ${pointers.length || "none"}.` } : {}) };
}

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
