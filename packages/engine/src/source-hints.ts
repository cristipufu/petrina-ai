import type { Id, SourcePointer } from "@petrina/core";
import { z } from "zod";

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
