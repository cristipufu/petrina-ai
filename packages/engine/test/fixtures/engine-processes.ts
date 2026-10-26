import type { State, Task } from "@petrina/core";
import { readConnection } from "../../src/instance.js";
import type { ShellMessage } from "../../src/launch.js";
import { testGitEnv } from "@petrina/test-support/test-git-env";
import { CommandFailure, runCommand, CLEANUP_MS, type CommandResult, type Started } from "@petrina/test-support/commands";
import { settleCommandAfterStop } from "@petrina/test-support/command-settlement";
import { FixtureOperations } from "@petrina/test-support/fixture-operations";
import { setupWithCleanup } from "@petrina/test-support/setup-with-cleanup";
import { FALLBACK_TIMEOUT } from "@petrina/test-support/run";
import { join } from "node:path";
import { HARNESS, currentSlow, waitFor } from "../fixtures.js";
import { removeFixtureRoot } from "./direct-drivers.js";

const closeAdmission = Symbol("close case admission before any stop effects");

type Spawned = ReturnType<typeof spawnEngine>;
type NativeSpawned = Bun.Subprocess<"pipe" | "ignore", "pipe" | "ignore", "pipe" | "ignore">;
/** Ordering only: true means this exact actor already received its independent stop request. */
interface ExternalStopOrdering { afterExternalStop?(): boolean }
export interface NativeCommandOptions extends ExternalStopOrdering { input?: "pipe" | "ignore"; output?: "pipe" | "ignore"; errors?: "pipe" | "ignore" }
export interface EngineStartupOptions extends ExternalStopOrdering { startupTimeoutMs?: number; onProcess?: (proc: Spawned) => void }

/** Private test credentials and Git settings; never inherit a coordinator's personal Git configuration. */
export function engineEnv(home: string): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...testGitEnv(), PETRINA_HOME: home, GH_TOKEN: "petrina-test-gh-login", SSH_AUTH_SOCK: join(home, "ssh-agent.sock") };
  delete env.GH_CONFIG_DIR;
  return env;
}

function spawnEngine(args: readonly string[], home: string, detached = false) {
  return Bun.spawn([process.execPath, ...args], { stdin: "pipe", stdout: "pipe", stderr: "pipe", env: engineEnv(home), detached, windowsHide: true });
}

