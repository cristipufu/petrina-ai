import type { DeepMutable } from "./flow.js";
import type { Task } from "./model.js";
import { stepTag } from "./journey.js";

export const MAX_SESSION_LINES = 800;
type SessionLine = DeepMutable<Task["session"][number]>;
type SessionTask = DeepMutable<Pick<Task, "session" | "journey" | "repositories">>;

/** Bind public words to the current step before applying the shared retention rule. */
export function saySessionLine(task: SessionTask, productId: string, from: SessionLine["from"], text: string, roleId: string | undefined, profileId: string | undefined, toolInvocationId: string | undefined, effects: { id(): string; now(): number; pendingReportIds: ReadonlySet<string> }): void {
  const last = task.session.at(-1);
  if (from === "activity" && !toolInvocationId && last?.from === "activity" && last.text === text) return;
  const step = stepTag(task);
  appendSessionLine(task.session, { ...(task.repositories ? { productId } : {}), id: effects.id(), at: effects.now(), from, text, ...(toolInvocationId ? { toolInvocationId } : {}), ...(roleId ? { roleId } : {}), ...(profileId ? { profileId } : {}), ...(step ? { step } : {}) }, effects.pendingReportIds);
}

/** A participant's words retain the matching start even when seats share a role and profile. */
export function bindParticipantSessionLine(task: SessionTask, from: "agent" | "activity", roleId: string, profileId: string, reviewerKey: string | undefined): void {
  const line = task.session.at(-1);
  if (line?.from !== from || line.roleId !== roleId || line.profileId !== profileId) return;
  const index = task.journey?.find((step) => step.id === line.step)?.agentInputs?.findLastIndex((input) => input.roleId === roleId && input.profileId === profileId && input.reviewerKey === reviewerKey) ?? -1;
  if (index >= 0) line.inputIndex = index;
}

/** Preserve reports until their pictures arrive, and the latest words for every participant/product. */
export function appendSessionLine(session: SessionLine[], line: SessionLine, pendingReportIds: ReadonlySet<string>, maximum = MAX_SESSION_LINES): void {
  session.push(line);
  while (session.length > maximum) {
    const index = session.findIndex((line, index) => index < session.length - 1 && !line.images?.length && !pendingReportIds.has(line.id)
      && (line.from !== "agent" || session.some((other, later) => later > index && other.from === "agent" && other.roleId === line.roleId && other.profileId === line.profileId && other.productId === line.productId)));
    if (index < 0) break;
    session.splice(index, 1);
  }
}
