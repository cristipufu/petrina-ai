import { displayTask } from "@petrina/core";
// Shared by the tests: engines run as separate processes, and the delivery tests' world, a product
// with a folder standing in for GitHub, a fake gh and scripted agents. Petrina gets the
// stand-ins only through the Engine's constructor.
import { cpSync, mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { InboxKind, State, Task } from "@petrina/core";
import { Engine, type EngineOptions } from "./engine.js";
import { Store } from "@petrina/storage/store";
import type { AgentScript } from "./fake-agent.js";
import { readGitHub, updateGitHub, writeGitHub, type FakeGitHub } from "./fake-gh.js";
import { writeFixtureJson } from "@petrina/test-support/fixture-json";
export { testGitEnv } from "@petrina/test-support/test-git-env";

export * from "./fixtures.js";
import { ADDRESS, FAKE_AGENT, FAKE_GH, REPO, currentSlow, git, repositorySeed, testBrowserRoot } from "./fixtures.js";

export { EngineProcess, engineProcesses, engineProcessCases, engineEnv } from "./fixtures/engine-processes.js";
export type { EngineProcesses, EngineProcessCases, EngineStartupOptions } from "./fixtures/engine-processes.js";

// ── The delivery tests' world ──────────────────────────────────────────

export interface World {
  dir: string;
  /** The coordinator's clone of the product. */
  clone: string;
  /** The folder standing in for GitHub's copy. */
  remote: string;
  data: string;
  /** main on the stand-in GitHub when the world was made. */
  initial: string;
  /** With `browser`, the world's own parent for its agents' browser folders. The test removes it once its engines stop. */
  browsers?: string;
  /** `extra`: more options for this engine (a shorter once-a-minute check, say). */
  start(extra?: EngineOptions): Engine;
  github(): FakeGitHub;
  setGitHub(change: (state: FakeGitHub) => void): void;
  script(): AgentScript;
  setScript(change: (script: AgentScript) => void): void;
  /** Change the state Petrina saved, between runs. */
  editSaved(change: (state: State) => void): void;
}

/**
 * A product whose GitHub address is acme/demo, with a folder standing in for GitHub, a fake gh and scripted agents.
 * Scripted agents get no browser; with `browser`, they get real ones in the world's own browser folder.
 */
export async function makeWorld(name: string, options: { version?: string; address?: string; objectFormat?: "sha1" | "sha256"; browser?: boolean;
  owner?: { root: string; open(dataDir: string, options: EngineOptions): Engine };
} = {}): Promise<World> {
  const seed = await repositorySeed(options.version, false, options.objectFormat);
  const dir = options.owner?.root ?? mkdtempSync(join(tmpdir(), `petrina-${name}-`));
  const remote = join(dir, "github.git");
  const clone = join(dir, "clone");
  cpSync(seed.origin, remote, { recursive: true });
  cpSync(seed.clone, clone, { recursive: true });
  const address = options.address ?? ADDRESS;
  if (address !== ADDRESS) await git(clone, "remote", "set-url", "origin", address);
  const ghState = join(dir, "github.json");
  writeGitHub(ghState, { repo: REPO, prs: [], releases: [], calls: [] });
  const scriptPath = join(dir, "agents.json");
  writeFixtureJson(scriptPath, {});
  const data = join(dir, "data");
  const browsers = options.browser ? testBrowserRoot() : undefined;
  const open = (dataDir: string, merged: EngineOptions) => options.owner ? options.owner.open(dataDir, merged) : new Engine(dataDir, merged);
  return {
    dir,
    clone,
    remote,
    data,
    initial: seed.head,
    ...(browsers ? { browsers } : {}),
    start: (extra = {}) => open(data, { agentCommand: () => [process.execPath, FAKE_AGENT, `--script=${scriptPath}`], gh: [process.execPath, FAKE_GH, ghState, remote], remote, awakeObserver: () => {}, ...(browsers ? { browser: true, browserTempRoot: browsers } : {}), ...extra }),
    github: () => readGitHub(ghState),
    setGitHub: (change) => updateGitHub(ghState, change),
    script: () => JSON.parse(readFileSync(scriptPath, "utf8")) as AgentScript,
    setScript: (change) => {
      const script = JSON.parse(readFileSync(scriptPath, "utf8")) as AgentScript;
      change(script);
      writeFixtureJson(scriptPath, script, 2);
    },
    editSaved: (change) => {
      const store = new Store(join(data, "petrina.db"));
      let failure: { error: unknown } | undefined;
      try {
        const loaded = store.load()!;
        const state = { ...loaded, tasks: loaded.tasks.map(displayTask) };
        change(state);
        store.save(state);
      } catch (error) { failure = { error }; throw error; }
      finally {
        try { store.close(); }
        catch (error) {
          if (failure) throw new AggregateError([failure.error, error], "Saved fixture edit failed and its Store could not be closed");
          throw error;
        }
      }
    },
  };
}

export const taskOf = (state: State, taskId: string): Task => state.tasks.find((task) => task.id === taskId)!;
export const itemOf = (state: State, taskId: string, kind: InboxKind) => state.inbox.find((item) => item.taskId === taskId && item.kind === kind);

/**
 * Wait for a condition on the engine's state, answering the inbox along the way. A condition or an answer that
 * has to wait (for Git, say) finishes before the next look, and its failure fails the wait. After waiting, an
 * answer decides from `engine.getState()`, not from the snapshot it was given.
 */
export async function until(engine: Engine, done: (state: State) => boolean | Promise<boolean>, respond: (engine: Engine, state: State) => void | Promise<void> = coordinator(), ms = 60_000): Promise<State> {
  const started = Date.now();
  for (;;) {
    const state = engine.getState();
    const finished = done(state);
    if (finished instanceof Promise ? await finished : finished) return state;
    if (Date.now() - started > ms * currentSlow()) throw new Error(`Timed out. Tasks: ${JSON.stringify(state.tasks.map((task) => [task.state, task.statusLine, task.error]))} Inbox: ${JSON.stringify(state.inbox.map((item) => [item.kind, item.title]))}`);
    // A condition that waited answers what the engine shows now, but only the inbox items it judged: an item that
    // arrived meanwhile may be what the condition waits for. One that did not wait answers the state it judged.
    await respond(engine, finished instanceof Promise ? judged(engine.getState(), state) : state);
    await Bun.sleep(40);
  }
}

/** The engine's current state, its inbox limited to the items an earlier snapshot already showed. */
function judged(current: State, seen: State): State {
  const items = new Set(seen.inbox.map((item) => item.id));
  return { ...current, inbox: current.inbox.filter((item) => items.has(item.id)) };
}

/** A coordinator who answers questions with the first option, allows permissions and approves the checkpoints listed. */
export function coordinator(approve: readonly InboxKind[] = ["plan", "design", "delivery"]): (engine: Engine, state: State) => void {
  return (engine, state) => {
    for (const item of state.inbox) {
      if (item.kind === "question") engine.answer(item.id, item.options?.[0] ?? "Yes");
      else if (item.kind === "permission") engine.allow(item.id, "once");
      else if (approve.includes(item.kind)) engine.approve(item.id);
    }
  };
}

const settled = ["pr-open", "done", "failed", "cancelled"];

/** Run a task until it is delivered, stuck or cancelled. */
export function finish(engine: Engine, taskId: string, respond: (engine: Engine, state: State) => void | Promise<void> = coordinator()): Promise<State> {
  return until(engine, (state) => settled.includes(taskOf(state, taskId).state), respond);
}