/** One actual command record exists before its starter can re-enter fixture cleanup. */
function ownedCommand(home: string, args: readonly string[], options: {
  afterExternalStop?(): boolean;
  engine: boolean; native?: boolean; env?: NodeJS.ProcessEnv; input?: "pipe" | "ignore"; output?: "pipe" | "ignore"; errors?: "pipe" | "ignore";
  onOutput?: (text: string, stream: "stdout" | "stderr") => undefined;
}) {
  const controller = new AbortController();
  let proc: Spawned | NativeSpawned | undefined, started = false, ready = !options.engine;
  let starter: "not-invoked" | "entered" | "returned" = "not-invoked";
  let resolve!: (result: CommandResult) => void, reject!: (error: unknown) => void;
  const completion = new Promise<CommandResult>((done, failed) => { resolve = done; reject = failed; });
  void completion.catch(() => undefined);
  // This receipt concerns owned work only, independently of its exit code or handshake result.
  const ownership = completion.then(() => undefined, error => {
    if (error instanceof CommandFailure && (error.cleanup === "confirmed"
      || (starter === "not-invoked" && error.cleanup === "none" && (error.reason === "start" || error.reason === "cancelled")))) return;
    throw error;
  });
  void ownership.catch(() => undefined);
  let closing: Promise<void> | undefined;
  const stop = (): Promise<void> => {
    if (closing) return closing;
    let done!: () => void, failed!: (error: unknown) => void;
    closing = new Promise<void>((resolve, reject) => { done = resolve; failed = reject; });
    let externallyStopped = false, orderingFailure: { error: unknown } | undefined;
    try { externallyStopped = options.afterExternalStop?.() === true && started && !!proc && ready; }
    catch (error) { orderingFailure = { error }; }
    // An actual lease stop must settle before a competing abort. This never confirms cleanup:
    // only the original command result/confirmed cleanup can do that. Other raw programs have
    // no EOF contract, and begin canonical cleanup immediately.
    if (orderingFailure || (!externallyStopped && (!ready || !started || !proc || !options.engine))) controller.abort();
    else if (!externallyStopped && proc && proc.exitCode == null && proc.signalCode == null) {
      try { void Promise.resolve(proc.stdin?.end()).catch(() => controller.abort()); }
      catch { controller.abort(); }
    }
    void settleCommandAfterStop({ result: completion, abort: () => controller.abort() }).then(
      () => orderingFailure ? failed(orderingFailure.error) : done(),
      cleanup => failed(orderingFailure ? new AggregateError([orderingFailure.error, cleanup], "External stop ordering failed and command cleanup was not confirmed") : cleanup),
    );
    return closing;
  };
  return {
    get proc() { return proc; }, controller, completion, ownership, stop,
    ready() { ready = true; },
    start() {
      if (started) throw new Error("An owned native command can start only once");
      started = true;
      try {
        const actual = runCommand(options.native ? [...args] : [process.execPath, ...args], {
          env: options.env ?? engineEnv(home), signal: controller.signal, timeoutMs: FALLBACK_TIMEOUT,
          start: (argv, settings) => {
            starter = "entered";
            proc = options.engine ? spawnEngine(args, home, settings.detached)
              : Bun.spawn(argv, { ...settings, stdin: options.native ? options.input ?? "pipe" : "pipe", stdout: options.output ?? "pipe", stderr: options.errors ?? "pipe", windowsHide: true });
            starter = "returned";
            void proc.exited.catch(() => undefined);
            if (!options.native && options.input === "ignore") proc.stdin?.end();
            const child = proc;
            return { pid: child.pid, exited: child.exited,
              ...(child.stdout ? { stdout: child.stdout } : {}), ...(child.stderr ? { stderr: child.stderr } : {}),
              get exitCode() { return child.exitCode; }, get signalCode() { return child.signalCode; }, kill: signal => child.kill(signal),
            } satisfies Started;
          },
          ...(options.onOutput ? { onOutput: options.onOutput } : {}),
        });
        void actual.then(resolve, reject);
      } catch (error) { reject(error); }
    },
  };
}
type OwnedCommand = ReturnType<typeof ownedCommand>;

/** An app-mode engine process, and what it told its shell. Launches require a case owner. */
export class EngineProcess {
  private constructor(
    readonly proc: Spawned,
    readonly hello: ShellMessage,
    readonly home: string,
    private readonly completion: Promise<CommandResult>,
    private readonly controller: AbortController,
  ) {}

  /** Construct ownership synchronously, before any native repository or startup preparation. */
  static fixture(root: string, resources: { stopPeers(): void | Promise<void> } | undefined = undefined) {
    return processFixture(root, resources, (proc, hello, home, completion, controller) => new EngineProcess(proc, hello, home, completion, controller));
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
    }, what, ms, this.hello.type === "ready" && this.hello.owned ? { during: this.completion } : undefined);
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
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([this.completion.then(result => result.code), new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`The engine did not stop within ${ms / 1000} seconds`)), ms);
      })]);
    } catch (error) {
      this.controller.abort();
      const stopped = await this.completion.catch(failure => failure as unknown);
      if (stopped instanceof CommandFailure && stopped.cleanup === "unconfirmed") throw new Error(`${error instanceof Error ? error.message : String(error)}\nEngine fixture cleanup could not be confirmed.`, { cause: stopped });
      throw error;
    } finally { clearTimeout(timer); }
  }

  /** A private external stop was already requested; retain actual fully drained completion before forcing cleanup. */
  settleAfterStop() {
    return settleCommandAfterStop({ result: this.completion, abort: () => this.controller.abort() });
  }

  /** Collected while running, so a full stderr pipe never holds up startup or shutdown. */
  async errors(): Promise<string> { return (await this.completion).stderr; }
}


