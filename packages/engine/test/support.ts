import { displayTask } from "@petrina/core";
// Shared by the tests: engines run as separate processes, and the delivery tests' world, a product
// with a folder standing in for GitHub, a fake gh and scripted agents. Petrina gets the
// stand-ins only through the Engine's constructor.
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { InboxKind, State, Task } from "@petrina/core";
import { Engine, type EngineOptions } from "./engine.js";
import { readConnection } from "../src/instance.js";
import type { ShellMessage } from "../src/launch.js";
import { Store } from "../src/store.js";
import type { AgentScript } from "./fake-agent.js";
import { readGitHub, updateGitHub, writeGitHub, type FakeGitHub } from "./fake-gh.js";
import { testGitEnv } from "./test-git-env.js";
export { testGitEnv } from "./test-git-env.js";

export * from "./fixtures.js";
import { ADDRESS, FAKE_AGENT, FAKE_GH, HARNESS, REPO, currentSlow, firstLine, git, repositorySeed, testBrowserRoot, waitFor } from "./fixtures.js";

// Git's config environment is inherited by child processes even when Bun's mutable process.env is
// cleaned up. Every test Git process gets its own explicitly sanitized environment instead.

type Spawned = ReturnType<typeof spawnEngine>;

/**
 * The environment test engines run in. Git settings passed down through the environment are
 * dropped (inside a Petrina agent they switch pushing off), so Petrina can push to the
 * test's own bare repository wherever the tests run. The coordinator's logins are stand-ins, a
 * GitHub token and an SSH agent, so a fake agent can tell whether it got them.
 */
export function engineEnv(home: string): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...testGitEnv(), PETRINA_HOME: home, GH_TOKEN: "petrina-test-gh-login", SSH_AUTH_SOCK: join(home, "ssh-agent.sock") };
  delete env.GH_CONFIG_DIR;
  return env;
}

export function spawnEngine(args: readonly string[], home: string) {
  return Bun.spawn([process.execPath, ...args], { stdin: "pipe", stdout: "pipe", stderr: "pipe", env: engineEnv(home) });
}

/** An app-mode engine process, and what it told its "shell". */
export class EngineProcess {
  private constructor(
    readonly proc: Spawned,
    readonly hello: ShellMessage,
    readonly home: string,
  ) {}

  static async start(home: string, args: readonly string[]): Promise<EngineProcess> {
    const proc = spawnEngine(args, home);
    const line = await firstLine(proc.stdout);
    if (!line) throw new Error(`The engine said nothing: ${await new Response(proc.stderr).text()}`);
    return new EngineProcess(proc, JSON.parse(line) as ShellMessage, home);
  }

  /** The engine on fake agents, with its fake dir, and the folder standing in for GitHub when there is one. */
  static harness(home: string, dir: string, remote?: string): Promise<EngineProcess> {
    return EngineProcess.start(home, [HARNESS, home, dir, ...(remote ? [remote] : [])]);
  }

