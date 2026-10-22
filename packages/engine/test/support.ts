import { displayTask } from "@petrina/core";
// Shared by the tests: engines run as separate processes, and the delivery tests' world, a product
// with a folder standing in for GitHub, a fake gh and scripted agents. Petrina gets the
// stand-ins only through the Engine's constructor.
import { setDefaultTimeout } from "bun:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { cpus, loadavg, tmpdir } from "node:os";
import { join, sep } from "node:path";
import type { InboxKind, State, Task } from "@petrina/core";
import { Engine, type EngineOptions } from "../src/engine.js";
import { readConnection } from "../src/instance.js";
import type { ShellMessage } from "../src/launch.js";
import { Store } from "../src/store.js";
import type { AgentScript, Scenario } from "./fake-agent.js";
import { readGitHub, updateGitHub, writeGitHub, type FakeGitHub } from "./fake-gh.js";
import { shortTempParent, TEST_BROWSERS } from "./temp-parent.js";
import { testGitEnv } from "./test-git-env.js";
export { testGitEnv } from "./test-git-env.js";

// Git's config environment is inherited by child processes even when Bun's mutable process.env is
// cleaned up. Every test Git process gets its own explicitly sanitized environment instead.

/**
 * How much longer the time limits are on this machine. A Windows runner takes several times longer to start
 * every engine, agent and git process these tests drive, and so does a machine busy with other work. The limits
 * only catch hangs, so they stretch there; what a test asserts about time (the engine stopping within 10
 * seconds, say) stays as it is.
 */
export let SLOW = Math.max(process.platform === "win32" ? 3 : 1, busy());
let lastLoadSample = Date.now();

/** Keep waits in a test worker proportional as its own parallel work makes the machine busier. */
export function currentSlow(): number {
  const now = Date.now();
  if (now - lastLoadSample >= 1_000) {
    SLOW = Math.max(SLOW, process.platform === "win32" ? 3 : 1, busy());
    lastLoadSample = now;
  }
  return SLOW;
}

/**
 * How much busier than its cores this machine is right now, as a factor for deadlines (1 to 8). Petrina builds
 * itself, so its tests often run while its own agents work on the same machine: a deadline that only holds on
 * an idle machine would fail them for nothing. Windows reports no load, and has its own factor above.
 */
function busy(): number {
  const [load] = loadavg();
  // A test worker often starts several Bun, Git and engine processes at once. On a many-core Mac,
  // waiting until load exceeds the core count misses that I/O and process-start contention. Start
  // stretching waits once the machine is near full, then scale faster as its run queue grows.
  const ratio = (load ?? 0) / Math.max(1, cpus().length);
  return Math.min(8, Math.max(1, Math.ceil(1 + Math.max(0, ratio - 0.75) * 4)));
}
// Bun's per-test deadline is fixed when a test starts, while SLOW can grow as concurrent workers
// make the machine busier. Give it the full documented cap so the adaptive waits below, rather
// than a stale startup sample, decide when a slow process test has really stopped making progress.
setDefaultTimeout(90_000 * 8);

export const CLI = join(import.meta.dir, "../src/cli.ts");
export const HARNESS = join(import.meta.dir, "harness.ts");

export function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/**
 * A fixture's own parent for temporary browser folders, instead of the user's standard one. Run
 * folders can be too long for macOS browser sockets, so the runner owns a short folder for these and
 * reclaims it even after an interrupted run; a standalone script gets one in the system's short
 * temporary folder. Pass it to every engine, browser and recovery of the fixture, and remove it once
 * they have stopped.
 */
export function testBrowserRoot(): string {
  const owned = process.env[TEST_BROWSERS];
  return realpathSync(mkdtempSync(owned ? `${owned}${sep}` : join(shortTempParent(), "pb-")));
}

