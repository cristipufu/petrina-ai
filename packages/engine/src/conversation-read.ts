import { createHash } from "node:crypto";
import type { Task } from "@petrina/core";
import type { Result } from "./coordination.js";

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 24);
type Line = Task["session"][number];
type Step = NonNullable<Task["journey"]>[number];

type Attempt = "open" | "ended" | "unknown";
const MAY_CHANGE = { open: true, ended: false, unknown: null } as const;

/**
 * A node's recorded starts and what ended each: its result, or a later start taking its place (a restart or a stand-in).
 * A message names the start that wrote it. An older one could belong to the latest start before it of every place sharing
 * its role and profile; without a recorded start for that participant it is unattributed. Nothing is guessed beyond that.
 */
function participants(step: Step): { state: readonly Attempt[]; starts: (line: Line) => readonly number[] | undefined } {
  const inputs = step.agentInputs ?? [];
  const same = (
    input: (typeof inputs)[number],
    entry: {
    roleId?: string;
    profileId?: string
  }
  ) => input.roleId === entry.roleId && input.profileId === entry.profileId;
  // A review place or vote place survives a stand-in; any other seat is its planned profile.
  const seats = inputs.map((input) => JSON.stringify([
    input.roleId,
    input.reviewerKey ?? null,
    input.place ?? null,
    input.reviewerKey === undefined && input.place === undefined ? input.requestedProfileId ?? input.profileId : null
  ]));
  const state = seats.map((seat, index): Attempt => seats.indexOf(seat, index + 1) > index ? "ended" : "open");
  for (const result of step.agentResults ?? []) {
    if (result.inputIndex !== undefined) {
      if (state[result.inputIndex]) state[result.inputIndex] = "ended";
      continue;
    }
    // An older result names no start: it closes one only when a single unfinished start could have handed it back.
    // Several results for several such starts still do not say which start gave which, so those stay unknown.
    const could = inputs.flatMap((input, index) => same(input, result) && state[index] !== "ended" && (input.at ?? 0) <= result.at ? [index] : []);
    for (const index of could) state[index] = could.length === 1 ? "ended" : "unknown";
  }
  return {
    state,
    starts: (line) => {
      if (line.inputIndex !== undefined && inputs[line.inputIndex] && same(inputs[line.inputIndex]!, line)) return [line.inputIndex];
      const own = inputs.flatMap((input, index) => same(input, line) ? [index] : []);
      if (!own.length) return undefined;
      return [...new Set(own.map((index) => seats[index]))].flatMap((seat) => own.filter((index) => seats[index] === seat && (inputs[index]!.at ?? 0) <= line.at).slice(-1));
    },
  };
}

/** Read recent messages first. Stable message anchors survive appends and streaming elsewhere. */
export function readConversation(task: Task, args: {
  nodeId?: string;
  messageId?: string;
  limit?: number;
  cursor?: string;
  ifRevision?: string;
  includeActivity?: boolean
}): Result {
  const steps = new Map(task.journey?.map((step) => [step.id, step]));
  if (args.nodeId && !steps.has(args.nodeId)) return { outcome: "unavailable", message: "That node has no recorded conversation." };
  const scope = hash([task.id, args.nodeId, args.messageId, !!args.includeActivity]);
  const selected = task.session.filter((line) => (!args.nodeId || line.step === args.nodeId) && (args.includeActivity || line.from !== "activity"));
  const nodes = new Map<string, ReturnType<typeof participants>>();
  // A participant's message on an unfinished node, with the starts that could have written it.
  const written = (line: Line) => {
    const step = line.step ? steps.get(line.step) : undefined;
    if (!step || step.endedAt !== undefined || (line.from !== "agent" && line.from !== "activity")) return undefined;
    if (!nodes.has(step.id)) nodes.set(step.id, participants(step));
    const node = nodes.get(step.id)!;
    return { state: node.state, starts: node.starts(line) };
  };
  const mayChange = (line: Line): boolean | null => {
    const step = line.step ? steps.get(line.step) : undefined;
    if (!step) return null;
    if (step.endedAt !== undefined) return false;
    const by = written(line);
    if (!by) return true;
    if (!by.starts) return null;
    const states = new Set(by.starts.map((index) => by.state[index]!));
    if (!states.size) return false;
    return states.size === 1 ? MAY_CHANGE[[...states][0]!] : null;
  };
  // Each unfinished start's latest message it could have written, listed once: a slower peer may still stream into an
  // earlier bubble outside the recent text budget; a finished or replaced one cannot.
  const latest = new Map<string, number>();
  selected.forEach((line, position) => {
    const by = line.from === "agent" ? written(line) : undefined;
    for (const index of by?.starts ?? []) if (by!.state[index] !== "ended") latest.set(`${line.step}:${index}`, position);
  });
  const activeMessages = [...new Set(latest.values())].sort((
    a,
    b
  ) => a - b).map((position) => selected[position]!).map((line) => ({
    id: line.id,
    roleId: line.roleId,
    profileId: line.profileId,
    revision: hash(line.text)
  }));
  const lines = args.messageId ? selected.filter((line) => line.id === args.messageId) : selected;
  if (args.messageId && !lines.length) return { outcome: "unavailable", message: "That message is not recorded in this conversation." };
  let index = lines.length - 1;
  let end = lines[index]?.text.length ?? 0;
  if (args.cursor) {
    try {
      const saved = JSON.parse(Buffer.from(args.cursor, "base64url").toString());
      index = lines.findIndex((line) => line.id === saved.id);
      const line = lines[index];
      if (saved.scope !== scope || !line || !Number.isSafeInteger(saved.end) || saved.end < 0 || saved.end > line.text.length || hash(line.text.slice(
        0,
        saved.end
      )) !== saved.prefix) throw new Error();
      end = saved.end;
      if (!end) {
        index--;
        end = lines[index]?.text.length ?? 0;
      }
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
    items.unshift({
      ...line,
      text: line.text.slice(
      start,
      end
    ),
      offset: start,
      total: line.text.length,
      revision: hash(line.text),
      mayChange: mayChange(line)
    });
    anchor = { id: line.id, end: start, prefix: hash(line.text.slice(0, start)) };
    remaining -= end - start;
    if (start > 0) break;
    index--;
    end = lines[index]?.text.length ?? 0;
  }
  const next = anchor && (anchor.end > 0 || index >= 0) ? Buffer.from(JSON.stringify({ scope, ...anchor })).toString("base64url") : undefined;
  const revision = hash([scope, args.cursor, items, activeMessages]);
  return {
    outcome: "completed",
    items: args.ifRevision === revision ? [] : items,
    unchanged: args.ifRevision === revision,
    revision,
    activeMessages,
    ...(next ? { next } : {}),
    order: "chronological",
    paging: "older",
    activityIncluded: !!args.includeActivity
  };
}
