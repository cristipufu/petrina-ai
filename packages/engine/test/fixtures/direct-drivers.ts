import { lstatSync } from "node:fs";
import { FixtureOperations } from "@petrina/test-support/fixture-operations";
import { CLEANUP_MS } from "@petrina/test-support/commands";
import { SLOW } from "@petrina/test-support/slow";
import { registerFixtureRoot } from "@petrina/test-support/fixture-retention";
import { Engine, type EngineOptions } from "../engine.js";
import { removeDir } from "../fixtures.js";

/** removeDir is best effort; disposal is complete only when the private folder is absent. */
export function removeFixtureRoot(root: string): void {
  removeDir(root);
  try { lstatSync(root); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  throw new Error(`Direct-driver fixture could not remove ${root}`);
}

/** Actual Engine generations plus manual operations omitted from the Engine's normal drain. */
export function directDrivers(root: string) {
  registerFixtureRoot(root);
  const active = new Map<Engine, FixtureOperations>();
  const completed = new WeakSet<Engine>();
  let closing = false, constructing = false;
  const deadlines = {
    allowanceMs: CLEANUP_MS * SLOW,
    arm(expired: () => void, ms: number) { const timer = setTimeout(expired, ms); return () => clearTimeout(timer); },
  };
  const owner = new FixtureOperations({
    ...deadlines, label: `Direct-driver fixture at ${root}`,
    stop: async () => {
      const settled = await Promise.allSettled([...active.values()].map(generation => generation.close()));
      const failed = settled.filter(result => result.status === "rejected");
      if (failed.length) throw new AggregateError(failed.map(result => result.reason), "Engine generations could not all be stopped");
    },
    dispose: () => removeFixtureRoot(root),
  });
  // Repository/peer setup can own native work before there is an Engine generation.
  const prepare = <T>(start: () => Promise<T>): Promise<T> => owner.run(start);
  const open = (dataDir: string, options: EngineOptions = {}): Engine => {
    if (closing) throw new Error("Direct-driver fixture is closing; no Engine may open");
    if (active.size || constructing) throw new Error("Stop and settle the current Engine before opening its replacement");
    let born!: () => void, failed!: (error: unknown) => void;
    const construction = new Promise<void>((resolve, reject) => { born = resolve; failed = reject; });
    // Constructor callbacks can synchronously reenter close before a generation exists in active.
    // Publish that birth's ownership first, so root cleanup also joins any late-born shutdown.
    void owner.run(() => construction).catch(() => undefined);
    constructing = true;
    let engine: Engine;
    try { engine = new Engine(dataDir, options); }
    catch (error) { constructing = false; failed(error); throw error; }
    const generation = new FixtureOperations({
      ...deadlines, label: `Engine generation at ${dataDir}`,
      stop: () => engine.shutdown(),
      dispose: () => { active.delete(engine); completed.add(engine); },
    });
    active.set(engine, generation);
    constructing = false;
    if (closing) {
      void generation.close().then(born, failed);
      throw new Error("Direct-driver fixture closed during Engine construction; no generation may be handed out");
    }
    born();
    return engine;
  };
  const run = <T>(engine: Engine, start: () => Promise<T>): Promise<T> => {
    const generation = active.get(engine);
    if (!generation) return Promise.reject(new Error("Manual work needs an active owned Engine generation"));
    return generation.run(start);
  };
  const stop = (engine: Engine): Promise<void> => {
    if (completed.has(engine)) return Promise.resolve();
    const generation = active.get(engine);
    if (!generation) return Promise.reject(new Error("Cannot stop an unowned Engine generation"));
    return generation.close();
  };
  const close = (): Promise<void> => { closing = true; return owner.close(); };
  return { prepare, open, run, stop, close };
}

/** Observe every fixture owner before reporting any failure; retain shared stand-in folders on uncertainty. */
export async function closeDirectDrivers(owners: Iterable<ReturnType<typeof directDrivers>>): Promise<void> {
  const settled = await Promise.allSettled([...owners].map(owner => owner.close()));
  const failed = settled.filter(result => result.status === "rejected");
  if (failed.length) throw new AggregateError(failed.map(result => result.reason), "Direct-driver fixtures could not all be closed");
}
