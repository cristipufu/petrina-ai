import { createHash } from "node:crypto";
import type { Task } from "@petrina/core";
import type { Result } from "./coordination.js";

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 24);

/** Read recent messages first. Stable message anchors survive appends and streaming elsewhere. */
export function readConversation(task: Task, args: { nodeId?: string; messageId?: string; limit?: number; cursor?: string; ifRevision?: string; includeActivity?: boolean }): Result {
  const steps = new Map(task.journey?.map((step) => [step.id, step]));
  if (args.nodeId && !steps.has(args.nodeId)) return { outcome: "unavailable", message: "That node has no recorded conversation." };
  const scope = hash([task.id, args.nodeId, args.messageId, !!args.includeActivity]);
  const selected = task.session.filter((line) => (!args.nodeId || line.step === args.nodeId) && (args.includeActivity || line.from !== "activity"));
  const live = new Map<string, (typeof task.session)[number]>();
  for (const line of selected) if (line.from === "agent" && line.step && steps.get(line.step)?.endedAt === undefined && steps.has(line.step)) live.set(`${line.step}:${line.roleId}:${line.profileId}`, line);
  // A slower peer may still stream into an earlier bubble outside the recent text budget.
  const activeMessages = [...live.values()].map((line) => ({ id: line.id, roleId: line.roleId, profileId: line.profileId, revision: hash(line.text) }));
  const lines = args.messageId ? selected.filter((line) => line.id === args.messageId) : selected;
  if (args.messageId && !lines.length) return { outcome: "unavailable", message: "That message is not recorded in this conversation." };
  let index = lines.length - 1;
  let end = lines[index]?.text.length ?? 0;
  if (args.cursor) {
    try {
      const saved = JSON.parse(Buffer.from(args.cursor, "base64url").toString());
      index = lines.findIndex((line) => line.id === saved.id);
      const line = lines[index];
      if (saved.scope !== scope || !line || !Number.isSafeInteger(saved.end) || saved.end < 0 || saved.end > line.text.length || hash(line.text.slice(0, saved.end)) !== saved.prefix) throw new Error();
      end = saved.end;
      if (!end) { index--; end = lines[index]?.text.length ?? 0; }
    } catch {
      return { outcome: "changed", message: "The anchored message changed or is no longer available. Read recent messages again." };
    }
  }
  const items = [];
  let remaining = args.limit ?? 8000;
  let anchor: { id: string; end: number; prefix: string } | undefined;
  while (index >= 0 && remaining > 0 && items.length < 100) {
    const line = lines[index]!;
    let start = Math.max(0, end - remaining);
    // Keep a Unicode character together, including when the budget is one character.
    if (start > 0 && /[\uD800-\uDBFF]/.test(line.text[start - 1]!) && /[\uDC00-\uDFFF]/.test(line.text[start]!)) start--;
    const step = line.step ? steps.get(line.step) : undefined;
    items.unshift({ ...line, text: line.text.slice(start, end), offset: start, total: line.text.length, revision: hash(line.text), mayChange: step ? step.endedAt === undefined : null });
    anchor = { id: line.id, end: start, prefix: hash(line.text.slice(0, start)) };
    remaining -= end - start;
    if (start > 0) break;
    index--;
    end = lines[index]?.text.length ?? 0;
  }
  const next = anchor && (anchor.end > 0 || index >= 0) ? Buffer.from(JSON.stringify({ scope, ...anchor })).toString("base64url") : undefined;
  const revision = hash([scope, args.cursor, items, activeMessages]);
  return { outcome: "completed", items: args.ifRevision === revision ? [] : items, unchanged: args.ifRevision === revision, revision, activeMessages, ...(next ? { next } : {}), order: "chronological", paging: "older", activityIncluded: !!args.includeActivity };
}