export interface CoordinatorProcess {
  readonly pid: number;
  readonly exitCode: number | null;
  readonly completion: Promise<CommandResult>;
  readonly exited: Promise<number>;
  readonly stdout: Promise<string>;
  readonly stderr: Promise<string>;
  wait(ms?: number): Promise<number>;
  write(text: string): void;
  endInput(): void;
  line(): Promise<string>;
  kill(signal?: NodeJS.Signals): void;
  settle(): Promise<void>;
  close(): Promise<void>;
}

function coordinatorPeer(command: OwnedCommand, lines: string[]): CoordinatorProcess {
  const { completion } = command;
  const exited = completion.then(result => result.code), stdout = completion.then(result => result.stdout), stderr = completion.then(result => result.stderr);
  void exited.catch(() => undefined); void stdout.catch(() => undefined); void stderr.catch(() => undefined);
  let closing: Promise<void> | undefined, finished: { result: CommandResult } | undefined;
  void completion.then(result => { finished = { result }; }, () => undefined);
  return {
    get pid() { return command.proc!.pid; },
    get exitCode() { return command.proc!.exitCode; },
    completion, exited, stdout, stderr,
    async wait(ms = 10_000) { return (await waitFor(() => finished, "the owned coordinator process to report exit and drain its output", ms, { during: completion })).result.code; },
    write(text) {
      const input = command.proc!.stdin;
      if (!input) throw new Error("The owned native peer has no interactive input");
      input.write(text);
    },
    endInput() { command.proc!.stdin?.end(); },
    line() { return waitFor(() => lines.length ? { text: lines.shift()! } : undefined, "the owned coordinator peer's next output line", undefined, { during: completion }).then(line => line.text); },
    kill(signal = "SIGTERM") {
      const child = command.proc!;
      if (child.exitCode == null && child.signalCode == null) child.kill(signal);
    },
    async settle() { await settleCommandAfterStop({ result: completion, abort: () => command.controller.abort() }); },
    close() { return closing ??= (async () => {
      command.controller.abort();
      try { await completion; }
      catch (error) { if (!(error instanceof CommandFailure) || error.cleanup !== "confirmed") throw error; }
    })(); },
  };
}

type CreateEngine = (proc: Spawned, hello: ShellMessage, home: string, completion: Promise<CommandResult>, controller: AbortController) => EngineProcess;