/** Windows keeps files open a moment after a process ends: cleaning up is best effort. */
export function removeDir(path: string): void {
  try {
    rmSync(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch {
    // Left for the system's temp cleanup.
  }
}

/** Use Bun's native result and a deadline: the Node synchronous wrapper can stall after Git has exited. */
export const git = (cwd: string, ...args: string[]): string => {
  const result = Bun.spawnSync(["git", ...args], { cwd, env: testGitEnv(), stdin: "ignore", stdout: "pipe", stderr: "pipe", windowsHide: true, timeout: 30_000 * SLOW, killSignal: "SIGKILL" });
  const output = result.stdout.toString();
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed (${result.signalCode ?? result.exitCode}):\n${[output, result.stderr.toString()].filter(Boolean).join("\n")}`);
  return output.trim();
};

/** A product with a GitHub-like origin: a bare repository and a clone of it, on main. */
export function makeProduct(root: string): string {
  const seed = repositorySeed(undefined, true);
  const origin = join(root, "origin.git");
  const clone = join(root, "clone");
  mkdirSync(root, { recursive: true });
  cpSync(seed.origin, origin, { recursive: true });
  cpSync(seed.clone, clone, { recursive: true });
  git(clone, "remote", "set-url", "origin", origin);
  return clone;
}

/** Reuse only the immutable starting commit. Each fixture copies its objects, refs and config. */
interface RepositorySeed { path: string; origin: string; clone: string; head: string }
const repositorySeeds = new Map<string, RepositorySeed>();
function repositorySeed(version?: string, versionFile = false, objectFormat?: "sha1" | "sha256"): RepositorySeed {
  const key = JSON.stringify([version ?? "", versionFile, objectFormat]);
  const saved = repositorySeeds.get(key);
  if (saved) return saved;
  const path = tempDir("petrina-repository-seed-");
  const source = join(path, "source"), origin = join(path, "origin.git"), clone = join(path, "clone");
  mkdirSync(source);
  git(source, "init", "-q", "-b", "main", ...(objectFormat ? [`--object-format=${objectFormat}`] : []));
  writeFileSync(join(source, "README.md"), "# Demo\n");
  if (versionFile) writeFileSync(join(source, "VERSION"), "1.0.0\n");
  if (version) writeFileSync(join(source, "package.json"), `${JSON.stringify({ name: "demo", version }, null, 2)}\n`);
  git(source, "add", ".");
  git(source, "-c", "user.email=test@example.com", "-c", "user.name=Test", "commit", "-q", "-m", "init");
  if (versionFile) git(path, "clone", "-q", "--bare", "--no-hardlinks", source, origin);
  else {
    git(path, "init", "-q", "--bare", "-b", "main", ...(objectFormat ? [`--object-format=${objectFormat}`] : []), origin);
    git(source, "push", "-q", origin, "main");
  }
  git(path, "clone", "-q", "--no-hardlinks", "-c", "user.email=test@example.com", "-c", "user.name=Test", origin, clone);
  if (versionFile) git(clone, "remote", "set-url", "origin", ADDRESS);
  else {
    // Worlds originally pushed an initial commit to a bare repository by path, without tracking
    // refs or upstream configuration. Product fixtures are real clones and keep those defaults.
    git(clone, "remote", "remove", "origin");
    git(clone, "remote", "add", "origin", ADDRESS);
  }
  const seed = { path, origin, clone, head: git(source, "rev-parse", "HEAD") };
  repositorySeeds.set(key, seed);
  return seed;
}
// Standalone diagnostic scripts import these helpers too. The parallel runner owns cleanup when
// Bun's isolated workers bypass exit hooks; ordinary scripts clean their seeds on exit.
process.on("exit", () => { for (const seed of repositorySeeds.values()) removeDir(seed.path); });

/**
 * Stops at once, saying why, when this machine holds back programs written a moment ago. Take-over
 * tests write small stand-ins for the launcher and the agent's app and run them. macOS checks each
 * new program before its first run, and when that check hangs, every one of those tests would
 * otherwise wait out its timeout.
 */
export function newProgramsStart(): Promise<void> {
  return (checked ??= startsNewProgram(10_000));
}

let checked: Promise<void> | undefined;

async function startsNewProgram(ms: number): Promise<void> {
  if (process.platform === "win32") return;
  const dir = tempDir("petrina-new-program-");
  const file = join(dir, "new-program");
  writeFileSync(file, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  const proc = Bun.spawn([file], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  const startedAt = Date.now();
  let started = false;
  while (!started && Date.now() - startedAt <= ms * currentSlow()) {
    started = await Promise.race([proc.exited.then(() => true), Bun.sleep(50).then(() => false)]);
  }
  if (!started) proc.kill("SIGKILL");
  removeDir(dir);
  if (!started) {
    throw new Error(
      `This machine did not start a program written a moment ago within ${ms / 1000} seconds, so these tests can't run here. ` +
        "On macOS that is its check of new programs not finishing: allow the app the tests run from (your terminal) in " +
        "System Settings > Privacy & Security > Developer Tools, or restart the Mac, and run them again.",
    );
  }
}

