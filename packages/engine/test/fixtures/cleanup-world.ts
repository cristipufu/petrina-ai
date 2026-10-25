import { cleanupAgents } from "./cleanup-agents.js";
import { Coordination } from "../../src/coordination.js";
import { afterAll, expect } from "bun:test";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { FileFaults } from "@petrina/test-support/file-faults";
import { basename, dirname, join } from "node:path";
import { type Task } from "@petrina/core";
import type { Engine } from "../engine.js";

import { git, makeWorld, removeDir, taskOf, until, type World } from "../support.js";

export function cleanupFixture() {
  const worlds: World[] = [];

async function world(name: string): Promise<World & { faults: FileFaults }> {
  const w = await makeWorld(`cleanup-${name}`);
  const faults = new FileFaults(), start = w.start;
  // The complete history journey and actual background-build shutdown retain native providers.
  const providers = name === "local" || name === "cancel" ? {} : cleanupAgents(w);
  w.start = options => start({ files: faults.files, ...providers, ...options });
  worlds.push(w);
  // The fake builder leaves the same ignored packages/build output as real tools do.
  writeFileSync(join(w.clone, ".git", "info", "exclude"), "node_modules/\ntarget/\n");
  const cache = join(w.dir, "shared-cache");
  mkdirSync(cache);
  writeFileSync(join(cache, "keep"), "shared");
  w.setScript((script) => (script.installs = { cache }));
  return Object.assign(w, { faults });
}

afterAll(() => { for (const w of worlds) removeDir(w.dir); });
  return { world };
}

export const texts = (task: Task) => task.timeline.map((entry) => entry.text);

export const cleaned = async (engine: Engine, id: string) => taskOf(await until(engine, (s) => taskOf(s, id).cleanup?.removedAt !== undefined), id);

export const listed = async (w: World, path: string) => {
  // Git lists native names; the fixture may use a Windows short name or another parent alias.
  // The copy itself may already be gone, so resolve the parent without following a replacement link.
  const nativeParent = (path: string): string => {
    try { return realpathSync.native(path); }
    catch { return join(nativeParent(dirname(path)), basename(path)); }
  };
  const location = (path: string) => join(nativeParent(dirname(path)), basename(path));
  return (await git(w.clone, "worktree", "list", "--porcelain", "-z")).split("\0").filter((field) => field.startsWith("worktree ")).some((field) => location(field.slice("worktree ".length)) === location(path));
};

export async function expectUnconfirmed(engine: Engine, taskId: string): Promise<void> {
  const c = new Coordination(engine);
  expect((await c.call("task.inspect", { taskId })).task).toMatchObject({ landing: "marked-done", deliveryConfirmed: false });
  expect((await c.call("task.history", { taskId })).items).toEqual([expect.objectContaining({ landing: "marked-done", deliveryConfirmed: false })]);
  for (const condition of ["delivered", "landed"]) expect((await c.call("watch.wait", { target: "task", taskId, condition, timeoutMs: 0 })).outcome).toBe("timed-out");
}

export async function gone(w: World, task: Task): Promise<void> {
  expect(existsSync(task.worktree!), `${task.id}: ${task.worktree} ${JSON.stringify(task.cleanup)}`).toBe(false);
  expect(await listed(w, task.worktree!)).toBe(false);
  expect(await git(w.clone, "rev-parse", task.branch!)).toMatch(/^[a-f0-9]{40}$/);
  expect(readFileSync(join(w.dir, "shared-cache", "keep"), "utf8")).toBe("shared");
}
