// Exact recorded-content pagination; native identity/encoding remain supplied effects.
export interface EvidencePageCodec {
  fingerprint(value: unknown): string;
  encodeCursor(value: unknown): string;
  decodeCursor(value: string): unknown;
}
export interface EvidencePageResult {
  outcome: "completed" | "changed" | "unavailable";
  message?: string;
  [key: string]: unknown;
}

export function evidencePosition(raw: string | undefined, key: string, codec: EvidencePageCodec): number | undefined {
  if (!raw) return 0;
  try {
    const data = codec.decodeCursor(raw) as { key: string; at: number };
    return data.key === key && Number.isSafeInteger(data.at) && data.at >= 0 ? data.at : undefined;
  } catch {
    return undefined;
  }
}
export function paginateEvidence<T>(
  items: readonly T[],
  page: { cursor?: string; limit?: number },
  scope: unknown,
  codec: EvidencePageCodec,
): EvidencePageResult {
  const key = codec.fingerprint([scope, items]);
  const at = evidencePosition(page.cursor, key, codec);
  if (at === undefined) return { outcome: "changed", message: "This page changed. Read the focused list again." };
  const limit = page.limit ?? 25;
  return {
    outcome: "completed",
    items: items.slice(at, at + limit),
    total: items.length,
    ...(at + limit < items.length ? { next: codec.encodeCursor({ key, at: at + limit }) } : {}),
  };
}
export function readEvidenceText(
  value: unknown,
  page: {
    cursor?: string;
    limit?: number;
  },
  scope: unknown,
  extra: Record<string, unknown>,
  codec: EvidencePageCodec,
): EvidencePageResult {
  if (value === undefined || value === null) return { outcome: "unavailable", message: "This evidence was not recorded or is no longer available.", ...extra };
  const source = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  const key = codec.fingerprint([scope, source]);
  const at = evidencePosition(page.cursor, key, codec);
  if (at === undefined) return { outcome: "changed", message: "This evidence changed. Read it again from the beginning." };
  const limit = page.limit ?? 8000;
  return {
    outcome: "completed",
    text: source.slice(at, at + limit),
    offset: at,
    total: source.length,
    shortened: at + limit < source.length,
    ...(at + limit < source.length ? { next: codec.encodeCursor({ key, at: at + limit }) } : {}),
    ...extra,
  };
}
