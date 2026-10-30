import { cleanupAgents } from "./cleanup-agents.js";
import { Coordination } from "../../src/coordination.js";
import { expect } from "bun:test";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { FileFaults } from "@petrina/test-support/file-faults";
import { createProcessLease, type ProcessLease, type ProcessLeaseProgramOptions } from "@petrina/test-support/process-lease";
import { setupWithCleanup } from "@petrina/test-support/setup-with-cleanup";
import { basename, dirname, join } from "node:path";
import { completeAll, type Task } from "@petrina/core";
import * as gitOps from "@petrina/repositories/git";
import type { Engine, EngineOptions } from "../engine.js";
import { directDrivers } from "./direct-drivers.js";
import { readRef } from "./shared-preparation.js";
import { makeWorld, tempDir, taskOf, until, type World } from "../support.js";

type CleanupOptions = Partial<EngineOptions>;
export interface CleanupWorld extends Omit<World, "start"> {
  readonly faults: FileFaults;
  readonly signal: AbortSignal;
  engine<T>(body: (engine: Engine) => Promise<T>, options?: CleanupOptions): Promise<T>;
  leasedProgram(file: string, body: string, options?: ProcessLeaseProgramOptions): Promise<void>;
}
interface CleanupResources { stopPeers(): void | Promise<void> }
interface Entry { root: string; closed: boolean; close(): Promise<void> }
const closed = () => new Error("Cleanup fixture ownership is closing; no new setup or Engine may start");

export function cleanupFixture() {
  const active = new Set<Entry>(), retained = new Set<string>();
  let accepting = true, closing: Promise<void> | undefined;
  const available = (entry: Entry) => { if (!accepting || entry.closed) throw closed(); };
  const close = (): Promise<void> => {
    if (closing) return closing;
    let done!: () => void, failed!: (error: unknown) => void;
    closing = new Promise<void>((resolve, reject) => { done = resolve; failed = reject; });
    accepting = false;
    const entries = [...active];
    for (const entry of entries) entry.closed = true;
    void completeAll(entries.map(entry => entry.close())).then(() => done(), failed);
    return closing;
  };
  async function world<T>(name: string, body: (world: CleanupWorld) => Promise<T>, resources?: CleanupResources): Promise<T> {
    if (!accepting) throw closed();
    if (typeof body !== "function") throw new TypeError("Cleanup worlds require an owned whole-body callback");
    const root = tempDir(`petrina-cleanup-${name}-`), lifetime = directDrivers(root), controller = new AbortController();
    let lease: ProcessLease | undefined, openingLease: Promise<ProcessLease> | undefined, closing: Promise<void> | undefined;
    const stopPeers = async () => {
      const requests: Promise<unknown>[] = [];
      const request = (effect: () => unknown) => { try { requests.push(Promise.resolve(effect())); } catch (error) { requests.push(Promise.reject(error)); } };
      request(() => controller.abort());
      request(() => resources?.stopPeers());
      request(() => lease?.close());
      await completeAll(requests);
    };
    const entry: Entry = { root, closed: false, close() {
      if (closing) return closing;
      let done!: () => void, failed!: (error: unknown) => void;
      closing = new Promise<void>((resolve, reject) => { done = resolve; failed = reject; });
      entry.closed = true;
      // Register peer settlement before stop effects, so root disposal also waits for it.
      const peers = lifetime.prepare(stopPeers);
      const rootClosed = lifetime.close();
      void completeAll([peers, rootClosed]).then(() => { active.delete(entry); done(); }, error => { active.delete(entry); retained.add(root); failed(error); });
      return closing;
    } };
    active.add(entry);
    const result = await setupWithCleanup(() => lifetime.prepare(async () => {
      const w = await makeWorld(`cleanup-${name}`, { owner: { root, open: (data, options) => lifetime.open(data, options) } });
      available(entry);
      const faults = new FileFaults();
      // The complete history journey and actual background-build shutdown retain native providers.
      const providers = name === "local" || name === "cancel" ? {} : cleanupAgents(w);
      // The fake builder leaves the same ignored packages/build output as real tools do.
      writeFileSync(join(w.clone, ".git", "info", "exclude"), "node_modules/\ntarget/\n");
      const cache = join(w.dir, "shared-cache");
      mkdirSync(cache);
      writeFileSync(join(cache, "keep"), "shared");
      w.setScript((script) => (script.installs = { cache }));
      const { start, ...visible } = w;
      const fixture: CleanupWorld = { ...visible, faults, signal: controller.signal,
        engine: async <V>(run: (engine: Engine) => Promise<V>, options: CleanupOptions = {}): Promise<V> => {
          available(entry);
          if (controller.signal.aborted) throw closed();
          const engine = start({ files: faults.files, ...providers, ...options });
          const value = await setupWithCleanup(() => lifetime.run(engine, () => run(engine)), () => completeAll([stopPeers(), lifetime.stop(engine)]).then(() => undefined));
          await lifetime.stop(engine);
          return value;
        },
        leasedProgram: (file, body, options) => {
          available(entry);
          if (controller.signal.aborted) throw closed();
          return lifetime.prepare(async () => {
            openingLease ??= createProcessLease().then(async opened => {
              lease = opened;
              if (entry.closed || controller.signal.aborted) { await opened.close(); throw closed(); }
              return opened;
            });
            const current = await openingLease;
            available(entry);
            if (controller.signal.aborted) throw closed();
            writeFileSync(file, current.program(body, options));
          });
        },
      };
      available(entry);
      return body(fixture);
    }), () => entry.close());
    await entry.close();
    return result;
  }
  return { world, close, retained };
}

export const texts = (task: Task) => task.timeline.map((entry) => entry.text);

export const cleaned = async (engine: Engine, id: string) => taskOf(await until(engine, (s) => taskOf(s, id).cleanup?.removedAt !== undefined), id);

export const listed = async (w: Pick<World, "clone">, path: string) => {
  // Git lists native names; the fixture may use a Windows short name or another parent alias.
  // The copy itself may already be gone, so resolve the parent without following a replacement link.
  const nativeParent = (path: string): string => {
    try { return realpathSync.native(path); }
    catch { return join(nativeParent(dirname(path)), basename(path)); }
  };
  const location = (path: string) => join(nativeParent(dirname(path)), basename(path));
  return [w.clone, ...(await gitOps.linkedWorktrees(w.clone))].some((entry) => location(entry) === location(path));
};

export async function expectUnconfirmed(engine: Engine, taskId: string): Promise<void> {
  const c = new Coordination(engine);
  expect((await c.call("task.inspect", { taskId })).task).toMatchObject({ landing: "marked-done", deliveryConfirmed: false });
  expect((await c.call("task.history", { taskId })).items).toEqual([expect.objectContaining({ landing: "marked-done", deliveryConfirmed: false })]);
  for (const condition of ["delivered", "landed"]) expect((await c.call("watch.wait", { target: "task", taskId, condition, timeoutMs: 0 })).outcome).toBe("timed-out");
}

export async function gone(w: Pick<World, "clone" | "dir">, task: Task): Promise<void> {
  expect(existsSync(task.worktree!), `${task.id}: ${task.worktree} ${JSON.stringify(task.cleanup)}`).toBe(false);
  expect(await listed(w, task.worktree!)).toBe(false);
  expect(readRef(join(w.clone, ".git"), `refs/heads/${task.branch!}`)).toMatch(/^[a-f0-9]{40}$/);
  expect(readFileSync(join(w.dir, "shared-cache", "keep"), "utf8")).toBe("shared");
}
