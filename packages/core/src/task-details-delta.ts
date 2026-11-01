import type { Id, JourneyStep, SessionLine, Task, TimelineEntry } from "./model.js";
import type { PublicRecording } from "./public-messages.js";

export const TASK_DETAIL_ONLY_KEYS = [
  "session",
  "timeline",
  "journey",
  "designSessions",
  "reviewSessions",
  "handedBack",
] as const;
export type TaskDetailOnlyKey = (typeof TASK_DETAIL_ONLY_KEYS)[number];
export type TaskDetailsSummary = Omit<Task, TaskDetailOnlyKey>;

const PUBLIC_RECORDING_SIGNATURE_KEYS: Readonly<Record<keyof PublicRecording, true>> = {
  recordedLength: true,
  originalLength: true,
  complete: true,
  state: true,
  reason: true,
  revision: true,
};
void PUBLIC_RECORDING_SIGNATURE_KEYS;

const SESSION_LINE_SIGNATURE_KEYS: Readonly<Record<keyof SessionLine, true>> = {
  id: true,
  at: true,
  from: true,
  roleId: true,
  profileId: true,
  productId: true,
  text: true,
  recording: true,
  coordinatorMessageId: true,
  step: true,
  images: true,
  toolInvocationId: true,
  inputIndex: true,
};
void SESSION_LINE_SIGNATURE_KEYS;

export function sessionLineSignature(line: SessionLine, hashText: (text: string) => string): string {
  const recording = line.recording
    ? `${line.recording.revision}:${line.recording.state}:${line.recording.recordedLength}:${line.recording.originalLength ?? ""}:${line.recording.reason ?? ""}:${line.recording.complete ?? ""}`
    : "";
  return `${line.id}:${line.at}:${line.from}:${hashText(line.text)}:${recording}:${line.roleId ?? ""}:${line.profileId ?? ""}:${line.productId ?? ""}:${line.coordinatorMessageId ?? ""}:${line.step ?? ""}:${line.toolInvocationId ?? ""}:${line.inputIndex ?? ""}:${line.images ? JSON.stringify(line.images) : ""}`;
}

export function omittedTaskDetailsPayload(task: Task): readonly unknown[] {
  return [
    task.timeline,
    task.journey,
    task.designSessions,
    task.reviewSessions,
    task.handedBack,
    task.hunt?.findingChecks,
  ];
}

export interface KeyedListDelta<T extends { readonly id: Id }> {
  readonly replace?: readonly T[];
  readonly order?: readonly Id[];
  readonly upserts: readonly T[];
}

export interface JourneyStepsDelta {
  readonly cleared?: true;
  readonly length?: number;
  readonly steps?: readonly { readonly index: number; readonly step: JourneyStep }[];
}

export interface TaskDetailsExtrasDelta {
  readonly designSessions?: { readonly value: Task["designSessions"] };
  readonly reviewSessions?: { readonly value: Task["reviewSessions"] };
  readonly handedBack?: { readonly value: Task["handedBack"] };
  readonly findingChecks?: { readonly value: NonNullable<Task["hunt"]>["findingChecks"] };
}

export type TaskDetailsUpdate =
  | { readonly kind: "unchanged"; readonly detailsRevision: string }
  | { readonly kind: "full"; readonly task: Task }
  | {
      readonly kind: "delta";
      readonly baseRevision: string;
      readonly detailsRevision: string;
      readonly summary: TaskDetailsSummary;
      readonly session?: KeyedListDelta<SessionLine>;
      readonly timeline?: KeyedListDelta<TimelineEntry>;
      readonly journey?: JourneyStepsDelta;
      readonly extras?: TaskDetailsExtrasDelta;
    };

export interface TaskDetailsBase {
  readonly detailsRevision: string;
  readonly sessionIds: readonly Id[];
  readonly sessionUnique: boolean;
  readonly sessionJson: ReadonlyMap<Id, string>;
  readonly timelineIds: readonly Id[];
  readonly timelineUnique: boolean;
  readonly timelineJson: ReadonlyMap<Id, string>;
  readonly journeyJson: readonly string[] | undefined;
  readonly designSessionsJson: string;
  readonly reviewSessionsJson: string;
  readonly handedBackJson: string;
  readonly findingChecksJson: string;
}

export function stableJson(value: unknown): string {
  return value === undefined ? "undefined" : JSON.stringify(value);
}

export interface CapturedKeyedList {
  readonly ids: readonly Id[];
  readonly unique: boolean;
  readonly json: ReadonlyMap<Id, string>;
}