function processFixture(root: string, resources: { stopPeers(): void | Promise<void> } | undefined, create: CreateEngine) {
  const commands = new Set<OwnedCommand>(), active = new Map<EngineProcess, FixtureOperations>(), stopped = new WeakSet<EngineProcess>(), ended = new WeakSet<EngineProcess>();
  const admission = new AbortController();
  let accepting = true;
  const allowance = {
    allowanceMs: CLEANUP_MS * currentSlow(),
    arm(expired: () => void, ms: number) { const timer = setTimeout(expired, ms); return () => clearTimeout(timer); },
  };
  const finishEvery = async (work: readonly Promise<unknown>[], label: string) => {
    const settled = await Promise.allSettled(work);
    const errors = settled.flatMap(result => result.status === "rejected" ? [result.reason] : []);
    if (errors.length) throw new AggregateError(errors, label);
  };
  const owner = new FixtureOperations({ ...allowance, label: `App-process fixture at ${root}`,
    stop: () => {
      // Request every stop, including peers, before awaiting any one of them.
      const request = (stop: () => void | Promise<unknown>): Promise<unknown> => {
        try { return Promise.resolve(stop()); } catch (error) { return Promise.reject(error); }
      };
      return finishEvery([request(() => resources?.stopPeers()),
        ...[...commands].map(command => request(() => command.stop())),
        ...[...active.values()].map(generation => request(() => generation.close())),
      ], "App-process owners could not all be stopped");
    },
    dispose: () => removeFixtureRoot(root),
  });
  const closed = () => new Error("App-process fixture is closing; no new process or operation may start");
  const prepare = <T>(start: () => Promise<T>): Promise<T> => !accepting || admission.signal.aborted ? Promise.reject(closed()) : owner.run(start);
  const app = (home: string, args: readonly string[], options: EngineStartupOptions = {}): Promise<EngineProcess> => {
    if (!accepting || admission.signal.aborted) return Promise.reject(closed());
    const ms = options.startupTimeoutMs ?? 30_000 * currentSlow();
    if (!(ms > 0 && ms <= 2_147_483_647)) return Promise.reject(new RangeError("Engine fixture startup needs a positive, finite deadline."));
    let output = "", errors = "", supplied = false, first!: (line: string) => void;
    const opening = new Promise<string>(resolve => { first = resolve; });
    const command = ownedCommand(home, args, { engine: true,
      afterExternalStop: () => options.afterExternalStop?.() === true,
      onOutput(chunk, stream) {
        if (stream === "stderr") errors = (errors + chunk).slice(-8000);
        else if (!supplied) {
          output += chunk;
          const end = output.indexOf("\n");
          if (end >= 0) { supplied = true; first(output.slice(0, end)); output = ""; }
        }
      },
    });
    // The ready result and native command have different meanings. Both are owned before
    // the starter/onProcess can reenter close; protocol rejection is still returned unchanged.
    let opened!: (engine: EngineProcess) => void, failed!: (error: unknown) => void;
    const ready = new Promise<EngineProcess>((resolve, reject) => { opened = resolve; failed = reject; });
    const handshakeSettled = ready.then(() => undefined, () => undefined);
    void prepare(() => handshakeSettled).catch(() => undefined);
    void prepare(() => { commands.add(command); command.start(); return command.ownership; }).catch(() => undefined);
    void (async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        if (command.proc) options.onProcess?.(command.proc as Spawned);
        const line = await Promise.race([
          opening,
          command.completion.then(result => {
            if (!result.stdout) throw new Error(`The engine exited with code ${result.code} without a startup answer`);
            return result.stdout.split("\n")[0]!;
          }),
          new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`The engine gave no startup answer within ${ms}ms`)), ms); }),
        ]);
        if (!line) throw new Error("The engine said nothing");
        const hello = JSON.parse(line) as ShellMessage;
        if (!accepting || admission.signal.aborted) { await command.stop(); throw closed(); }
        const engine = create(command.proc! as Spawned, hello, home, command.completion, command.controller);
        command.ready();
        const generation = new FixtureOperations({ ...allowance, label: `App generation at ${home}`,
          stop: () => command.stop(), dispose: () => { active.delete(engine); stopped.add(engine); },
        });
        active.set(engine, generation);
        void command.completion.then(() => { ended.add(engine); }, () => { ended.add(engine); });
        return engine;
      } catch (error) {
        command.controller.abort();
        const ended = await command.completion.catch(failure => failure as unknown);
        const unconfirmed = ended instanceof CommandFailure && ended.cleanup === "unconfirmed";
        throw new Error(`${error instanceof Error ? error.message : String(error)}${errors ? `\n${errors}` : ""}${unconfirmed ? "\nEngine fixture cleanup could not be confirmed." : ""}`, { cause: ended instanceof Error ? ended : error });
      } finally { clearTimeout(timer); }
    })().then(opened, failed);
    return ready;
  };
  const peer = (home: string, args: readonly string[], env: NodeJS.ProcessEnv, options: NativeCommandOptions, native: boolean): CoordinatorProcess => {
    if (!accepting || admission.signal.aborted) throw closed();
    const lines: string[] = [];
    let partial = "";
    const record = ownedCommand(home, args, { engine: false, native, env: { ...engineEnv(home), ...env }, ...options,
      afterExternalStop: () => options.afterExternalStop?.() === true,
      onOutput(text, stream) {
        if (stream !== "stdout") return;
        partial += text;
        for (;;) {
          const at = partial.indexOf("\n");
          if (at < 0) break;
          lines.push(partial.slice(0, at)); partial = partial.slice(at + 1);
        }
      },
    });
    void prepare(() => { commands.add(record); record.start(); return record.ownership; }).catch(() => undefined);
    return coordinatorPeer(record, lines);
  };
  const run = <T>(engine: EngineProcess, start: () => Promise<T>): Promise<T> => {
    if (!accepting || admission.signal.aborted) return Promise.reject(closed());
    const generation = ended.has(engine) ? undefined : active.get(engine);
    return generation ? generation.run(start) : Promise.reject(new Error("Manual app work needs its exact active owned generation"));
  };
  const stop = (engine: EngineProcess): Promise<void> => {
    if (stopped.has(engine)) return Promise.resolve();
    const generation = active.get(engine);
    return generation ? generation.close() : Promise.reject(new Error("Cannot stop an unowned app generation"));
  };
  const close = (): Promise<void> => { accepting = false; admission.abort(); return owner.close(); };
  return { [closeAdmission]: () => { accepting = false; }, signal: admission.signal, prepare, app, harness: (home: string, dir: string, remote?: string) => app(home, [HARNESS, home, dir, ...(remote ? [remote] : [])]),
    command: (home: string, args: readonly string[], env: NodeJS.ProcessEnv = {}, options: Pick<NativeCommandOptions, "input" | "afterExternalStop"> = {}) => peer(home, args, env, options, false),
    nativeCommand: (home: string, argv: readonly string[], env: NodeJS.ProcessEnv = {}, options: NativeCommandOptions = {}) => peer(home, argv, env, options, true),
    run, stop, close };

}