export async function waitFor<T>(check: () => T | undefined | false | Promise<T | undefined | false>, what: string, ms = 30_000): Promise<T> {
  const started = Date.now();
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() - started > ms * currentSlow()) throw new Error(`Timed out waiting for ${what}`);
    await Bun.sleep(50);
  }
}

/** Leave context before a test's own timeout, without changing what it waits for or its deadline. */
export async function traceTaskWait<T>(label: string | undefined, state: () => State | Promise<State>, taskId: string, wait: () => Promise<T>): Promise<T> {
  if (!label) return wait();
  const started = Date.now();
  let finished = false;
  const report = async () => {
    try {
      const current = await state();
      if (finished) return;
      const task = current.tasks.find((entry) => entry.id === taskId);
      console.warn(`Still waiting: ${label}`, JSON.stringify({
        elapsedMs: Date.now() - started, taskId, state: task?.state, status: task?.statusLine, error: task?.error,
        stage: task?.plan?.stages[task.stageIndex]?.title, rounds: task?.rounds,
        agents: [task?.agent, ...(task?.helpers ?? [])].filter(Boolean),
        inbox: current.inbox.filter((item) => item.taskId === taskId).map((item) => ({ kind: item.kind, title: item.title })),
        tools: current.setup?.checks,
      }));
    } catch { /* Diagnostics must not replace the test's result. */ }
  };
  // This only reports progress; it is not a hang deadline and never ends or retries the wait.
  const timer = setInterval(() => void report(), 15_000);
  timer.unref();
  try { return await wait(); }
  finally { finished = true; clearInterval(timer); }
}

/** The first line a process writes to stdout. */
export async function firstLine(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = "";
  while (!text.includes("\n")) {
    const { value, done } = await reader.read();
    if (done) break;
    text += decoder.decode(value);
  }
  reader.releaseLock();
  return text.split("\n")[0]!;
}

type Spawned = ReturnType<typeof spawnEngine>;

export interface Open {
  session: string;
  how: "new" | "resume" | "load";
  tool: string;
  background: boolean;
  logins: boolean;
  quiet: boolean;
  sandbox?: unknown;
  autoMode?: true;
  refused?: true;
}

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

/** A fake dir for one test: scenario, prompts, markers and the fake GitHub. */
export class Fakes {
  constructor(readonly dir: string) {
    mkdirSync(dir, { recursive: true });
  }

  scenario(value: Scenario): void {
    writeFileSync(join(this.dir, "scenario.json"), JSON.stringify(value));
  }

  github(change: (state: FakeGitHub) => void): void {
    const path = join(this.dir, "github.json");
    updateGitHub(path, change);
  }

  marked(name: string): boolean {
    return existsSync(join(this.dir, name));
  }

  /** Every prompt the fake agents received, in order. */
  prompts(role?: string): string[] {
    return this.received(role).map((entry) => entry.text);
  }

  /** Every prompt the fake agents received, in order, with the conversation it went to. */
  received(role?: string): { role: string; session: string; text: string }[] {
    return this.lines<{ role: string; session: string; text: string }>("prompts.jsonl").filter((entry) => !role || entry.role === role);
  }

  /**
   * How each conversation was opened, as which tool: whether its agent ran in the agents' environment (in the
   * background, with the coordinator's logins and nothing that asks), Claude Code's sandbox settings if it was
   * sent them, and whether it refused them.
   */
  opens(): Open[] {
    return this.lines("opens.jsonl");
  }

