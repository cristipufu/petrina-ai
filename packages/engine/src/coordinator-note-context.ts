import { createHash } from "node:crypto";
import type { BuilderContext } from "@petrina/core";
import { COORDINATOR_NOTES_RULE, coordinatorNoteStep, renderCoordinatorNote, type Section } from "./context-input.js";

export interface ContextOmission { title: string; digest: string; noteId?: string }

const noteHash = (note: NonNullable<Section["coordinatorNotes"]>[number]) => createHash("sha256").update(JSON.stringify({
  text: note.text,
  origin: note.origin
})).digest("hex");

/** Identity comes only from recorded ids and exact content, never rendered prose or similarity. */
export function coordinatorNoteHashes(sections: readonly Section[]): BuilderContext["noteHashes"] {
  const parts = sections.filter(section => section.coordinatorNotes !== undefined);
  if (parts.length !== 1 || parts[0]!.ambiguousCoordinatorNotes) return undefined;
  const notes = parts[0]!.coordinatorNotes!;
  if (notes.some(note => !note.id) || new Set(notes.map(note => note.id)).size !== notes.length) return undefined;
  return Object.fromEntries(notes.map(note => [note.id!, noteHash(note)]));
}

/** Restore revisions before either shortening or full fallback can use an earlier-attempt exclusion. */
export function restoreRevisedCoordinatorNotes(sections: readonly Section[], previous?: BuilderContext): readonly Section[] {
  if (!previous) return sections;
  return sections.map(section => {
    if (!section.coordinatorNotes?.some(note => note.earlierCarried)) return section;
    let notes: Section["coordinatorNotes"];
    try {
      notes = section.coordinatorNotes.map(note => {
        // Step notes record id and text, but lack the original step. An existing exact
        // fingerprint can therefore disprove that the current note was already carried.
        const prior = previous.noteHashes?.[note.id!];
        return note.earlierCarried && prior !== undefined && prior !== noteHash(note) ? { ...note, earlierCarried: false } : note;
      });
    } catch {
      // Unavailable comparisons may restore text; they must never justify leaving it out.
      notes = section.coordinatorNotes.map(note => note.earlierCarried ? { ...note, earlierCarried: false } : note);
    }
    if (notes.every((note, index) => note === section.coordinatorNotes![index])) return section;
    const background = notes.filter(note => note.background && !note.earlierCarried);
    return {
      ...section,
      coordinatorNotes: notes,
      body: background.length ? `${COORDINATOR_NOTES_RULE}\n\n${background.map(renderCoordinatorNote).join("\n\n")}` : ""
    };
  });
}

/** Undefined retains the original notes; no returned sections means unchanged. */
export function continuedCoordinatorNotes(section: Section, previous: BuilderContext, hashes: NonNullable<BuilderContext["noteHashes"]>, sameSection: boolean): {
  sections: Section[];
  omitted: ContextOmission[]
} | undefined {
  if (!previous.noteHashes) return undefined;
  const notes = section.coordinatorNotes!;
  const unchanged = notes.filter(note => previous.noteHashes![note.id!] === hashes[note.id!]);
  const removed = Object.keys(previous.noteHashes).filter(id => !Object.hasOwn(hashes, id) && !section.deferredCoordinatorNoteIds?.includes(id));
  const unchangedBackground = unchanged.filter(note => note.background && !note.earlierCarried);
  const omitted = unchangedBackground.map(note => ({ title: `Coordinator note ${note.id}`, noteId: note.id!, digest: hashes[note.id!]! }));
  if (unchanged.length === notes.length && !removed.length && sameSection) return { sections: [], omitted };
  // Sending all-new notes saves nothing. Withdrawals must still be explicit, including the last note.
  if (!unchangedBackground.length) {
    if (!removed.length) return undefined;
    return {
      omitted: [],
      sections: [
      ...(section.body ? [{ ...section }] : []),
      {
      title: "Coordinator notes no longer applying",
      body: `No longer applying: ${removed.join(", ")}.`
    }
    ]
    };
  }
  const changed = notes.filter(note => note.background && !note.earlierCarried && previous.noteHashes![note.id!] !== hashes[note.id!]);
  const index = notes.map((note, i) => {
    const prior = previous.noteHashes![note.id!];
    const state = note.earlierCarried ? "already carried in earlier-attempt guidance; full text in the saved complete context" : !note.background ? "waiting as a coordinator message" : prior === hashes[note.id!] ? "unchanged in the saved complete context" : `full text below (${prior === undefined ? "new" : "changed"})`;
    return `${i + 1}. ${note.id}: ${coordinatorNoteStep(note)} — ${state}.`;
  }).join("\n");
  return {
    omitted,
    sections: [{
    title: section.title,
    body: `${COORDINATOR_NOTES_RULE}\n\nEvery current note, oldest to newest (unchanged text remains in the complete current context packet above):\n${index}${removed.length ? `\nNo longer applying: ${removed.join(", ")}.` : ""}${changed.length ? `\n\n${changed.map(renderCoordinatorNote).join("\n\n")}` : ""}`
  }]
  };
}
