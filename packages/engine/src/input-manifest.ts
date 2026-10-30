import { createHash } from "node:crypto";
import type { InputManifestEntry } from "@petrina/core";
import type { ContextOmission } from "./coordinator-note-context.js";

interface Section { title: string; body: string }
const short = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 16);

/** Which sections the message actually supplied, by name, size and identity, with duplicate names told apart. */
export function inputManifest(instructions: string, sections: readonly Section[], omitted: readonly ContextOmission[] = [], complete = false): InputManifestEntry[] {
  const entries: InputManifestEntry[] = complete ? [] : [{
    name: "Role instructions",
    size: instructions.length,
    digest: short(instructions),
    kind: "instructions"
  }];
  for (const section of sections) {
    const reference = section.title === "Current authoritative task context" ? /saved at (.+?) \(reference ([a-f0-9]+)\)/.exec(section.body) : undefined;
    entries.push({
      name: section.title,
      size: section.body.length,
      digest: short(section.body),
      kind: reference ? "reference" : section.title === "Role instructions" ? "instructions" : "text",
      ...(reference ? {
      file: reference[1]!,
      reference: reference[2]!
    } : {})
    });
  }
  for (const entry of omitted) entries.push({
    name: entry.title,
    size: 0,
    digest: entry.noteId ? entry.digest : entry.digest.slice(
    0,
    16
  ),
    kind: "omitted",
    ...(entry.noteId ? { noteId: entry.noteId } : {})
  });
  return numberInputManifest(entries);
}

/** Number names across the complete supplied manifest, including automatic additions and omissions. */
export function numberInputManifest(entries: readonly InputManifestEntry[]): InputManifestEntry[] {
  const totals = new Map<string, number>();
  const seen = new Map<string, number>();
  for (const entry of entries) totals.set(entry.name, (totals.get(entry.name) ?? 0) + 1);
  return entries.map((entry) => {
    const { occurrence: _old, ...rest } = entry;
    const occurrence = (seen.get(entry.name) ?? 0) + 1;
    seen.set(entry.name, occurrence);
    return { ...rest, ...(totals.get(entry.name)! > 1 ? { occurrence } : {}) };
  });
}