export function captureKeyedList<T extends { readonly id: Id }>(items: readonly T[]): {
  ids: Id[];
  unique: boolean;
  json: Map<Id, string>;
} {
  const ids: Id[] = [];
  const json = new Map<Id, string>();
  let unique = true;
  for (const item of items) {
    ids.push(item.id);
    if (json.has(item.id)) unique = false;
    json.set(item.id, JSON.stringify(item));
  }
  return { ids, unique, json };
}

export function captureTaskDetailsBase(task: Task): TaskDetailsBase {
  const session = captureKeyedList(task.session);
  const timeline = captureKeyedList(task.timeline);
  return {
    detailsRevision: task.detailsRevision ?? "",
    sessionIds: session.ids,
    sessionUnique: session.unique,
    sessionJson: session.json,
    timelineIds: timeline.ids,
    timelineUnique: timeline.unique,
    timelineJson: timeline.json,
    journeyJson: task.journey ? task.journey.map((step) => JSON.stringify(step)) : undefined,
    designSessionsJson: stableJson(task.designSessions),
    reviewSessionsJson: stableJson(task.reviewSessions),
    handedBackJson: stableJson(task.handedBack),
    findingChecksJson: stableJson(task.hunt?.findingChecks),
  };
}

export function diffKeyedList<T extends { readonly id: Id }>(
  previousIds: readonly Id[],
  previousUnique: boolean,
  previousJson: ReadonlyMap<Id, string>,
  current: readonly T[],
): { delta?: KeyedListDelta<T>; ids: Id[]; unique: boolean; json: Map<Id, string> } {
  const ids: Id[] = [];
  const json = new Map<Id, string>();
  const upserts: T[] = [];
  let unique = true;
  for (const item of current) {
    ids.push(item.id);
    if (json.has(item.id)) unique = false;
    const serialized = JSON.stringify(item);
    json.set(item.id, serialized);
    if (previousJson.get(item.id) !== serialized) upserts.push(item);
  }
  if (!previousUnique || !unique) {
    return { delta: { replace: current, upserts: [] }, ids, unique, json };
  }
  const pureAppend =
    ids.length >= previousIds.length && previousIds.every((id, index) => ids[index] === id);
  if (pureAppend && upserts.length === 0) {
    return { ids, unique, json };
  }
  return {
    delta: pureAppend ? { upserts } : { order: ids, upserts },
    ids,
    unique,
    json,
  };
}

export function stripTaskDetailsSummary(task: Task): TaskDetailsSummary {
  const {
    session: _session,
    timeline: _timeline,
    journey: _journey,
    designSessions: _designSessions,
    reviewSessions: _reviewSessions,
    handedBack: _handedBack,
    ...rest
  } = task;
  if (!rest.hunt) return rest;
  const { findingChecks: _findingChecks, ...hunt } = rest.hunt;
  return { ...rest, hunt };
}

export function diffTaskDetails(
  base: TaskDetailsBase,
  current: Task,
): { update: TaskDetailsUpdate; nextBase: TaskDetailsBase } {
  const detailsRevision = current.detailsRevision ?? "";
  if (detailsRevision && detailsRevision === base.detailsRevision) {
    return {
      update: { kind: "unchanged", detailsRevision },
      nextBase: base,
    };
  }
  const session = diffKeyedList(base.sessionIds, base.sessionUnique, base.sessionJson, current.session);
  const timeline = diffKeyedList(base.timelineIds, base.timelineUnique, base.timelineJson, current.timeline);

  let journeyDelta: JourneyStepsDelta | undefined;
  let journeyJson: string[] | undefined;
  if (!current.journey) {
    if (base.journeyJson !== undefined) journeyDelta = { cleared: true };
  } else {
    journeyJson = [];
    const steps: { index: number; step: JourneyStep }[] = [];
    for (let index = 0; index < current.journey.length; index++) {
      const step = current.journey[index]!;
      const serialized = JSON.stringify(step);
      journeyJson.push(serialized);
      if (base.journeyJson?.[index] !== serialized) steps.push({ index, step });
    }
    const previousLength = base.journeyJson?.length ?? -1;
    if (steps.length > 0 || current.journey.length !== previousLength) {
      journeyDelta = {
        length: current.journey.length,
        ...(steps.length > 0 ? { steps } : {}),
      };
    }
  }

  const designSessionsJson = stableJson(current.designSessions);
  const reviewSessionsJson = stableJson(current.reviewSessions);
  const handedBackJson = stableJson(current.handedBack);
  const findingChecksJson = stableJson(current.hunt?.findingChecks);

  const extras: {
    designSessions?: { readonly value: Task["designSessions"] };
    reviewSessions?: { readonly value: Task["reviewSessions"] };
    handedBack?: { readonly value: Task["handedBack"] };
    findingChecks?: { readonly value: NonNullable<Task["hunt"]>["findingChecks"] };
  } = {};
  if (designSessionsJson !== base.designSessionsJson) extras.designSessions = { value: current.designSessions };
  if (reviewSessionsJson !== base.reviewSessionsJson) extras.reviewSessions = { value: current.reviewSessions };
  if (handedBackJson !== base.handedBackJson) extras.handedBack = { value: current.handedBack };
  if (findingChecksJson !== base.findingChecksJson) extras.findingChecks = { value: current.hunt?.findingChecks };
  const hasExtras = Object.keys(extras).length > 0;

  const nextBase: TaskDetailsBase = {
    detailsRevision,
    sessionIds: session.ids,
    sessionUnique: session.unique,
    sessionJson: session.json,
    timelineIds: timeline.ids,
    timelineUnique: timeline.unique,
    timelineJson: timeline.json,
    journeyJson,
    designSessionsJson,
    reviewSessionsJson,
    handedBackJson,
    findingChecksJson,
  };

  return {
    update: {
      kind: "delta",
      baseRevision: base.detailsRevision,
      detailsRevision,
      summary: stripTaskDetailsSummary(current),
      ...(session.delta ? { session: session.delta } : {}),
      ...(timeline.delta ? { timeline: timeline.delta } : {}),
      ...(journeyDelta ? { journey: journeyDelta } : {}),
      ...(hasExtras ? { extras } : {}),
    },
    nextBase,
  };
}

