// Native identity/encoding composition for the shared recorded-evidence page policy.
import { createHash } from "node:crypto";
import {
  characterEnd,
  evidencePosition,
  paginateEvidence,
  readEvidenceText,
  type EvidencePageCodec,
} from "@petrina/core";
import { fingerprint } from "@petrina/storage/receipt-identity";
import type { Result } from "./coordination.js";

export function cursor(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}
const codec: EvidencePageCodec = {
  fingerprint, encodeCursor: cursor, decodeCursor: value => JSON.parse(Buffer.from(value, "base64url").toString()),
};
export function position(raw: string | undefined, key: string): number | undefined { return evidencePosition(raw, key, codec); }
export function paginate<T>(
  items: readonly T[],
  args: {
  cursor?: string;
  limit?: number
},
  scope: unknown
): Result { return paginateEvidence(
  items,
  args,
  scope,
  codec
); }
export function readText(
  value: unknown,
  args: {
  cursor?: string;
  limit?: number
},
  scope: unknown,
  extra: Record<string, unknown> = {}
): Result { return readEvidenceText(
  value,
  args,
  scope,
  extra,
  codec
); }

/** A long conversation retains the existing JSON text contract without assembling a whole transcript. */
export function readTextParts(
  parts: () => Iterable<string>,
  args: { cursor?: string; limit?: number },
  scope: unknown,
): Result {
  const digest = createHash("sha256").update(JSON.stringify(scope));
  let total = 0;
  for (const part of parts()) {
    total += part.length;
    digest.update(part);
  }
  const key = digest.digest("hex").slice(0, 24);
  const at = position(args.cursor, key);
  if (at === undefined || at > total) {
    return { outcome: "changed", message: "This evidence changed. Read it again from the beginning." };
  }
  const limit = Math.max(2, Math.min(args.limit ?? 8000, 32_000));
  let offset = 0;
  let text = "";
  for (const part of parts()) {
    if (offset + part.length > at && text.length <= limit) {
      text += part.slice(Math.max(0, at - offset), Math.max(0, at + limit + 1 - offset));
    }
    offset += part.length;
    if (text.length > limit || offset >= at + limit + 1) break;
  }
  text = text.slice(0, characterEnd(text, Math.min(text.length, limit)));
  const end = at + text.length;
  return {
    outcome: "completed",
    text,
    offset: at,
    total,
    shortened: end < total,
    ...(end < total ? { next: cursor({ key, at: end }) } : {}),
  };
}