  /** Every setting Petrina gave a conversation, in order. */
  settings(session: string): string[] {
    return this.lines<{ session: string; configId: string; value: string }>("config.jsonl")
      .filter((entry) => entry.session === session)
      .map((entry) => `${entry.configId}=${entry.value}`);
  }

  /** The tool loses every conversation it had (cleared history, a tool update). */
  forgetConversations(): void {
    removeDir(join(this.dir, "conversations"));
  }

  private lines<T>(name: string): T[] {
    const path = join(this.dir, name);
    if (!existsSync(path)) return [];
    return readFileSync(path, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as T);
  }

  /** The opening prompt of each agent of a role (the ones that say who they are). */
  openings(role: string): string[] {
    return this.prompts(role).filter((text) => /You are the [A-Za-z ]+ in Petrina/.test(text));
  }
}

// ── The delivery tests' world ──────────────────────────────────────────

export const FAKE_AGENT = join(import.meta.dir, "fake-agent.ts");
export const FAKE_GH = join(import.meta.dir, "fake-gh.ts");
export const REPO = "acme/demo";
export const ADDRESS = "https://github.com/acme/demo.git";

/** A ref on the stand-in GitHub, or undefined. */
export const remoteRef = (remote: string, ref: string): string | undefined => {
  try {
    return git(process.cwd(), "--git-dir", remote, "rev-parse", "--verify", "--quiet", `${ref}^{commit}`) || undefined;
  } catch {
    return undefined;
  }
};

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
export function makeWorld(name: string, options: { version?: string; address?: string; objectFormat?: "sha1" | "sha256"; browser?: boolean } = {}): World {
  const seed = repositorySeed(options.version, false, options.objectFormat);
  const dir = mkdtempSync(join(tmpdir(), `petrina-${name}-`));
  const remote = join(dir, "github.git");
  const clone = join(dir, "clone");
  cpSync(seed.origin, remote, { recursive: true });
  cpSync(seed.clone, clone, { recursive: true });
  const address = options.address ?? ADDRESS;
  if (address !== ADDRESS) git(clone, "remote", "set-url", "origin", address);
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

/** Wait for a condition on the engine's state, answering the inbox along the way. */
export async function until(engine: Engine, done: (state: State) => boolean, respond: (engine: Engine, state: State) => void = coordinator(), ms = 60_000): Promise<State> {
  const started = Date.now();
  for (;;) {
    const state = engine.getState();
    if (done(state)) return state;
    if (Date.now() - started > ms * currentSlow()) throw new Error(`Timed out. Tasks: ${JSON.stringify(state.tasks.map((task) => [task.state, task.statusLine, task.error]))} Inbox: ${JSON.stringify(state.inbox.map((item) => [item.kind, item.title]))}`);
    respond(engine, state);
    await Bun.sleep(40);
  }
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
export function finish(engine: Engine, taskId: string, respond = coordinator()): Promise<State> {
  return until(engine, (state) => settled.includes(taskOf(state, taskId).state), respond);
}

/** Wait until a file exists (the fake gh writes one when it starts holding). */
export async function waitForFile(path: string, ms = 60_000): Promise<void> {
  const started = Date.now();
  while (!existsSync(path)) {
    if (Date.now() - started > ms * currentSlow()) throw new Error(`Timed out waiting for ${path}`);
    await Bun.sleep(30);
  }
}

/**
 * A real defunct process: finished, but never collected by its parent, which is what a child whose exit
 * the runtime lost looks like to the system. `release` ends the parent, so the system collects it.
 */
export async function defunctProcess(): Promise<{ pid: number; release(): Promise<void> }> {
  const holder = Bun.spawn(["sh", "-c", "sleep 0.05 & echo $!; exec sleep 300"], { stdin: "ignore", stdout: "pipe", stderr: "ignore" });
  const reader = holder.stdout.getReader();
  let text = "";
  while (!text.includes("\n")) {
    const next = await reader.read();
    if (next.done) break;
    text += new TextDecoder().decode(next.value);
  }
  reader.releaseLock();
  const pid = Number(text.trim());
  if (!pid) throw new Error(`No defunct process was started: ${JSON.stringify(text)}`);
  return {
    pid,
    async release() {
      holder.kill("SIGKILL");
      await holder.exited;
    },
  };
}
