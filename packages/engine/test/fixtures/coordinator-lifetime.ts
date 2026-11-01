import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createProcessLease, type ProcessLeaseProgramOptions, type TrackedProcessLease } from "@petrina/test-support/process-lease";
import { setupWithCleanup } from "@petrina/test-support/setup-with-cleanup";
import { waitFor } from "@petrina/test-support/fixtures";
import { engineProcesses, HARNESS, FAKE_AGENT, type EngineProcess } from "../support.js";
import type { EngineHarnessOptions } from "./engine-processes.js";

/** Construct the case owner before asynchronous lease/setup work or any app generation. */
export function coordinatorLifetime(root: string, resources?: { stopPeers(): void | Promise<void> }) {
  let lease: TrackedProcessLease | undefined, entry: string | undefined, actor: string | undefined;
  const pids = join(root, "coordinator-actors"), programs = new Set<string>();
  let leaseStopRequested = false;
  const owners = engineProcesses(root, { async stopPeers() {
    let peers: Promise<void>;
    try { peers = Promise.resolve(resources?.stopPeers()); } catch (error) { peers = Promise.reject(error); }
    const leased = (async () => {
      if (lease) {
        const activeLease = lease;
        const stopping = activeLease.close();
        leaseStopRequested = true;
        await stopping;
        await waitFor(() => !activeLease.actors().some(item => activeLease.isAlive(item)), "all independently owned coordinator wrappers to exit", 5_000);
      }
    })();
    const settled = await Promise.allSettled([peers, leased]);
    const errors = settled.flatMap(result => result.status === "rejected" ? [result.reason] : []);
    if (errors.length) throw new AggregateError(errors, "Coordinator peer ownership could not be confirmed");
  } });
  const available = () => {
    if (owners.signal.aborted) throw new Error("Coordinator fixture is closing; no new actor may start");
    if (!lease || !entry || !actor) throw new Error("Coordinator fixture initialization must finish before using its native programs");
  };
  const program = (name: string, body: string, options?: ProcessLeaseProgramOptions) => {
    if (owners.signal.aborted) throw new Error("Coordinator fixture is closing; no new actor may start");
    if (!lease) throw new Error("Coordinator fixture initialization must finish before writing native programs");
    const path = join(root, name);
    writeFileSync(path, lease.program(`require("node:fs").appendFileSync(${JSON.stringify(pids)}, String(process.pid) + "\\n");\n${body}\nawait new Promise(() => undefined);`, options));
    programs.add(path);
    return path;
  };
  let initialized = false, opened!: () => void, failed!: (error: unknown) => void;
  const ready = new Promise<void>((resolve, reject) => { opened = resolve; failed = reject; });
  void ready.catch(() => undefined);
  const initialize = (): Promise<void> => {
    if (initialized) return ready;
    // Collection owners can publish this synchronous instance before acquisition begins.
    initialized = true;
    void owners.prepare(async () => {
      lease = await createProcessLease();
      if (owners.signal.aborted) { await lease.close(); throw new Error("Coordinator initialization was stopped before native programs were prepared"); }
      entry = program("coordinator-engine.ts", `await import(${JSON.stringify(HARNESS)});`);
      actor = program("coordinator-agent.ts", `await import(${JSON.stringify(FAKE_AGENT)});`);
    }).then(opened, failed);
    return ready;
  };
  const harnessOptions = (options: Pick<EngineHarnessOptions, "entry" | "extra">): EngineHarnessOptions => {
    const starting = options.entry ?? entry!;
    return { entry: starting, extra: [`--agent-program=${actor}`, ...options.extra ?? []],
      ...(programs.has(starting) ? { afterExternalStop: () => leaseStopRequested } : {}) };
  };
  return { get ready() { return initialize(); }, signal: owners.signal,
    prepare: <T>(start: () => Promise<T>) => owners.prepare(start),
    run: <T>(app: EngineProcess, start: () => Promise<T>) => owners.run(app, start),
    get entry() { available(); return entry!; },
    get actor() { available(); return actor!; },
    program,
    start(home: string, argv: readonly string[], env: NodeJS.ProcessEnv = {}, options: { input?: "pipe" | "ignore" } = {}) {
      available(); return owners.command(home, argv, env, { ...options,
        ...(programs.has(argv[0]!) ? { afterExternalStop: () => leaseStopRequested } : {}),
      });
    },
    app(home: string, argv: readonly string[]) {
      return owners.prepare(async () => { await initialize(); return owners.app(home, argv,
        programs.has(argv[0]!) ? { afterExternalStop: () => leaseStopRequested } : undefined); });
    },
    harness(home: string, dir: string, remote?: string, options: Pick<EngineHarnessOptions, "entry" | "extra"> = {}) {
      return owners.prepare(async () => {
        await initialize(); available();
        return owners.harness(home, dir, remote, harnessOptions(options));
      });
    },
    harnessArgs(home: string, dir: string, remote?: string, options: Pick<EngineHarnessOptions, "entry" | "extra"> = {}) {
      return owners.prepare(async () => {
        await initialize(); available();
        return owners.harnessArgs(home, dir, remote, harnessOptions(options));
      });
    },
    close: () => owners.close(),
  };
}
export type CoordinatorLifetime = ReturnType<typeof coordinatorLifetime>;

/** Record the synchronous owner before awaiting initialization, including failed/pending starts. */
export function coordinatorLifetimes() {
  const current: { root: string; lifetime: CoordinatorLifetime }[] = [], retained = new Set<string>();
  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => {
    if (closing) return closing;
    const batch = current.splice(0);
    closing = Promise.resolve().then(async () => {
      const settled = await Promise.allSettled(batch.map(async ({ root, lifetime }) => {
        try { await lifetime.close(); } catch (error) { retained.add(root); throw error; }
      }));
      const errors = settled.flatMap(result => result.status === "rejected" ? [result.reason] : []);
      if (errors.length) throw new AggregateError(errors, "Coordinator cases retained unconfirmed native ownership");
    }).finally(() => { closing = undefined; });
    return closing;
  };
  return { retained,
    async open(root: string, resources?: { stopPeers(): void | Promise<void> }) {
      if (closing) throw new Error("Coordinator fixtures are closing; no new case may open");
      const lifetime = coordinatorLifetime(root, resources);
      current.push({ root, lifetime });
      return setupWithCleanup(async () => { await lifetime.ready; return lifetime; }, async () => {
        try { await lifetime.close(); } catch (error) { retained.add(root); throw error; }
      });
    },
    close,
  };
}
