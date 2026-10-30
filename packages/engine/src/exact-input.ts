// Exact agent inputs: each newly supplied message is saved once as an immutable file beside the task's
// complete-context files, and the journey keeps only its reference, size, identity and section manifest.
// Reads return the saved text after checking its identity; a missing or changed file says so and never
// substitutes a rebuilt or newer message.
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { seatOf, type ExactMessage, type Id, type JourneyAgentInput, type Role, type Task } from "@petrina/core";
import type { Result } from "./coordination.js";
import { readText } from "./evidence-read.js";
import { saveImmutable } from "./immutable-file.js";

const digest = (text: string) => createHash("sha256").update(text).digest("hex");

/** The folder of a task's exact messages, beside its complete-context packets, so existing cleanup covers both. */
export function exactMessageFolder(dataDir: string, taskId: Id): string | undefined {
  return /^[a-zA-Z0-9_-]+$/.test(taskId) ? join(dataDir, "contexts", taskId, "messages") : undefined;
}

/** Save the text once, by content, named only once complete. A second identical message shares the file; a failed write or a different saved text leaves the reference absent. */
export async function saveExactMessage(dataDir: string, taskId: Id, text: string): Promise<ExactMessage | undefined> {
  const folder = exactMessageFolder(dataDir, taskId);
  if (!folder) return undefined;
  try {
    const saved = await saveImmutable(folder, "md", text, "The saved message file changed.");
    return { ...saved, size: text.length };
  } catch {
    return undefined;
  }
}

/** Read one seat's saved input, manifest or update, checking the saved file against its recorded identity. */
export async function readExactInput(task: Task, roles: readonly Pick<Role, "id" | "name" | "result">[], args: {
  nodeId: string;
  seat?: string;
  index?: number;
  section: "message" | "manifest" | "update";
  update?: number;
  cursor?: string;
  limit?: number
}): Promise<Result> {
  const node = task.journey?.find((step) => step.id === args.nodeId);
  if (!node) return { outcome: "missing", message: "That journey node does not exist." };
  const inputs = (node.agentInputs ?? []).map((input, index) => ({ input, index, seat: seatOf(input, roles, task) }));
  const onSeat = inputs.filter((entry) => !args.seat || entry.seat === args.seat);
  if (!onSeat.length) return {
    outcome: "unavailable",
    message: args.seat ? "No input is recorded for that seat on this node." : "This node recorded no agent input."
  };
  const chosen = args.index !== undefined ? onSeat[args.index] : onSeat.at(-1);
  if (!chosen) return { outcome: "missing", message: "That input attempt does not exist on this seat." };
  const { input, index, seat } = chosen;
  const identity = {
    seat,
    index,
    attempt: onSeat.indexOf(chosen) + 1,
    roleId: input.roleId,
    profileId: input.profileId,
    ...(input.requestedProfileId ? { requestedProfileId: input.requestedProfileId } : {}),
    mode: input.resumed ? "resumed" : input.mode,
    at: input.at ?? null,
    ...(input.sessionId ? { conversation: input.sessionId } : {})
  };
  if (args.section === "manifest") {
    if (!input.manifest) return {
      outcome: "unavailable",
      ...identity,
      message: "This older input recorded no manifest. Its sections remain readable through journey.node.",
      sections: input.sections.map((section) => ({
      name: section.title,
      size: section.body.length
    }))
    };
    return readText(
      input.manifest,
      args,
      [
      "journey.input",
      task.id,
      args.nodeId,
      index,
      "manifest"
    ],
      {
      ...identity,
      entries: input.manifest.length,
      evidence: "recorded"
    }
    );
  }
  if (args.section === "update") {
    const updates = input.updates ?? [];
    if (!updates.length) return { outcome: "unavailable", ...identity, message: "No later update was sent on this input." };
    const position = args.update ?? updates.length - 1;
    const update = updates[position];
    if (!update) return { outcome: "missing", ...identity, message: "That update does not exist on this input." };
    const meta = {
      ...identity,
      update: position,
      reason: update.reason,
      updatedAt: update.at,
      ...(update.messageId ? { messageId: update.messageId } : {}),
      ...(update.delivery ? { delivery: update.delivery } : {})
    };
    if (update.exact) return readSaved(update.exact, args, ["journey.input", task.id, args.nodeId, index, "update", position], meta);
    return readText(
      update.text,
      args,
      [
      "journey.input",
      task.id,
      args.nodeId,
      index,
      "update",
      position,
      "record"
    ],
      {
      ...meta,
      source: "journey-record",
      evidence: "recorded-text"
    }
    );
  }
  if (!input.exact) return {
    outcome: "unavailable",
    ...identity,
    message: "This older input has no saved exact message. The recorded instructions and sections stay readable through journey.node; they are not the complete text as sent."
  };
  return readSaved(
    input.exact,
    args,
    [
    "journey.input",
    task.id,
    args.nodeId,
    index,
    "message"
  ],
    {
    ...identity,
    ...(input.manifest ? { manifestEntries: input.manifest.length } : {})
  }
  );
}

async function readSaved(exact: ExactMessage, args: { cursor?: string; limit?: number }, scope: unknown, extra: Record<string, unknown>): Promise<Result> {
  let text: string;
  try { text = await readFile(exact.file, "utf8"); }
  catch { return {
    outcome: "unavailable",
    ...extra,
    file: exact.file,
    digest: exact.digest,
    size: exact.size,
    message: "The saved message file is no longer available. Context files follow the task's cleanup; no newer text is substituted."
  }; }
  if (digest(text) !== exact.digest) return {
    outcome: "changed",
    ...extra,
    file: exact.file,
    digest: exact.digest,
    size: exact.size,
    message: "The saved message file does not match its recorded identity, so it is not returned."
  };
  return readText(
    text,
    args,
    [
    scope,
    exact.digest
  ],
    {
    ...extra,
    file: exact.file,
    digest: exact.digest,
    size: exact.size,
    evidence: "exact",
    source: "saved-file"
  }
  );
}

export type { JourneyAgentInput };
