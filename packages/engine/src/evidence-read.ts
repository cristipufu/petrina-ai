// Native identity/encoding composition for the shared recorded-evidence page policy.
import { evidencePosition, paginateEvidence, readEvidenceText, type EvidencePageCodec } from "@petrina/core";
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
