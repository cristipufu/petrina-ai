import { useSyncExternalStore } from "react";
import { isTauri } from "@tauri-apps/api/core";
import {
  COMMAND_NAMES, createDemo, createFirstRunDemo, createPortfolioDemo, DEMO_PRODUCTS, demoClones, Simulator,
  type CommandName, type Commands, type HandBackPreview, type Id, type Launched, type State, type WindowCommands,
} from "@petrina/core";
import {
  browserAddress, EngineClient, failureText, newClientId, NOTHING_UNSENT, plainReason,
  type EngineStatus, type FirstTask, type Unsent,
} from "./engine-client";

export { Late, Lost } from "./commandFailures";
export {
  EngineClient, failureText, newClientId, plainReason,
  type EngineStatus, type FirstTask, type Unsent,
};

type Mode = "engine" | "demo";

/** Everything the UI can ask the squad to do: the command table, answered by the engine or by the demo. */
export type Actions = WindowCommands;

interface Store extends Actions {
  image(taskId: Id, imageId: Id): Promise<Blob>;
  getState(): State;
  subscribe(listener: () => void): () => void;
  /** The state is the squad's own: the engine has sent it at least once (the demo always has it). */
  synced(): boolean;
  unsent(): readonly Unsent[];
  /** Send something the engine refused once more. */
  resendUnsent(clientId: string): void;
  /** Let go of something the engine refused. */
  discardUnsent(clientId: string): void;
}

const TICK_MS = 2_200;

function buildWindowCommands(resolve: <K extends CommandName>(name: K) => WindowCommands[K]): WindowCommands {
  const table = {} as Record<CommandName, WindowCommands[CommandName]>;
  for (const name of COMMAND_NAMES) table[name] = resolve(name);
  return table as WindowCommands;
}

/** The real engine: every command over the local API, what the coordinator says through the outbox. */
function engineStore(client: EngineClient): Store {
  const forward = <K extends CommandName>(name: K): WindowCommands[K] =>
    ((...args: Parameters<Commands[K]>) => client.send(name, args)) as WindowCommands[K];
  const commands = buildWindowCommands(forward);
  return {
    ...commands,
    image: client.image,
    answer: client.answer,
    decideForMe: client.decideForMe,
    deny: client.deny,
    requestChanges: client.requestChanges,
    sendMessage: client.sendMessage,
    startFirstTask: client.startFirstTask,
    getState: client.getState,
    subscribe: client.subscribe,
    synced: client.synced,
    unsent: client.unsent,
    resendUnsent: client.resendUnsent,
    discardUnsent: client.discardUnsent,
  };
}

const NOT_IN_DEMO = "Take over works with real agents, not in the demo";

/** Commands the demo answers its own way: the simulator has no engine, terminal or GitHub behind it. */
const DEMO_OWN = {
  checkShipping: () => () => undefined,
  shipAgain: () => () => undefined,
  markDone: () => () => undefined,
  setTerminal: () => () => undefined,
  addProduct: (simulator: Simulator) => async (path: string): Promise<Id> => {
    const setup = simulator.getState().setup;
    const product = setup && DEMO_PRODUCTS.find((entry) => path.trim().replace(/\/+$/, "").endsWith(`/${entry.repo.split("/")[1]}`));
    if (!product) {
      throw new Error(
        !setup
          ? "The demo has fixed products"
          : setup.done
            ? `In the demo, add one of its made-up clones, such as ${demoClones(0)[0]!.path}.`
            : "In the demo, pick one of the clones above.",
      );
    }
    simulator.addProduct(product);
    return product.id;
  },
  checkTools: () => async () => undefined,
  findClones: (simulator: Simulator) => async () =>
    demoClones(Date.now()).filter((clone) => !simulator.getState().products.some((product) => product.repo === clone.repo)),
  pickFolder: (simulator: Simulator) => async (): Promise<string | null> => {
    const clones = demoClones(Date.now());
    const unadded = clones.find((clone) => !simulator.getState().products.some((product) => product.repo === clone.repo));
    return (unadded ?? clones[0])?.path ?? null;
  },
  openGuide: () => () => undefined,
  takeOver: () => async (): Promise<Launched> => { throw new Error(NOT_IN_DEMO); },
  reopenTerminal: () => async (): Promise<Launched> => { throw new Error(NOT_IN_DEMO); },
  handBackPreview: () => async (): Promise<HandBackPreview> => { throw new Error(NOT_IN_DEMO); },
  handBack: () => async () => { throw new Error(NOT_IN_DEMO); },
} satisfies { [K in CommandName]?: (simulator: Simulator) => WindowCommands[K] };

