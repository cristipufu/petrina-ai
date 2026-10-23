import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { BuilderContext, Finding, Role, Task } from "@petrina/core";
import type { Section } from "./context.js";
import { saveImmutable } from "./immutable-file.js";
import { FINDING_TAG, formatFindings } from "./prompts.js";
import { continuedCoordinatorNotes, coordinatorNoteHashes, restoreRevisedCoordinatorNotes, type ContextOmission } from "./coordinator-note-context.js";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const reusable = (title: string) => /^(?:Current step assignment|Design brief|Final design-review notes|Product checks|Approved starting point and delivery|Complete approved product map and responsibility|The coordinator's notes on this task|What the builder reports|Previously inspected source locations|What earlier agents on this task handed back|Points the coordinator accepted for the review guide|Open follow-up cards|The pull request description you wrote last time|Earlier implementation and verification evidence)/.test(title);

/** Delta only a confirmed continuation; an immutable full packet remains readable after compaction. */
export async function builderContext(dataDir: string, task: Task, role: Role, sessionId: string, sections: readonly Section[], previous?: BuilderContext, options: { design?: boolean; knownSections?: readonly string[]; findings?: readonly Finding[] } = {}): Promise<{ sections: Section[]; snapshot?: BuilderContext; omitted?: ContextOmission[] }> {
  sections = restoreRevisedCoordinatorNotes(sections, previous);
  const all = sections.filter(section => section.body).map((section) => ({ ...section }));
  if (!/^[a-zA-Z0-9_-]+$/.test(task.id)) return { sections: all };
  const root = join(dataDir, "contexts", task.id);
  // Advancing the approved branch changes the work, not the identity of this
  // conversation. Changed sections are still sent by content hash below.
  const scope = hash(JSON.stringify({ sessionId, role, productId: task.productId, path: task.worktree, title: task.title, request: task.description, source: task.source, copies: task.repositories?.map((work) => ({ productId: work.productId, source: work.source, path: work.worktree })) }));
  const counts = new Map<string, number>();
  const keyed = sections.map((section) => {
    const occurrence = (counts.get(section.title) ?? 0) + 1;
    counts.set(section.title, occurrence);
    const body = section.background ?? section.body;
    // Equal words under different ids can still change the authoritative note order.
    const content = section.coordinatorNotes ? JSON.stringify({ body, ids: section.coordinatorNotes.map(note => note.id) }) : body;
    return { section, key: `${section.title}#${occurrence}`, digest: hash(content) };
  });
  const versions = (task.repositories ?? [task]).map((work) => `${work.productId}: base ${work.baseSha ?? "not prepared"}`).join("\n");
  const answering = (title: string) => title === "Review findings (answer every one by id; fix every Important one)";
  const findingSection = (title: string) => title === "Findings so far (confirm or dispute by id)" || answering(title);
  const findingRecords = sections.some(section => findingSection(section.title)) ? options.findings ?? (role.result === "build" ? task.findings.filter(finding => finding.status === "open" && finding.severity !== "pre-existing" && (!task.repositories || finding.productIds?.includes(task.productId))) : undefined) : undefined;
  // Empty note metadata tracks withdrawals without adding an empty heading to the saved packet.
  const packetSections = sections.filter(section => section.coordinatorNotes === undefined || (section.background ?? section.body));
  const packet = `# Current task: ${task.title}\n${task.description}\n\n## Current repository versions\n${versions}\n\n${packetSections.map((section) => `## ${section.title}\n${section.background ?? section.body}`).join("\n\n")}\n${findingRecords ? `\n## Complete recorded finding fields\n${JSON.stringify(findingRecords, null, 2)}\n` : ""}`;
  try {
    // Check the old evidence first: saving identical content could recreate a missing old file.
    const intact = previous && previous.scope === scope && dirname(previous.file) === root
      && await readFile(previous.file, "utf8").then((text) => hash(text) === previous.digest, () => false);
    // Named only once complete, so a seat saving the same packet at the same moment never reads part of it.
    const { file, digest } = await saveImmutable(root, "md", packet, "The saved context packet changed.");
    const findingHashes = findingRecords ? Object.fromEntries(findingRecords.map((finding) => [finding.id, hash(JSON.stringify(finding))])) : undefined;
    const noteHashes = coordinatorNoteHashes(sections);
    const snapshot: BuilderContext = { scope, file, digest, hashes: Object.fromEntries(keyed.map((entry) => [entry.key, entry.digest])), ...(findingHashes ? { findingHashes } : {}), ...(noteHashes ? { noteHashes } : {}) };
    if (!intact || !previous) return { sections: all, snapshot };
    let reducedFindings = false;
    let reducedNotes = false;
    // Unchanged sections left out of this continuation, recognized only from the recorded comparison.
    const omitted: ContextOmission[] = [];
    const sent = keyed.flatMap(({ section, key, digest }) => {
      if (section.coordinatorNotes !== undefined) {
        const reduced = noteHashes && continuedCoordinatorNotes(section, previous, noteHashes, previous.hashes[key] === digest);
        if (reduced) {
          reducedNotes ||= reduced.sections.length > 0 || reduced.omitted.length > 0;
          omitted.push(...reduced.omitted);
          return reduced.sections;
        }
        // Unavailable individual matching does not prevent an exact whole-section comparison.
        // Legacy snapshots used the full text alone as this section's fingerprint.
        const previousDigest = previous.hashes[key];
        if ((!noteHashes || !previous.noteHashes) && section.body && previousDigest && (previousDigest === digest || previousDigest === hash(section.background ?? section.body))) {
          omitted.push({ title: section.title, digest: previousDigest });
          return [];
        }
        // Changed or unproven sections still carry their complete necessary notes.
        return section.body ? [{ ...section }] : [];
      }
      if (!section.body) return [];
      if (findingSection(section.title) && findingRecords && previous.findingHashes && findingHashes) {
        const changed = findingRecords.filter((finding) => findingHashes[finding.id] !== previous.findingHashes![finding.id]);
        const removed = Object.keys(previous.findingHashes).filter((id) => !(id in findingHashes));
        reducedFindings = true;
        return [
          { title: "Current finding status index", body: `${findingRecords.map((finding) => `- ${finding.id}: ${finding.status}, ${FINDING_TAG[finding.severity]}`).join("\n") || "No current findings."}${removed.length ? `\nNo longer present: ${removed.join(", ")}.` : ""}\n${answering(section.title) ? "Answer every open finding by id, including unchanged records. " : ""}Unchanged records are in the complete current context packet above. Reopening a settled finding still requires fresh evidence on the current code.` },
          ...(changed.length ? [{ title: answering(section.title) ? "New or changed review findings (answer every one by id; fix every Important one)" : "New or changed finding records (confirm or dispute by id)", body: formatFindings(changed, { complete: true }) }] : []),
        ];
      }
      if (options.design && options.knownSections?.includes(section.title)) { omitted.push({ title: section.title, digest }); return []; }
      // Objections and coordinator calls remain explicit on every design continuation.
      const background = options.design ? !/^(?:Objections|The coordinator's call)/.test(section.title) : reusable(section.title);
      if (!background || previous.hashes[key] !== digest) return [{ ...section }];
      omitted.push({ title: section.title, digest });
      return [];
    });
    const removed = Object.keys(previous.hashes).filter((key) => !(key in snapshot.hashes));
    if (!reducedFindings && !reducedNotes && sent.length === all.length && !removed.length) return { sections: all, snapshot };
    return { snapshot, omitted, sections: [{ title: "Current authoritative task context", body: `Unchanged background is not repeated in this continued conversation. The complete current request and sections are saved at ${file} (reference ${digest}). This packet replaces earlier versions. Read it before acting if context is missing or was compacted, or you need to recheck a constraint. New instructions and findings below remain authoritative.${removed.length ? `\nEarlier sections no longer apply: ${removed.join(", ")}.` : ""}` }, ...sent] };
  } catch {
    // Optional context reduction must never remove requirements when storage is unavailable.
    return { sections: all };
  }
}
