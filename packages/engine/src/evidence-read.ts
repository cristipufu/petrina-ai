// Bounded evidence pages with revisions scoped to the exact recorded content.
import { fingerprint } from "@petrina/storage/receipt-identity";
import type { Result } from "./coordination.js";

export function cursor(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}
export function position(raw: string | undefined, key: string): number | undefined {
  if (!raw) return 0;
  try {
    const data = JSON.parse(Buffer.from(raw, "base64url").toString());
    return data.key === key && Number.isSafeInteger(data.at) && data.at >= 0 ? data.at : undefined;
  } catch {
    return undefined;
  }
}
export function paginate<T>(items: readonly T[], a: { cursor?: string; limit?: number }, scope: unknown): Result {
  const key = fingerprint([scope, items]);
  const at = position(a.cursor, key);
  if (at === undefined) return { outcome: "changed", message: "This page changed. Read the focused list again." };
  const limit = a.limit ?? 25;
  return {
    outcome: "completed",
    items: items.slice(at, at + limit),
    total: items.length,
    ...(at + limit < items.length ? { next: cursor({ key, at: at + limit }) } : {}),
  };
}
export function readText(value: unknown, a: { cursor?: string; limit?: number }, scope: unknown, extra: Record<string, unknown> = {}): Result {
  if (value === undefined || value === null) return { outcome: "unavailable", message: "This evidence was not recorded or is no longer available.", ...extra };
  const source = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  const key = fingerprint([scope, source]);
  const at = position(a.cursor, key);
  if (at === undefined) return { outcome: "changed", message: "This evidence changed. Read it again from the beginning." };
  const limit = a.limit ?? 8000;
  return {
    outcome: "completed",
    text: source.slice(at, at + limit),
    offset: at,
    total: source.length,
    shortened: at + limit < source.length,
    ...(at + limit < source.length ? { next: cursor({ key, at: at + limit }) } : {}),
    ...extra,
  };
}
