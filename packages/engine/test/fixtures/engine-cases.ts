import { setupWithCleanup } from "@petrina/test-support/setup-with-cleanup";
import { tempDir } from "@petrina/test-support/fixtures";
import type { Engine, EngineOptions } from "../engine.js";
import { directDrivers } from "./direct-drivers.js";

type Effect = () => void | Promise<void>;

/** Request every peer before awaiting any of them; undefined is still a rejected outcome. */
async function settle(work: readonly Promise<unknown>[]): Promise<void> {
  const results = await Promise.allSettled(work);
  const errors = results.flatMap(result => result.status === "rejected" ? [result.reason] : []);
  if (errors.length === 1) throw errors[0];
  if (errors.length) throw new AggregateError(errors, "Engine case peers did not all settle");
}
const invoke = (effect: Effect): Promise<void> => {
  try { return Promise.resolve(effect()); } catch (error) { return Promise.reject(error); }
};

export interface EngineCaseOwner {
  readonly root: string;
  readonly signal: AbortSignal;
  check(): void;
  open(dataDir: string, options: EngineOptions): Engine;
  run<T>(engine: Engine, start: () => Promise<T>): Promise<T>;
  prepare<T>(start: () => Promise<T>): Promise<T>;
  stop(engine: Engine): Promise<void>;
  restart(engine: Engine, dataDir: string, options: EngineOptions): Promise<Engine>;
  /** Release gates and stop HTTP peers before requesting Engine shutdown. */
  onStop(effect: Effect): () => Promise<void>;
  /** Close extra records only after the body and all Engine stops have settled. */
  afterBody(effect: Effect): () => Promise<void>;
}

/** One private case lifetime; recipes add only the setup needed by their actual boundary. */
export function engineCaseFixtures() {
  const active = new Set<{ close(): Promise<void> }>(), retained = new Set<string>();
  let accepting = true, closing: Promise<void> | undefined;
  const use = async <T>(prefix: string, body: (owner: EngineCaseOwner) => Promise<T>, policy: { allowOverlap?: true } = {}): Promise<T> => {
    if (!accepting) throw new Error("Engine cases are closing; no case may start");
    const root = tempDir(prefix), lifetime = directDrivers(root, policy), controller = new AbortController();
    const releases: Effect[] = [], finalizers: Effect[] = [];
    const finished = Promise.withResolvers<void>();
    let closed = false, stopped: Promise<void> | undefined;
    const check = () => { if (closed || !accepting) throw new Error("Engine case is closing; no setup or Engine may start"); };
    const entry = { close(): Promise<void> {
      if (stopped) return stopped;
      const result = Promise.withResolvers<void>(); stopped = result.promise;
      closed = true;
      controller.abort();
      // Registration precedes close; release errors cannot prevent any generation's stop request.
      const released = lifetime.prepare(() => settle(releases.map(invoke)));
      const generations = lifetime.stopAll();
      // This owned finalizer also runs after a rejected body, while unknown bodies retain resources.
      const finalized = lifetime.prepare(async () => {
        await finished.promise;
        await Promise.allSettled([generations]);
        await settle(finalizers.map(invoke));
      });
      const closedRoot = lifetime.close();
      // Both peers are registered root operations; its bounded close is the sole disposal authority.
      void Promise.allSettled([released, finalized]);
      void closedRoot.then(result.resolve, result.reject);
      void stopped.then(() => active.delete(entry), () => { active.delete(entry); retained.add(root); });
      return stopped;
    } };
    active.add(entry);
    const open = (dataDir: string, options: EngineOptions): Engine => {
      check();
      const engine = lifetime.open(dataDir, options);
      return engine;
    };
    const register = (effects: Effect[], effect: Effect) => {
      check();
      let work: Promise<void> | undefined;
      const request = () => {
        if (work) return work;
        const result = Promise.withResolvers<void>(); work = result.promise;
        void invoke(effect).then(result.resolve, result.reject);
        return work;
      };
      effects.push(request);
      return request;
    };
    const owner: EngineCaseOwner = { root, signal: controller.signal, check, open,
      run: (engine, start) => { check(); return lifetime.run(engine, start); },
      prepare: start => { check(); return lifetime.prepare(start); },
      stop: engine => lifetime.stop(engine),
      restart: (engine, dataDir, options) => lifetime.prepare(async () => { check(); await lifetime.stop(engine); return open(dataDir, options); }),
      onStop: effect => register(releases, effect),
      afterBody: effect => register(finalizers, effect),
    };
    const value = await setupWithCleanup(() => lifetime.prepare(async () => {
      try { check(); return await body(owner); }
      finally { finished.resolve(); }
    }), () => entry.close());
    await entry.close();
    return value;
  };
  return { use, retained,
    close(): Promise<void> {
      if (closing) return closing;
      accepting = false;
      const result = Promise.withResolvers<void>(); closing = result.promise;
      void settle([...active].map(entry => entry.close())).then(result.resolve, result.reject);
      return closing;
    },
  };
}
