import type {
  AgentProfile,
  Id,
  InboxItem,
  Pool,
  Product,
  Role,
  State,
  Task,
  Terminal,
  Tool,
} from "./model.js";
import type { ExtraValidation } from "./extra-validation.js";
import type { Routine } from "./routines.js";
import {
  applyKeyedListDelta,
  captureKeyedList,
  diffKeyedList,
  stableJson,
  type CapturedKeyedList,
  type KeyedListDelta,
} from "./task-details-delta.js";

export type BackgroundAgentSummary = NonNullable<State["backgroundAgents"]>[number];

export interface OptionalKeyedListDelta<T extends { readonly id: Id }> {
  readonly cleared?: true;
  readonly present?: true;
  readonly delta?: KeyedListDelta<T>;
}

const KEYED_STATE_KEYS = ["products", "roles", "tools", "profiles", "tasks", "inbox"] as const;
const OPTIONAL_KEYED_STATE_KEYS = [
  "retiredProfiles",
  "routines",
  "backgroundAgents",
  "terminals",
  "extraValidations",
] as const;
const EXTRA_STATE_KEYS = [
  "history",
  "roleChanges",
  "setup",
  "work",
  "followUpPending",
  "profileCatalogSaved",
  "terminal",
  "planner",
] as const;

type KeyedStateKey = (typeof KEYED_STATE_KEYS)[number];
type OptionalKeyedStateKey = (typeof OPTIONAL_KEYED_STATE_KEYS)[number];
type ExtraStateKey = (typeof EXTRA_STATE_KEYS)[number];
type HandledStateKey = "now" | "seq" | "pool" | KeyedStateKey | OptionalKeyedStateKey | ExtraStateKey;
type MissingStateDeltaKey = Exclude<keyof State, HandledStateKey>;
const EVERY_STATE_KEY_HANDLED: MissingStateDeltaKey extends never ? true : MissingStateDeltaKey = true;
void EVERY_STATE_KEY_HANDLED;

export type WindowStateExtrasDelta = {
  readonly [K in ExtraStateKey]?: { readonly value?: State[K] | undefined };
};

export interface WindowStateDelta {
  readonly now: number;
  readonly seq: number;
  readonly products?: KeyedListDelta<Product>;
  readonly roles?: KeyedListDelta<Role>;
  readonly tools?: KeyedListDelta<Tool>;
  readonly profiles?: KeyedListDelta<AgentProfile>;
  readonly tasks?: KeyedListDelta<Task>;
  readonly inbox?: KeyedListDelta<InboxItem>;
  readonly pool?: Pool;
  readonly retiredProfiles?: OptionalKeyedListDelta<AgentProfile>;
  readonly routines?: OptionalKeyedListDelta<Routine>;
  readonly backgroundAgents?: OptionalKeyedListDelta<BackgroundAgentSummary>;
  readonly terminals?: OptionalKeyedListDelta<Terminal>;
  readonly extraValidations?: OptionalKeyedListDelta<ExtraValidation>;
  readonly extras?: WindowStateExtrasDelta;
}

export interface WindowStateBase {
  readonly products: CapturedKeyedList;
  readonly roles: CapturedKeyedList;
  readonly tools: CapturedKeyedList;
  readonly profiles: CapturedKeyedList;
  readonly tasks: CapturedKeyedList;
  readonly inbox: CapturedKeyedList;
  readonly poolJson: string;
  readonly retiredProfiles: CapturedKeyedList | undefined;
  readonly routines: CapturedKeyedList | undefined;
  readonly backgroundAgents: CapturedKeyedList | undefined;
  readonly terminals: CapturedKeyedList | undefined;
  readonly extraValidations: CapturedKeyedList | undefined;
  readonly extrasJson: Readonly<Record<ExtraStateKey, string>>;
}

function captureOptionalKeyed<T extends { readonly id: Id }>(
  items: readonly T[] | undefined,
): CapturedKeyedList | undefined {
  return items === undefined ? undefined : captureKeyedList(items);
}

