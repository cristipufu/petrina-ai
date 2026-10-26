import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { setupWithCleanup } from "@petrina/test-support/setup-with-cleanup";
import type { Engine, EngineOptions } from "../engine.js";
import { Fakes, coordinator, git, gitWith, itemOf, makeWorld, REPO, taskOf, tempDir, until, type World } from "../support.js";
import { closeDirectDrivers, directDrivers } from "./direct-drivers.js";
import type { Scenario } from "../fake-agent.js";

type SourceWorld = Omit<World, "start">;
interface SourceFixture {
  w: SourceWorld;
  fakes: Fakes;
  /** Explicit options preserve the existing native-only callers without adding scripted defaults. */
  engine<T>(body: (engine: Engine) => Promise<T>, options?: EngineOptions): Promise<T>;
}
type Entry = { lifetime: ReturnType<typeof directDrivers>; closed: boolean };
const closed = () => new Error("Source fixture ownership is closing; no world, Engine or callback may start");

export function sourceWorlds() {
  const active = new Set<Entry>();
  let accepting = true, closing: Promise<void> | undefined;
  const available = (entry: Entry) => { if (!accepting || entry.closed) throw closed(); };
  const observeClose = (entry: Entry, work: Promise<void>) => {
    void work.then(() => { active.delete(entry); }, () => undefined);
    return work;
  };
  const closeEntry = (entry: Entry) => { entry.closed = true; return observeClose(entry, entry.lifetime.close()); };
  const close = (): Promise<void> => {
    if (closing) return closing;
    let done!: () => void, failed!: (error: unknown) => void;
    closing = new Promise<void>((resolve, reject) => { done = resolve; failed = reject; });
    accepting = false;
    const entries = [...active];
    for (const entry of entries) entry.closed = true;
    const joined = closeDirectDrivers(entries.map(entry => entry.lifetime));
    for (const entry of entries) observeClose(entry, entry.lifetime.close());
    void joined.then(done, failed);
    return closing;
  };
  const world = async <T>(name: string, body: (fixture: SourceFixture) => Promise<T>, scenario: Scenario = {}, forks: Record<string, string> = {}): Promise<T> => {
    if (!accepting) throw closed();
    if (typeof body !== "function") throw new TypeError("Source fixtures require an owned whole-body callback");
    const root = tempDir(`petrina-source-${name}-`), lifetime = directDrivers(root);
    const entry: Entry = { lifetime, closed: false };
    active.add(entry);
    const result = await setupWithCleanup(() => lifetime.prepare(async () => {
      const w = await makeWorld(`source-${name}`, { owner: { root, open: (data, options) => lifetime.open(data, options) } });
      available(entry);
      const fakes = new Fakes(join(w.dir, "fake"));
      fakes.scenario({ planner: "short", builder: "plain", reopen: "resume", ...scenario });
      const services = scenario.builder === "work" ? {} : sourceAgents(w, fakes);
      const engine: SourceFixture["engine"] = async <Value>(callback: (engine: Engine) => Promise<Value>, options?: EngineOptions): Promise<Value> => {
        available(entry);
        const current = lifetime.open(w.data, options ?? { ...services, agentCommand: () => [process.execPath, join(import.meta.dir, "../fake-agent.ts"), fakes.dir, `--script=${join(w.dir, "agents.json")}`], gh: [process.execPath, join(import.meta.dir, "../fake-gh.ts"), join(w.dir, "github.json"), w.remote], remote: w.remote, sourceRemotes: forks });
        const value = await setupWithCleanup(() => lifetime.run(current, () => callback(current)), () => lifetime.stop(current));
        await lifetime.stop(current);
        return value;
      };
      const { start: _start, ...visible } = w;
      available(entry);
      return body({ w: visible, fakes, engine });
    }), () => closeEntry(entry));
    await closeEntry(entry);
    return result;
  };
  return { world, close };
}

export async function branch(w: SourceWorld, name = "release-2.x", remote = w.remote): Promise<string> {
  await git(w.clone, "switch", "-q", "-c", name);
  writeFileSync(join(w.clone, "source.txt"), "Existing source work\n");
  await git(w.clone, "add", "."); await git(w.clone, "commit", "-qm", "Existing source work");
  const sha = await git(w.clone, "rev-parse", "HEAD");
  await git(w.clone, "push", "-q", remote, name);
  await git(w.clone, "switch", "-q", "main");
  return sha;
}
export async function pull(w: SourceWorld, fork = false): Promise<{ sha: string; remote: string }> {
  const remote = fork ? join(w.dir, "fork.git") : w.remote;
  if (fork) await gitWith({}, "clone", "-q", "--bare", w.remote, remote);
  const sha = await branch(w, "review-work", remote);
  if (fork) await git(w.clone, "push", "-q", w.remote, `${sha}:refs/pull/7/head`);
  else await git(w.clone, "push", "-q", w.remote, "review-work:refs/pull/7/head");
  w.setGitHub((state) => {
    state.forks = fork ? { "contributor/demo": remote } : {};
    state.prs.push({ number: 7, url: `https://github.com/${REPO}/pull/7`, state: "OPEN", title: "Original PR title", body: "Original description", headRefName: "review-work", baseRefName: "main", headRefOid: sha, headRepository: { nameWithOwner: fork ? "contributor/demo" : REPO }, isCrossRepository: fork });
  });
  return { sha, remote };
}
export async function planGate(engine: Engine, id: string) {
  return until(engine, (state) => !!itemOf(state, id, "plan") || taskOf(state, id).state === "failed", coordinator([]));
}
export async function deliveryGate(engine: Engine, id: string) {
  return until(engine, (state) => !!itemOf(state, id, "delivery") || taskOf(state, id).state === "failed", coordinator(["plan", "design"]));
}
/** The task's commit on the product copy. A finished local delivery may already have removed the working copy. */
export function taskCommit(w: SourceWorld, task: { branch?: string }): Promise<string> {
  return git(w.clone, "rev-parse", task.branch!);
}
export async function advance(w: SourceWorld, remote: string, name: string, file = "NEWS.md", content = "New source work\n"): Promise<string> {
  const copy = join(w.dir, `move-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await git(w.dir, "clone", "-q", remote, copy);
  await git(copy, "config", "user.name", "Someone else"); await git(copy, "config", "user.email", "other@example.com");
  await git(copy, "switch", "-q", name);
  writeFileSync(join(copy, file), content);
  await git(copy, "add", "."); await git(copy, "commit", "-qm", "New source work");
  await git(copy, "push", "-q", remote, name);
  return git(copy, "rev-parse", "HEAD");
}

import { sourceAgents } from "./source-agents.js";