/** Every other command is a Simulator method of the same name: the compiler checks it has them all. */
type Simulated = Exclude<CommandName, keyof typeof DEMO_OWN>;

/** The demo: the simulated squad, in the window. */
function demoStore(simulator: Simulator): Store {
  const simulated: Pick<WindowCommands, Simulated> = simulator;
  const commands = buildWindowCommands(<K extends CommandName>(name: K): WindowCommands[K] => {
    const own = DEMO_OWN[name as keyof typeof DEMO_OWN] as ((simulator: Simulator) => WindowCommands[K]) | undefined;
    if (own) return own(simulator);
    const method = simulated[name as Simulated] as WindowCommands[K];
    return ((...args: Parameters<Commands[K]>) => method.apply(simulator, args)) as WindowCommands[K];
  });
  return {
    ...commands,
    image: async (): Promise<Blob> => { throw new Error("This demo has no saved picture."); },
    getState: () => simulator.getState(),
    subscribe: (listener) => simulator.subscribe(listener),
    synced: () => true,
    unsent: () => NOTHING_UNSENT,
    resendUnsent: () => undefined,
    discardUnsent: () => undefined,
  };
}

function demo() {
  const now = Date.now();
  const variant = new URLSearchParams(window.location.search).get("demo");
  if (variant === "portfolio") return createPortfolioDemo(now);
  if (variant === "first-run") return createFirstRunDemo(now);
  return createDemo(now);
}

/** Inside the desktop app (not a browser). */
export const desktop = isTauri();
const wantsDemo = new URLSearchParams(window.location.search).has("demo");
const address = desktop || wantsDemo ? undefined : browserAddress();
// Vite may refresh a parent component without calling a dependency's disposal hook. Its next
// instance still shares this data, so release the previous connection before creating another.
import.meta.hot?.data?.release?.();
const client = wantsDemo ? undefined : desktop ? new EngineClient({ desktop: true }) : address ? new EngineClient({ desktop: false, address }) : undefined;
export const mode: Mode = client ? "engine" : "demo";
let simulator: Simulator | undefined;
if (!client) {
  const initial = demo();
  simulator = new Simulator(initial.state, {
    triggers: initial.triggers,
    prMergeAfter: 45,
    tickMs: TICK_MS,
    log: initial.log,
    open: initial.open,
    quirks: initial.quirks,
  });
}

/** The squad: the real engine, or the simulated one in demo mode. */
export const sim: Store = client ? engineStore(client) : demoStore(simulator!);

let timer: ReturnType<typeof setInterval> | undefined;

function release(): void {
  client?.keepUnsent();
  client?.dispose();
  if (timer) clearInterval(timer);
  timer = undefined;
}

if (import.meta.hot?.data) {
  import.meta.hot.data.release = release;
  import.meta.hot.dispose(release);
}

export function startClock(): () => void {
  if (simulator && !timer) timer = setInterval(() => simulator!.tick(Date.now()), TICK_MS);
  return () => {
    if (timer) clearInterval(timer);
    timer = undefined;
  };
}

export function useSim(): State {
  return useSyncExternalStore(sim.subscribe, sim.getState);
}

const DEMO_STATUS: EngineStatus = { link: "live", desktop, synced: true };
const getStatus = () => client?.getStatus() ?? DEMO_STATUS;

export function useEngineStatus(): EngineStatus {
  return useSyncExternalStore(sim.subscribe, getStatus);
}

/** What the coordinator said that the engine has not confirmed yet. */
export function useUnsent(): readonly Unsent[] {
  return useSyncExternalStore(sim.subscribe, sim.unsent);
}

/** "Try again" after the engine could not start. */
export function retryEngine(): void {
  client?.retryEngine();
}

/** "Open the demo": only ever the coordinator's choice. What is not sent yet is kept for when the window is back on the engine. */
export function openDemo(): void {
  client?.keepUnsent();
  window.location.replace(`${window.location.pathname}?demo`);
}

/** Back from the demo to the real engine, in the desktop app. */
export function leaveDemo(): void {
  window.location.replace(window.location.pathname);
}
