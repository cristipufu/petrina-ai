import type { Engine, EngineOptions } from "../engine.js";
import { completeAll } from "@petrina/core";
import { setupWithCleanup } from "@petrina/test-support/setup-with-cleanup";
import { makeWorld, tempDir, type World } from "../support.js";
import { directDrivers } from "./direct-drivers.js";

type WorldOptions = Omit<NonNullable<Parameters<typeof makeWorld>[1]>, "owner" | "browser">;
export type NativeWorld = Omit<World, "start" | "browsers">;
export interface NativeWorldFixture {
  world: NativeWorld;
  /** Preserve makeWorld's native scripted-tool defaults and its ordinary option merging. */
  engine<T>(body: (engine: Engine) => Promise<T>, options?: EngineOptions): Promise<T>;
}
interface Entry {
  root: string;
  lifetime: ReturnType<typeof directDrivers>;
  resources?: { stopPeers(): void | Promise<void> };
  closed: boolean;
  closing?: Promise<void>;
}
const unavailable = () => new Error("Native world fixture is closing; no setup, Engine or callback may start");

/** Default Git/GitHub/fake-agent worlds, owned before setup and through every actual generation. */
export function nativeWorldFixtures() {
  const active = new Set<Entry>(), retained = new Set<string>();
  let accepting = true, closing: Promise<void> | undefined;
  const available = (entry: Entry) => { if (!accepting || entry.closed) throw unavailable(); };
  const closeEntry = (entry: Entry): Promise<void> => {
    if (entry.closing) return entry.closing;
    entry.closed = true;
    let done!: () => void, failed!: (error: unknown) => void;
    entry.closing = new Promise<void>((resolve, reject) => { done = resolve; failed = reject; });
    // Register stop work before closing its root; stop callbacks can release operations being joined.
    const peers = entry.resources ? entry.lifetime.prepare(async () => entry.resources!.stopPeers()) : Promise.resolve();
    const stopped = entry.lifetime.close();
    void completeAll([peers, stopped]).then(done, failed);
    void entry.closing.then(() => active.delete(entry), () => { active.delete(entry); retained.add(entry.root); });
    return entry.closing;
  };
  const close = (): Promise<void> => {
    if (closing) return closing;
    accepting = false;
    let done!: () => void, failed!: (error: unknown) => void;
    closing = new Promise<void>((resolve, reject) => { done = resolve; failed = reject; });
    const entries = [...active];
    for (const entry of entries) entry.closed = true;
    void completeAll(entries.map(closeEntry)).then(done, failed);
    return closing;
  };
  async function world<T>(name: string, body: (fixture: NativeWorldFixture) => Promise<T>, options: WorldOptions = {},
    resources?: Entry["resources"]): Promise<T> {
    if (!accepting) throw unavailable();
    const root = tempDir(`petrina-${name}-`), lifetime = directDrivers(root);
    const entry: Entry = { root, lifetime, resources, closed: false };
    active.add(entry);
    const result = await setupWithCleanup(() => lifetime.prepare(async () => {
      const made = await makeWorld(name, { ...options, owner: { root, open: (data, merged) => lifetime.open(data, merged) } });
      available(entry);
      const engine: NativeWorldFixture["engine"] = async <Value>(run: (current: Engine) => Promise<Value>, extra?: EngineOptions): Promise<Value> => {
        available(entry);
        const current = made.start(extra);
        const value = await setupWithCleanup(() => {
          available(entry);
          return lifetime.run(current, () => run(current));
        }, () => lifetime.stop(current));
        await lifetime.stop(current);
        return value;
      };
      const { start: _start, browsers: _browsers, ...visible } = made;
      return body({ world: visible, engine });
    }), () => closeEntry(entry));
    await closeEntry(entry);
    return result;
  }
  return { world, close, retained };
}
