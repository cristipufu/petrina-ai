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

export interface WindowStateExtrasDelta {
  readonly history?: { readonly value?: State["history"] | undefined };
  readonly roleChanges?: { readonly value?: State["roleChanges"] | undefined };
  readonly setup?: { readonly value?: State["setup"] | undefined };
  readonly work?: { readonly value?: State["work"] | undefined };
  readonly followUpPending?: { readonly value?: State["followUpPending"] | undefined };
  readonly profileCatalogSaved?: { readonly value?: State["profileCatalogSaved"] | undefined };
  readonly terminal?: { readonly value?: State["terminal"] | undefined };
  readonly planner?: { readonly value?: State["planner"] | undefined };
}

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
  readonly historyJson: string;
  readonly roleChangesJson: string;
  readonly setupJson: string;
  readonly workJson: string;
  readonly followUpPendingJson: string;
  readonly profileCatalogSavedJson: string;
  readonly terminalJson: string;
  readonly plannerJson: string;
}

function captureOptionalKeyed<T extends { readonly id: Id }>(
  items: readonly T[] | undefined,
): CapturedKeyedList | undefined {
  return items === undefined ? undefined : captureKeyedList(items);
}

export function captureWindowStateBase(state: State): WindowStateBase {
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
    historyJson: stableJson(state.history),
    roleChangesJson: stableJson(state.roleChanges),
    setupJson: stableJson(state.setup),
    workJson: stableJson(state.work),
    followUpPendingJson: stableJson(state.followUpPending),
    profileCatalogSavedJson: stableJson(state.profileCatalogSaved),
    terminalJson: stableJson(state.terminal),
    plannerJson: stableJson(state.planner),
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

  const extras: {
    history?: { readonly value?: State["history"] | undefined };
    roleChanges?: { readonly value?: State["roleChanges"] | undefined };
    setup?: { readonly value?: State["setup"] | undefined };
    work?: { readonly value?: State["work"] | undefined };
    followUpPending?: { readonly value?: State["followUpPending"] | undefined };
    profileCatalogSaved?: { readonly value?: State["profileCatalogSaved"] | undefined };
    terminal?: { readonly value?: State["terminal"] | undefined };
    planner?: { readonly value?: State["planner"] | undefined };
  } = {};
  if (nextBase.historyJson !== base.historyJson) extras.history = { value: current.history };
  if (nextBase.roleChangesJson !== base.roleChangesJson) extras.roleChanges = { value: current.roleChanges };
  if (nextBase.setupJson !== base.setupJson) extras.setup = { value: current.setup };
  if (nextBase.workJson !== base.workJson) extras.work = { value: current.work };
  if (nextBase.followUpPendingJson !== base.followUpPendingJson) {
    extras.followUpPending = { value: current.followUpPending };
  }
  if (nextBase.profileCatalogSavedJson !== base.profileCatalogSavedJson) {
    extras.profileCatalogSaved = { value: current.profileCatalogSaved };
  }
  if (nextBase.terminalJson !== base.terminalJson) extras.terminal = { value: current.terminal };
  if (nextBase.plannerJson !== base.plannerJson) extras.planner = { value: current.planner };
  const hasExtras = Object.keys(extras).length > 0;

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

export function applyWindowStateDelta(previous: State, delta: WindowStateDelta): State {
  const products = applyKeyedListDelta(previous.products, delta.products);
  const roles = applyKeyedListDelta(previous.roles, delta.roles);
  const tools = applyKeyedListDelta(previous.tools, delta.tools);
  const profiles = applyKeyedListDelta(previous.profiles, delta.profiles);
  const tasks = applyKeyedListDelta(previous.tasks, delta.tasks);
  const inbox = applyKeyedListDelta(previous.inbox, delta.inbox);
  const pool = delta.pool ?? previous.pool;

  const retiredProfiles = applyOptionalKeyedList(previous.retiredProfiles, delta.retiredProfiles);
  const routines = applyOptionalKeyedList(previous.routines, delta.routines);
  const backgroundAgents = applyOptionalKeyedList(previous.backgroundAgents, delta.backgroundAgents);
  const terminals = applyOptionalKeyedList(previous.terminals, delta.terminals);
  const extraValidations = applyOptionalKeyedList(previous.extraValidations, delta.extraValidations);

  const history = delta.extras?.history !== undefined ? delta.extras.history.value : previous.history;
  const roleChanges =
    delta.extras?.roleChanges !== undefined ? delta.extras.roleChanges.value : previous.roleChanges;
  const setup = delta.extras?.setup !== undefined ? delta.extras.setup.value : previous.setup;
  const work = delta.extras?.work !== undefined ? delta.extras.work.value : previous.work;
  const followUpPending =
    delta.extras?.followUpPending !== undefined
      ? delta.extras.followUpPending.value
      : previous.followUpPending;
  const profileCatalogSaved =
    delta.extras?.profileCatalogSaved !== undefined
      ? delta.extras.profileCatalogSaved.value
      : previous.profileCatalogSaved;
  const terminal = delta.extras?.terminal !== undefined ? delta.extras.terminal.value : previous.terminal;
  const planner = delta.extras?.planner !== undefined ? delta.extras.planner.value : previous.planner;

  return {
    now: delta.now,
    seq: delta.seq,
    products,
    roles,
    tools,
    profiles,
    tasks,
    inbox,
    pool,
    ...(retiredProfiles !== undefined ? { retiredProfiles } : {}),
    ...(routines !== undefined ? { routines } : {}),
    ...(backgroundAgents !== undefined ? { backgroundAgents } : {}),
    ...(terminals !== undefined ? { terminals } : {}),
    ...(extraValidations !== undefined ? { extraValidations } : {}),
    ...(history !== undefined ? { history } : {}),
    ...(roleChanges !== undefined ? { roleChanges } : {}),
    ...(setup !== undefined ? { setup } : {}),
    ...(work !== undefined ? { work } : {}),
    ...(followUpPending !== undefined ? { followUpPending } : {}),
    ...(profileCatalogSaved !== undefined ? { profileCatalogSaved } : {}),
    ...(terminal !== undefined ? { terminal } : {}),
    ...(planner !== undefined ? { planner } : {}),
  };
}
