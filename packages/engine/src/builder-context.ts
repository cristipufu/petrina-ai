import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { BuilderContext, Role, Task } from "@petrina/core";
import type { Section } from "./context.js";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const reusable = (title: string) => /^(?:Design brief|Product checks|Approved starting point and delivery|Complete approved product map and responsibility|The coordinator's notes on this task|What the builder reports|Previously inspected source locations)/.test(title);

/** Delta only a confirmed continuation; an immutable full packet remains readable after compaction. */
export async function builderContext(dataDir: string, task: Task, role: Role, sessionId: string, sections: readonly Section[], previous?: BuilderContext, options: { design?: boolean; knownSections?: readonly string[] } = {}): Promise<{ sections: Section[]; snapshot?: BuilderContext }> {
  const all = sections.map((section) => ({ ...section }));
  if (!/^[a-zA-Z0-9_-]+$/.test(task.id)) return { sections: all };
  const root = join(dataDir, "contexts", task.id);
  const scope = hash(JSON.stringify({ sessionId, role, productId: task.productId, path: task.worktree, title: task.title, request: task.description, source: task.source, base: task.baseSha, copies: task.repositories?.map((work) => ({ productId: work.productId, base: work.baseSha, source: work.source, path: work.worktree })) }));
  const counts = new Map<string, number>();
  const keyed = sections.map((section) => {
    const occurrence = (counts.get(section.title) ?? 0) + 1;
    counts.set(section.title, occurrence);
    return { section, key: `${section.title}#${occurrence}`, digest: hash(section.body) };
  });
  const packet = `# Current task: ${task.title}\n${task.description}\n\n${sections.map((section) => `## ${section.title}\n${section.body}`).join("\n\n")}\n`;
  const digest = hash(packet);
  const file = join(root, `${digest}.md`);
  try {
    await mkdir(root, { recursive: true, mode: 0o700 });
    try { await writeFile(file, packet, { flag: "wx", mode: 0o600 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    if (hash(await readFile(file, "utf8")) !== digest) return { sections: all };
    const snapshot: BuilderContext = { scope, file, digest, hashes: Object.fromEntries(keyed.map((entry) => [entry.key, entry.digest])) };
    const intact = previous && previous.scope === scope && dirname(previous.file) === root
      && await readFile(previous.file, "utf8").then((text) => hash(text) === previous.digest, () => false);
    if (!intact || !previous) return { sections: all, snapshot };
    const sent = keyed.filter(({ section, key, digest }) => {
      if (options.design && options.knownSections?.includes(section.title)) return false;
      // Objections and coordinator calls remain explicit on every design continuation.
      const background = options.design ? !/^(?:Objections|The coordinator's call)/.test(section.title) : reusable(section.title);
      return !background || previous.hashes[key] !== digest;
    }).map(({ section }) => ({ ...section }));
    const removed = Object.keys(previous.hashes).filter((key) => !(key in snapshot.hashes));
    if (sent.length === all.length && !removed.length) return { sections: all, snapshot };
    return { snapshot, sections: [{ title: "Current authoritative task context", body: `Unchanged background is not repeated in this continued conversation. The complete current request and sections are saved at ${file} (reference ${digest}). This packet replaces earlier versions. Read it before acting if context is missing or was compacted, or you need to recheck a constraint. New instructions and findings below remain authoritative.${removed.length ? `\nEarlier sections no longer apply: ${removed.join(", ")}.` : ""}` }, ...sent] };
  } catch {
    // Optional context reduction must never remove requirements when storage is unavailable.
    return { sections: all };
  }
}
