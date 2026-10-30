import type { Id, SourcePointer } from "@petrina/core";

const REVISION_PATTERN = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/i;

function parseSourcePointer(entry: unknown): SourcePointer | undefined {
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
    return undefined;
  }
  const keys = Object.keys(entry);
  if (keys.length !== 3) {
    return undefined;
  }
  for (const key of keys) {
    if (key !== "productId" && key !== "revision" && key !== "path") {
      return undefined;
    }
  }
  const record = entry as Record<string, unknown>;
  const productId = record.productId;
  const revision = record.revision;
  const rawPath = record.path;
  if (typeof productId !== "string" || productId.length < 1 || productId.length > 100) {
    return undefined;
  }
  if (typeof revision !== "string" || !REVISION_PATTERN.test(revision)) {
    return undefined;
  }
  if (typeof rawPath !== "string") {
    return undefined;
  }
  const path = rawPath.trim();
  if (
    path.length < 1
    || path.length > 180
    || path.startsWith("/")
    || path.includes("\\")
    || path.split("/").includes("..")
  ) {
    return undefined;
  }
  return { productId, revision, path };
}

/**
 * Keep the valid hints of an optional list, in order: at most eight distinct locations and versions, each naming one of
 * `productIds` exactly. Ids are never derived from a repository address or a name. Absent or null means none.
 * `left` says in plain words what was left out, for the task's history.
 */
export function checkSourceHints(
  supplied: unknown,
  productIds: readonly Id[],
): { pointers: SourcePointer[]; left?: string } {
  if (supplied === undefined || supplied === null) {
    return { pointers: [] };
  }
  const entries: unknown[] = Array.isArray(supplied) ? supplied : [supplied];
  const pointers: SourcePointer[] = [];
  const seen = new Set<string>();
  let malformed = 0;
  let outside = 0;
  let over = 0;
  for (const entry of entries) {
    const pointer = parseSourcePointer(entry);
    if (!pointer) {
      malformed += 1;
      continue;
    }
    if (!productIds.includes(pointer.productId)) {
      outside += 1;
      continue;
    }
    // Which version is current is known only when hints are passed on, so only exact repeats collapse here.
    const key = JSON.stringify([pointer.productId, pointer.revision.toLowerCase(), pointer.path]);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    if (pointers.length === 8) {
      over += 1;
      continue;
    }
    pointers.push(pointer);
  }
  const reasons = [
    outside ? `${outside} did not name one of this task's products by its exact id` : "",
    malformed
      ? `${malformed} ${malformed === 1 ? "was not a" : "were not"} repository location${malformed === 1 ? "" : "s"} at a full source version`
      : "",
    over ? `${over} went past the limit of eight` : "",
  ].filter(Boolean);
  const count = outside + malformed + over;
  return {
    pointers,
    ...(count
      ? {
          left: `Left out ${count} optional source location${count === 1 ? "" : "s"}: ${reasons.join("; ")}. Kept ${pointers.length || "none"}.`,
        }
      : {}),
  };
}