export function applyKeyedListDelta<T extends { readonly id: Id }>(
  previous: readonly T[],
  delta: KeyedListDelta<T> | undefined,
): readonly T[] {
  if (!delta) return previous;
  if (delta.replace) return delta.replace;
  const byId = new Map<Id, T>();
  const existingIds = new Set<Id>();
  for (const item of previous) {
    byId.set(item.id, item);
    existingIds.add(item.id);
  }
  for (const item of delta.upserts) byId.set(item.id, item);
  if (delta.order) {
    return delta.order.map((id) => {
      const item = byId.get(id);
      if (!item) throw new Error(`Missing task detail record '${id}' during delta merge.`);
      return item;
    });
  }
  const updatedExisting = previous.map((item) => byId.get(item.id) ?? item);
  const appended = delta.upserts.filter((item) => !existingIds.has(item.id));
  return appended.length > 0 ? [...updatedExisting, ...appended] : updatedExisting;
}

function applyJourneyDelta(
  previous: readonly JourneyStep[] | undefined,
  delta: JourneyStepsDelta | undefined,
): readonly JourneyStep[] | undefined {
  if (!delta) return previous;
  if (delta.cleared) return undefined;
  const targetLength = delta.length ?? previous?.length ?? 0;
  const next = (previous ?? []).slice(0, targetLength);
  for (const entry of delta.steps ?? []) {
    next[entry.index] = entry.step;
  }
  return next;
}

export function applyTaskDetailsUpdate(previous: Task, update: TaskDetailsUpdate): Task {
  if (update.kind === "unchanged") {
    return previous.detailsRevision === update.detailsRevision
      ? previous
      : { ...previous, detailsRevision: update.detailsRevision };
  }
  if (update.kind === "full") return update.task;
  if (previous.detailsRevision !== update.baseRevision) {
    throw new Error(
      `Task details delta base mismatch (expected ${update.baseRevision}, held ${previous.detailsRevision ?? "none"}).`,
    );
  }
  const session = applyKeyedListDelta(previous.session, update.session);
  const timeline = applyKeyedListDelta(previous.timeline, update.timeline);
  const journey = applyJourneyDelta(previous.journey, update.journey);
  const designSessions =
    update.extras?.designSessions !== undefined ? update.extras.designSessions.value : previous.designSessions;
  const reviewSessions =
    update.extras?.reviewSessions !== undefined ? update.extras.reviewSessions.value : previous.reviewSessions;
  const handedBack =
    update.extras?.handedBack !== undefined ? update.extras.handedBack.value : previous.handedBack;
  const findingChecks =
    update.extras?.findingChecks !== undefined ? update.extras.findingChecks.value : previous.hunt?.findingChecks;
  const hunt = update.summary.hunt
    ? findingChecks !== undefined
      ? { ...update.summary.hunt, findingChecks }
      : update.summary.hunt
    : undefined;

  const { hunt: _summaryHunt, ...summaryWithoutHunt } = update.summary;
  return {
    ...summaryWithoutHunt,
    detailsRevision: update.detailsRevision,
    session,
    timeline,
    ...(hunt !== undefined ? { hunt } : {}),
    ...(journey !== undefined ? { journey } : {}),
    ...(designSessions !== undefined ? { designSessions } : {}),
    ...(reviewSessions !== undefined ? { reviewSessions } : {}),
    ...(handedBack !== undefined ? { handedBack } : {}),
  };
}
