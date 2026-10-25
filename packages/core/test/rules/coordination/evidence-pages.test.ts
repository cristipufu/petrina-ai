import { describe, expect, it } from "vitest";
import { evidencePosition, paginateEvidence, readEvidenceText, type EvidencePageCodec } from "../../../src/evidence-pages.js";

/** Explicit stable identities exercise projection, not the native SHA/Base64 adapter. */
class PageCodec implements EvidencePageCodec {
  readonly values: unknown[] = [];
  private readonly ids = new Map<string, string>();
  fingerprint(value: unknown): string {
    this.values.push(value);
    const text = JSON.stringify(value);
    if (!this.ids.has(text)) this.ids.set(text, `page-${this.ids.size}`);
    return this.ids.get(text)!;
  }
  encodeCursor(value: unknown): string { return JSON.stringify(value); }
  decodeCursor(value: string): unknown { return JSON.parse(value); }
}

describe("recorded evidence pages", () => {
  it("accepts only a nonnegative safe position for its exact content key", () => {
    const codec = new PageCodec();
    expect(evidencePosition(undefined, "one", codec)).toBe(0);
    expect(evidencePosition("", "one", codec)).toBe(0);
    expect(evidencePosition(codec.encodeCursor({ key: "one", at: 3 }), "one", codec)).toBe(3);
    for (const raw of ["broken", "null", "{}", codec.encodeCursor({ key: "other", at: 0 }), ...[-1, 0.5, Number.MAX_SAFE_INTEGER + 1].map(at => codec.encodeCursor({ key: "one", at }))])
      expect(evidencePosition(raw, "one", codec)).toBeUndefined();
  });

  it("pages the actual list and invalidates continuation when either its scope or content changes", () => {
    const codec = new PageCodec(), items = Array.from({ length: 28 }, (_, id) => ({ id }));
    const first = paginateEvidence(items, {}, "scope", codec);
    expect(first).toMatchObject({ outcome: "completed", items: items.slice(0, 25), total: 28 });
    expect(codec.values[0]).toEqual(["scope", items]);
    expect(paginateEvidence(items, { cursor: String(first.next), limit: 2 }, "scope", codec)).toMatchObject({ items: items.slice(25, 27), total: 28 });
    const final = paginateEvidence(items, { cursor: codec.encodeCursor({ key: codec.fingerprint(["scope", items]), at: 27 }) }, "scope", codec);
    expect(final).toEqual({ outcome: "completed", items: items.slice(27), total: 28 });
    for (const [list, scope] of [[items, "new scope"], [[...items, { id: 28 }], "scope"]] as const)
      expect(paginateEvidence(list, { cursor: String(first.next) }, scope, codec)).toEqual({ outcome: "changed", message: "This page changed. Read the focused list again." });
  });

  it("uses character positions for Unicode text and preserves exact source identity", () => {
    const codec = new PageCodec(), value = "ééé";
    const first = readEvidenceText(value, { limit: 2 }, ["record"], {}, codec);
    expect(first).toMatchObject({ outcome: "completed", text: "éé", offset: 0, total: 3, shortened: true });
    expect(String(first.text)).toHaveLength(2); // UTF-8 would be four bytes; the page contract counts characters.
    expect(codec.values[0]).toEqual([["record"], value]);
    expect(readEvidenceText(value, { cursor: String(first.next), limit: 2 }, ["record"], {}, codec)).toEqual({ outcome: "completed", text: "é", offset: 2, total: 3, shortened: false });
    expect(readEvidenceText("ééx", { cursor: String(first.next) }, ["record"], { extra: "omitted on invalid continuation" }, codec)).toEqual({ outcome: "changed", message: "This evidence changed. Read it again from the beginning." });
  });

  it("serializes structured records with the existing indentation and default character limit", () => {
    const codec = new PageCodec(), value = { field: "x".repeat(8_100) }, source = JSON.stringify(value, null, 2);
    const result = readEvidenceText(value, {}, "record", {}, codec);
    expect(result).toMatchObject({ text: source.slice(0, 8_000), offset: 0, total: source.length, shortened: true });
    expect(readEvidenceText(value, { cursor: String(result.next) }, "record", {}, codec).text).toBe(source.slice(8_000));
  });

  it("retains unavailable evidence and the exact last-spread metadata contract", () => {
    const codec = new PageCodec();
    for (const value of [undefined, null]) expect(readEvidenceText(value, {}, "record", { evidence: "recorded" }, codec)).toEqual({ outcome: "unavailable", message: "This evidence was not recorded or is no longer available.", evidence: "recorded" });
    expect(codec.values).toEqual([]);
    const extra = { outcome: "unavailable", text: "recorded override", offset: 99, total: 100, shortened: false, next: "recorded cursor" };
    expect(readEvidenceText("longer source", { limit: 1 }, "record", extra, codec)).toEqual(extra);
  });
});