  async act(name: string, ...args: unknown[]): Promise<unknown> {
    const { api, token } = readConnection(this.home)!;
    const response = await fetch(`${api}/api/action`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ name, args }) });
    const body = (await response.json()) as { ok: boolean; result?: unknown; error?: string };
    if (!body.ok) throw new Error(`${name} failed: ${body.error}`);
    return body.result;
  }

  /** A WebSocket the way the desktop window opens one: Petrina's own page, the key as a subprotocol. */
  socket(): Promise<WebSocket> {
    const { url, token } = readConnection(this.home)!;
    const socket = new WebSocket(url, { protocols: ["petrina.v1", `petrina.token.${token}`], headers: { origin: "tauri://localhost" } } as unknown as string[]);
    return new Promise((resolve, reject) => {
      socket.onopen = () => resolve(socket);
      socket.onerror = () => reject(new Error("The engine refused the connection"));
    });
  }

  /** The exact bounded snapshot sent to the desktop window. */
  async windowState(): Promise<State> {
    const { api, token } = readConnection(this.home)!;
    return (await (await fetch(`${api}/api/state`, { headers: { authorization: `Bearer ${token}` } })).json()) as State;
  }

  /** Logical engine state for fixture assertions, like Engine.getState(). Window tests use windowState(). */
  async state(): Promise<State> {
    const current = await this.windowState();
    const active = await Promise.all(current.tasks.map((task) => this.act("taskDetails", task.id) as Promise<Task>));
    if (!current.history?.total) return { ...current, tasks: active };
    const { history: _history, ...rest } = current;
    const archived: Task[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.act("historyPage", { limit: 100, ...(cursor ? { cursor } : {}) }) as import("@petrina/core").HistoryPage;
      archived.push(...await Promise.all(page.items.map((item) => this.act("taskDetails", item.id) as Promise<Task>)));
      cursor = page.nextCursor;
    } while (cursor);
    return { ...rest, tasks: [...active, ...archived] };
  }

  async task(id: string): Promise<Task> {
    return await this.act("taskDetails", id) as Task;
  }

  until(check: (state: State) => boolean, what: string, ms = 30_000): Promise<State> {
    return waitFor(async () => {
      const state = await this.state();
      return check(state) ? state : undefined;
    }, what, ms);
  }

  /** The app quits: the line closes, and the engine stops by itself. Returns how long it took. */
  async quit(): Promise<number> {
    const started = Date.now();
    void this.proc.stdin.end();
    await this.exited(10_000);
    return Date.now() - started;
  }

  /** A forced kill: nothing gets saved on the way out. */
  async kill(): Promise<void> {
    this.proc.kill("SIGKILL");
    await this.exited(10_000);
  }

  async exited(ms: number): Promise<number> {
    return Promise.race([this.proc.exited, Bun.sleep(ms).then(() => Promise.reject(new Error(`The engine did not stop within ${ms / 1000} seconds`)))]);
  }
}

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
export async function makeWorld(name: string, options: { version?: string; address?: string; objectFormat?: "sha1" | "sha256"; browser?: boolean } = {}): Promise<World> {
  const seed = await repositorySeed(options.version, false, options.objectFormat);
  const dir = mkdtempSync(join(tmpdir(), `petrina-${name}-`));
  const remote = join(dir, "github.git");
  const clone = join(dir, "clone");
  cpSync(seed.origin, remote, { recursive: true });
  cpSync(seed.clone, clone, { recursive: true });
  const address = options.address ?? ADDRESS;
  if (address !== ADDRESS) await git(clone, "remote", "set-url", "origin", address);
  const ghState = join(dir, "github.json");
  writeGitHub(ghState, { repo: REPO, prs: [], releases: [], calls: [] });
  const scriptPath = join(dir, "agents.json");
  writeFileSync(scriptPath, "{}");
  const data = join(dir, "data");
  const browsers = options.browser ? testBrowserRoot() : undefined;
  return {
    dir,
    clone,
    remote,
    data,
    initial: seed.head,
    ...(browsers ? { browsers } : {}),
    start: (extra = {}) => new Engine(data, { agentCommand: () => [process.execPath, FAKE_AGENT, `--script=${scriptPath}`], gh: [process.execPath, FAKE_GH, ghState, remote], remote, awakeObserver: () => {}, ...(browsers ? { browser: true, browserTempRoot: browsers } : {}), ...extra }),
    github: () => readGitHub(ghState),
    setGitHub: (change) => updateGitHub(ghState, change),
    script: () => JSON.parse(readFileSync(scriptPath, "utf8")) as AgentScript,
    setScript: (change) => {
      const script = JSON.parse(readFileSync(scriptPath, "utf8")) as AgentScript;
      change(script);
      writeFileSync(scriptPath, JSON.stringify(script, null, 2));
    },
    editSaved: (change) => {
      const store = new Store(join(data, "petrina.db"));
      const loaded = store.load()!;
      const state = { ...loaded, tasks: loaded.tasks.map(displayTask) };
      change(state);
      store.save(state);
      store.close();
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