export function captureWindowStateBase(state: State): WindowStateBase {
  const extrasJson = {} as Record<ExtraStateKey, string>;
  for (const key of EXTRA_STATE_KEYS) {
    extrasJson[key] = stableJson(state[key]);
  }
  return {
    products: captureKeyedList(state.products),
    roles: captureKeyedList(state.roles),
    tools: captureKeyedList(state.tools),
    profiles: captureKeyedList(state.profiles),
    tasks: captureKeyedList(state.tasks),
    inbox: captureKeyedList(state.inbox),
    poolJson: JSON.stringify(state.pool),
    retiredProfiles: captureOptionalKeyed(state.retiredProfiles),
    routines: captureOptionalKeyed(state.routines),
    backgroundAgents: captureOptionalKeyed(state.backgroundAgents),
    terminals: captureOptionalKeyed(state.terminals),
    extraValidations: captureOptionalKeyed(state.extraValidations),
    extrasJson,
  };
}

function diffCapturedKeyed<T extends { readonly id: Id }>(
  previous: CapturedKeyedList,
  current: readonly T[],
  currentCaptured?: CapturedKeyedList,
): KeyedListDelta<T> | undefined {
  if (!currentCaptured) {
    return diffKeyedList(previous.ids, previous.unique, previous.json, current).delta;
  }
  if (!previous.unique || !currentCaptured.unique) {
    return { replace: current, upserts: [] };
  }
  const upserts: T[] = [];
  for (const item of current) {
    const serialized = currentCaptured.json.get(item.id);
    if (previous.json.get(item.id) !== serialized) {
      upserts.push(item);
    }
  }
  const pureAppend =
    currentCaptured.ids.length >= previous.ids.length
    && previous.ids.every((id, index) => currentCaptured.ids[index] === id);
  if (pureAppend && upserts.length === 0) {
    return undefined;
  }
  return pureAppend ? { upserts } : { order: currentCaptured.ids, upserts };
}

function diffOptionalKeyedList<T extends { readonly id: Id }>(
  previous: CapturedKeyedList | undefined,
  current: readonly T[] | undefined,
  currentCaptured?: CapturedKeyedList | undefined,
): OptionalKeyedListDelta<T> | undefined {
  if (current === undefined) {
    return previous !== undefined ? { cleared: true } : undefined;
  }
  if (previous === undefined) {
    return {
      present: true,
      ...(current.length > 0 ? { delta: { replace: current, upserts: [] } } : {}),
    };
  }
  const delta = diffCapturedKeyed(previous, current, currentCaptured);
  return delta ? { delta } : undefined;
}

type MutableExtrasDelta = {
  -readonly [P in ExtraStateKey]?: { readonly value?: State[P] | undefined };
};

function recordExtraDelta<K extends ExtraStateKey>(
  target: MutableExtrasDelta,
  key: K,
  current: State,
): void {
  const value = current[key];
  (target as Record<ExtraStateKey, { readonly value?: unknown }>)[key] =
    value === undefined ? {} : { value };
}