/** Every app launch belongs to its case before startup and every later setup await. */
export function engineProcesses(root: string, resources?: { stopPeers(): void | Promise<void> }) {
  return EngineProcess.fixture(root, resources);
}
export type EngineProcesses = ReturnType<typeof engineProcesses>;

/** File-local active owners: install close in the appropriate non-peer-closing test hook. */
export function engineProcessCases() {
  const active = new Set<{ root: string; owner: EngineProcesses; close(): Promise<void> }>();
  const retained = new Set<string>();
  let closing: Promise<void> | undefined;
  const open = (root: string, resources?: { stopPeers(): void | Promise<void> }): EngineProcesses => {
    if (closing) throw new Error("App-process cases are closing; no new case may open");
    const owner = engineProcesses(root, resources);
    let observing = false;
    const entry = { root, owner, close: (): Promise<void> => {
      const result = owner.close();
      if (!observing) {
        observing = true;
        void result.then(() => { active.delete(entry); }, () => { retained.add(root); });
      }
      return result;
    } };
    // Construction has no async preparation or launch; registration precedes every caller effect.
    active.add(entry);
    return { ...owner, close: () => entry.close() };
  };
  const close = (): Promise<void> => {
    if (closing) return closing;
    let resolve!: () => void, reject!: (error: unknown) => void;
    closing = new Promise<void>((done, failed) => { resolve = done; reject = failed; });
    const batch = [...active];
    // Close every admission gate before any abort listener or peer stop may reenter a case.
    for (const entry of batch) entry.owner[closeAdmission]();
    const work = batch.map(entry => {
      try { return entry.close(); } catch (error) { retained.add(entry.root); return Promise.reject(error); }
    });
    void Promise.allSettled(work).then(settled => {
      const errors = settled.flatMap(result => result.status === "rejected" ? [result.reason] : []);
      closing = undefined;
      if (errors.length) reject(new AggregateError(errors, "App-process cases retained uncertain ownership"));
      else resolve();
    });
    return closing;
  };
  return { open, close, retained,
    async use<T>(root: string, body: (owners: EngineProcesses) => Promise<T>, resources?: { stopPeers(): void | Promise<void> }): Promise<T> {
      const owners = open(root, resources);
      const result = await setupWithCleanup(() => owners.prepare(() => body(owners)), () => owners.close());
      await owners.close();
      return result;
    },
  };
}
export type EngineProcessCases = ReturnType<typeof engineProcessCases>;
