import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { BuilderContext, Finding, Role, Task } from "@petrina/core";
import type { Section } from "./context.js";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const reusable = (title: string) => /^(?:Design brief|Product checks|Approved starting point and delivery|Complete approved product map and responsibility|The coordinator's notes on this task|What the builder reports|Previously inspected source locations|What earlier agents on this task handed back|Points the coordinator accepted for the review guide|Open follow-up cards|The pull request description you wrote last time|Earlier implementation and verification evidence)/.test(title);

/** Delta only a confirmed continuation; an immutable full packet remains readable after compaction. */
export async function builderContext(dataDir: string, task: Task, role: Role, sessionId: string, sections: readonly Section[], previous?: BuilderContext, options: { design?: boolean; knownSections?: readonly string[]; findings?: readonly Finding[] } = {}): Promise<{ sections: Section[]; snapshot?: BuilderContext }> {
  const all = sections.map((section) => ({ ...section }));
  if (!/^[a-zA-Z0-9_-]+$/.test(task.id)) return { sections: all };
  const root = join(dataDir, "contexts", task.id);
  // Advancing the approved branch changes the work, not the identity of this
  // conversation. Changed sections are still sent by content hash below.
  const scope = hash(JSON.stringify({ sessionId, role, productId: task.productId, path: task.worktree, title: task.title, request: task.description, source: task.source, copies: task.repositories?.map((work) => ({ productId: work.productId, source: work.source, path: work.worktree })) }));
  const counts = new Map<string, number>();
  const keyed = sections.map((section) => {
    const occurrence = (counts.get(section.title) ?? 0) + 1;
    counts.set(section.title, occurrence);
    return { section, key: `${section.title}#${occurrence}`, digest: hash(section.body) };
  });
  const versions = (task.repositories ?? [task]).map((work) => `${work.productId}: base ${work.baseSha ?? "not prepared"}`).join("\n");
  const findingRecords = options.findings && sections.some((section) => section.title === "Findings so far (confirm or dispute by id)") ? options.findings : undefined;
  const packet = `# Current task: ${task.title}\n${task.description}\n\n## Current repository versions\n${versions}\n\n${sections.map((section) => `## ${section.title}\n${section.body}`).join("\n\n")}\n${findingRecords ? `\n## Complete recorded finding fields\n${JSON.stringify(findingRecords, null, 2)}\n` : ""}`;
  const digest = hash(packet);
  const file = join(root, `${digest}.md`);
  try {
    await mkdir(root, { recursive: true, mode: 0o700 });
    let written = false;
    try { await writeFile(file, packet, { flag: "wx", mode: 0o600 }); written = true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    if (!written && hash(await readFile(file, "utf8")) !== digest) return { sections: all };
    const findingHashes = findingRecords ? Object.fromEntries(findingRecords.map((finding) => [finding.id, hash(JSON.stringify(finding))])) : undefined;
    const snapshot: BuilderContext = { scope, file, digest, hashes: Object.fromEntries(keyed.map((entry) => [entry.key, entry.digest])), ...(findingHashes ? { findingHashes } : {}) };
    const intact = previous && previous.scope === scope && dirname(previous.file) === root
      && await readFile(previous.file, "utf8").then((text) => hash(text) === previous.digest, () => false);
    if (!intact || !previous) return { sections: all, snapshot };
    let reducedFindings = false;
    const sent = keyed.flatMap(({ section, key, digest }) => {
      if (section.title === "Findings so far (confirm or dispute by id)" && options.findings && previous.findingHashes && findingHashes) {
        const changed = options.findings.filter((finding) => findingHashes[finding.id] !== previous.findingHashes![finding.id]);
        const removed = Object.keys(previous.findingHashes).filter((id) => !(id in findingHashes));
        reducedFindings = true;
        return [
          { title: "Current finding status index", body: `${options.findings.map((finding) => `- ${finding.id}: ${finding.status}, ${finding.severity}`).join("\n") || "No current findings."}${removed.length ? `\nNo longer present: ${removed.join(", ")}.` : ""}\nUnchanged records are in the complete current context packet above. Reopening a settled finding still requires fresh evidence on the current code.` },
          ...(changed.length ? [{ title: "New or changed finding records (confirm or dispute by id)", body: JSON.stringify(changed, null, 2) }] : []),
        ];
      }
      if (options.design && options.knownSections?.includes(section.title)) return [];
      // Objections and coordinator calls remain explicit on every design continuation.
      const background = options.design ? !/^(?:Objections|The coordinator's call)/.test(section.title) : reusable(section.title);
      return !background || previous.hashes[key] !== digest ? [{ ...section }] : [];
    });
    const removed = Object.keys(previous.hashes).filter((key) => !(key in snapshot.hashes));
    if (!reducedFindings && sent.length === all.length && !removed.length) return { sections: all, snapshot };
    return { snapshot, sections: [{ title: "Current authoritative task context", body: `Unchanged background is not repeated in this continued conversation. The complete current request and sections are saved at ${file} (reference ${digest}). This packet replaces earlier versions. Read it before acting if context is missing or was compacted, or you need to recheck a constraint. New instructions and findings below remain authoritative.${removed.length ? `\nEarlier sections no longer apply: ${removed.join(", ")}.` : ""}` }, ...sent] };
  } catch {
    // Optional context reduction must never remove requirements when storage is unavailable.
    return { sections: all };
  }
}