export function diffWindowState(
  base: WindowStateBase,
  current: State,
  nextBase: WindowStateBase = captureWindowStateBase(current),
): WindowStateDelta {
  const products = diffCapturedKeyed(base.products, current.products, nextBase.products);
  const roles = diffCapturedKeyed(base.roles, current.roles, nextBase.roles);
  const tools = diffCapturedKeyed(base.tools, current.tools, nextBase.tools);
  const profiles = diffCapturedKeyed(base.profiles, current.profiles, nextBase.profiles);
  const tasks = diffCapturedKeyed(base.tasks, current.tasks, nextBase.tasks);
  const inbox = diffCapturedKeyed(base.inbox, current.inbox, nextBase.inbox);
  const poolChanged = nextBase.poolJson !== base.poolJson;

  const retiredProfiles = diffOptionalKeyedList(
    base.retiredProfiles,
    current.retiredProfiles,
    nextBase.retiredProfiles,
  );
  const routines = diffOptionalKeyedList(base.routines, current.routines, nextBase.routines);
  const backgroundAgents = diffOptionalKeyedList(
    base.backgroundAgents,
    current.backgroundAgents,
    nextBase.backgroundAgents,
  );
  const terminals = diffOptionalKeyedList(base.terminals, current.terminals, nextBase.terminals);
  const extraValidations = diffOptionalKeyedList(
    base.extraValidations,
    current.extraValidations,
    nextBase.extraValidations,
  );

  const extras: MutableExtrasDelta = {};
  let hasExtras = false;
  for (const key of EXTRA_STATE_KEYS) {
    if (nextBase.extrasJson[key] !== base.extrasJson[key]) {
      recordExtraDelta(extras, key, current);
      hasExtras = true;
    }
  }

  return {
    now: current.now,
    seq: current.seq,
    ...(products ? { products } : {}),
    ...(roles ? { roles } : {}),
    ...(tools ? { tools } : {}),
    ...(profiles ? { profiles } : {}),
    ...(tasks ? { tasks } : {}),
    ...(inbox ? { inbox } : {}),
    ...(poolChanged ? { pool: current.pool } : {}),
    ...(retiredProfiles ? { retiredProfiles } : {}),
    ...(routines ? { routines } : {}),
    ...(backgroundAgents ? { backgroundAgents } : {}),
    ...(terminals ? { terminals } : {}),
    ...(extraValidations ? { extraValidations } : {}),
    ...(hasExtras ? { extras } : {}),
  };
}

function applyOptionalKeyedList<T extends { readonly id: Id }>(
  previous: readonly T[] | undefined,
  patch: OptionalKeyedListDelta<T> | undefined,
): readonly T[] | undefined {
  if (!patch) return previous;
  if (patch.cleared) return undefined;
  const base = previous ?? (patch.present ? [] : undefined);
  if (!base) return patch.delta ? applyKeyedListDelta([], patch.delta) : [];
  return applyKeyedListDelta(base, patch.delta);
}

function assignExtraStateField<K extends ExtraStateKey>(
  next: State,
  previous: State,
  extras: WindowStateExtrasDelta | undefined,
  key: K,
): void {
  const entry = extras?.[key];
  const value = entry !== undefined ? entry.value : previous[key];
  if (value !== undefined) {
    next[key] = value;
  }
}

export function applyWindowStateDelta(previous: State, delta: WindowStateDelta): State {
  const retiredProfiles = applyOptionalKeyedList(previous.retiredProfiles, delta.retiredProfiles);
  const routines = applyOptionalKeyedList(previous.routines, delta.routines);
  const backgroundAgents = applyOptionalKeyedList(previous.backgroundAgents, delta.backgroundAgents);
  const terminals = applyOptionalKeyedList(previous.terminals, delta.terminals);
  const extraValidations = applyOptionalKeyedList(previous.extraValidations, delta.extraValidations);

  const next: State = {
    now: delta.now,
    seq: delta.seq,
    products: applyKeyedListDelta(previous.products, delta.products),
    roles: applyKeyedListDelta(previous.roles, delta.roles),
    tools: applyKeyedListDelta(previous.tools, delta.tools),
    profiles: applyKeyedListDelta(previous.profiles, delta.profiles),
    tasks: applyKeyedListDelta(previous.tasks, delta.tasks),
    inbox: applyKeyedListDelta(previous.inbox, delta.inbox),
    pool: delta.pool ?? previous.pool,
    ...(retiredProfiles !== undefined ? { retiredProfiles } : {}),
    ...(routines !== undefined ? { routines } : {}),
    ...(backgroundAgents !== undefined ? { backgroundAgents } : {}),
    ...(terminals !== undefined ? { terminals } : {}),
    ...(extraValidations !== undefined ? { extraValidations } : {}),
  };
  for (const key of EXTRA_STATE_KEYS) {
    assignExtraStateField(next, previous, delta.extras, key);
  }
  return next;
}
