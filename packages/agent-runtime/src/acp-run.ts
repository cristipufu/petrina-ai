// One agent session over ACP: start the tool's adapter, open a session in the task's
// worktree (or reopen an earlier one), pin model, effort and mode, then send turns and report
// what happens. It also reads back what the tool says the session runs on, and what each turn used.

import { spawn, type ChildProcess } from "node:child_process";
import { processHost } from "@petrina/platform/process-host";
import {
  ReopenFailed,
  type AgentSession,
  type AgentSessionOptions,
  type AgentInputReceipt,
  type SessionSettings,
  type TurnNotes,
  type TurnResult
} from "@petrina/orchestrator";
import * as acp from "@agentclientprotocol/sdk";
import type { ProfileChoices, AgentProfile } from "@petrina/core";
import type { ClaudeSandbox } from "./sandbox.js";
import { SandboxUnavailable, sandboxFailure } from "./sandbox-failures.js";
import { ADAPTERS } from "./tool-catalog.js";
import { adapterLaunchCommand } from "./tool-entry.js";
import { AgentBrowser } from "./browser.js";
export { AGENT_CLEANUP_NOTE } from "./browser-cleanup.js";
import { CLEANUP_INCOMPLETE } from "@petrina/platform/process-tree";
import type { ModelAtCapacity, UsageLimited } from "./usage.js";
import { AgentMessages, TurnText } from "./agent-messages.js";
import { messageClock } from "./message-clock.js";
import type { AccountReading } from "./tool-adapter.js";
import { ownSession } from "@petrina/platform/process-environment";
import {
  choices,
  createAcpConnection,
  duration,
  FORCE_AFTER_MS,
  providerError,
  REOPEN_TIMEOUT_MS,
  reportOf,
  reroutedTo,
  settingsOf,
  START_TIMEOUT_MS,
  unconfirmed,
  type ConfigOption,
  type RunCallbacks,
  type RunState,
} from "./acp-protocol.js";
import {
  acpCapacityOf,
  acpLimitOf,
  acpRejectedUsage,
  isChildRunning,
  readAcpAccountUsage,
  stopAll,
} from "./acp-turn-limits.js";

export { reportOf, reroutedTo, settingsOf, stopAll, type RunCallbacks };

export class AgentRun implements AgentSession {
  private notes: TurnNotes | undefined;
  private accountBefore: AccountReading | undefined;
  private acceptsLiveInput = false;
  onPromptStarted?: () => void;

  get liveInput(): boolean { return this.acceptsLiveInput; }
  get prompting(): boolean { return this.state.turn !== undefined; }

  /** A lost reply is uncertain: it must never become an automatic second delivery. */
  async guide(text: string, messageId: string): Promise<AgentInputReceipt> {
    const live = ADAPTERS[this.profile.toolId]?.liveInput;
    if (!live || !this.acceptsLiveInput || !this.prompting) return "unsupported";
    const request = live.request(this.sessionId, text, messageId);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onExit!: () => void;
    const gone = new Promise<never>((_, reject) => {
      onExit = () => reject(new Error("The tool stopped before confirming live input"));
      this.child.once("exit", onExit);
      if (!isChildRunning(this.child)) onExit();
    });
    try {
      const response = await Promise.race([
        this.connection.extMethod(request.method, request.params),
        gone,
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Live input was not confirmed")), 10_000); }),
      ]);
      return live.receipt(response);
    } catch (error) {
      const code = (error as { code?: number } | null)?.code;
      return code !== undefined && [-32600, -32601, -32602].includes(code) ? "rejected" : "unknown";
    } finally {
      clearTimeout(timer);
      this.child.removeListener("exit", onExit);
    }
  }

  /** Read native configuration without sending work to a model. Set when the session opens. */
  profileChoices!: (modelId?: string) => Promise<ProfileChoices>;

  private constructor(
    private readonly child: ChildProcess,
    private readonly connection: acp.ClientSideConnection,
    /** The tool's id for the conversation. */
    readonly sessionId: string,
    private readonly state: RunState,
    private readonly profile: AgentProfile,
    private readonly stopper: (graceMs?: number) => Promise<boolean>,
    /** How an earlier conversation was reopened; unset for a new one. */
    readonly reopened?: "resume" | "load",
    readonly browser?: AgentBrowser,
    private readonly callbacks?: RunCallbacks,
  ) {}

  /** What the tool confirmed the session runs on right now. */
  get settings(): SessionSettings {
    return { ...this.state.settings };
  }

  /** What the tool said during the last turn, also when the agent stopped before replying. */
  get lastTurn(): TurnNotes | undefined {
    return this.notes && { ...this.notes, changed: { ...this.notes.changed } };
  }

  /**
   * With `reopen`, pick up that conversation: by the tool's resume, which replays nothing, or by
   * load when that is all it offers. Anything that keeps it from reopening within the time limit
   * (no support, an error, no answer) throws ReopenFailed, and the agent process is gone. A tool that
   * does not start within `startTimeoutMs` is stopped and throws, so a step never waits forever.
   * A login probe gets a failed start at once while its tool stops; a task waits for the tool and
   * its programs to stop before it can release the working copy. `onGone` observes either stop.
   * With `sandbox`, the conversation opens in Claude Code's own sandbox; when Claude Code says it
   * cannot start, new or reopened, this throws SandboxUnavailable instead.
   */
  static async start(options: AgentSessionOptions & {
    callbacks: RunCallbacks;
    command?: readonly string[];
    env?: NodeJS.ProcessEnv;
    onProcess?: (child: ChildProcess) => void;
    /** A login check only opens a conversation, never sends work or runs in a product's copy. */
    probe?: boolean;
    /** Run the tool's native sign-in, only after an explicit coordinator action. */
    authenticate?: string;
    sandbox?: ClaudeSandbox;
    /** Where the browser registers its temporary folder, so startup can recover it after a crash. */
    browserRoot?: string;
    /** Tests: a fixture's own parent for the temporary browser folder, instead of the standard one. */
    browserTempRoot?: string;
  }): Promise<AgentRun> {
    const { profile, cwd, callbacks, signal } = options;
    const adapter = ADAPTERS[profile.toolId];
    if (!adapter) throw new Error(`No adapter for tool ${profile.toolId}`);
    // Stopped before it started: an aborted signal never fires again, so never start the agent at all.
    if (signal.aborted) throw new Error("Stopped before the agent started");

    const [program, ...args] = options.command ?? adapterLaunchCommand(adapter);
    const env = ownSession(options.env ?? process.env);
    adapter.prepareEnv?.(env);

    // windowsHide: no console window flashes up on Windows when an agent starts.
    const child = spawn(program!, args, { cwd, stdio: ["pipe", "pipe", "pipe"], env, ...processHost.ownedSpawn });
    child.stderr?.on("data", (chunk: Buffer) => callbacks.onLog?.(chunk.toString()));
    const killed = new Promise<never>((_, reject) => {
      child.once("exit", (code) => reject(new Error(`${adapter.name} stopped (exit ${code ?? "signal"})`)));
      child.once("error", (error) => reject(error));
    });
    killed.catch(() => undefined);
    // Cleanup exists before external observers run; browser startup is admitted only after them.
    let browserReady: Promise<AgentBrowser | undefined> = Promise.resolve(undefined);
    let stopping: Promise<boolean> | undefined;
    let cleanupNoticeSent = false;
    let disposableSession: string | undefined;
    let confirmedGone!: () => void;
    let unconfirmedGone!: (error: unknown) => void;
    const processGone = new Promise<void>((resolve, reject) => {
      confirmedGone = resolve;
      unconfirmedGone = reject;
    });
    void processGone.catch(() => undefined);
    const stop = (graceMs = FORCE_AFTER_MS) => (stopping ??= Promise.all([
      // A cleanup that cannot be confirmed leaves its reason in the task's log, as the browser's does.
      stopAll(child, graceMs, !options.probe, (line) => { if (callbacks.onLog) callbacks.onLog(`\n${line}\n`);
      else console.error(line); }),
      browserReady.then((browser) => browser?.close()).then(() => true, () => false),
    ]).then(async (results) => {
      signal.removeEventListener("abort", abort);
      let complete = results.every(Boolean);
      if (complete && disposableSession && adapter.forgetProbe) {
        try { await adapter.forgetProbe(disposableSession, env); }
        catch { complete = false; }
      }
      if (!complete && !cleanupNoticeSent) {
        cleanupNoticeSent = true;
        callbacks.onCleanupIncomplete?.();
      }
      return complete;
    }).then(complete => {
      // A bounded stop can establish native completion even when the runtime lost
      // its exit notification. Only that cleanup receipt releases external owners.
      if (complete) confirmedGone();
      else unconfirmedGone(new Error(CLEANUP_INCOMPLETE));
      return complete;
    }, error => {
      unconfirmedGone(error);
      throw error;
    }));
    // A reopened conversation stays quiet until Petrina's first message: what load replays is history,
    // already in the session view and timeline.
    const state: RunState = {
      response: new TurnText(),
      messages: new AgentMessages(messageClock, callbacks.onMessage),
      lastActivity: "",
      quiet: options.reopen !== undefined,
      settings: {},
    };
    const finishAfterExit = () => { void stop().catch(() => undefined); };
    child.once("exit", finishAfterExit);
    child.once("error", finishAfterExit);
    const abort = () => {
      state.messages.boundary(true);
      state.quiet = true;
      void stop();
    };
    signal.addEventListener("abort", abort, { once: true });
    // Stopped while starting: give up at once, without waiting for a tool that ignores being stopped.
    let openingAborted!: () => void;
    const stopped = new Promise<never>((_, reject) => {
      openingAborted = () => reject(new Error("Stopped before the agent started"));
      signal.addEventListener("abort", openingAborted, { once: true });
    });
    stopped.catch(() => undefined);
    if (signal.aborted) {
      void stop();
      openingAborted();
    }
    // The session's options as the tool last sent them, while the model, effort and mode are set.
    let sessionOptions: ConfigOption[] = [];
    const optionIds = { model: adapter.options.model, effort: adapter.options.effort };
    // The tool can change the session's model or effort by itself (a fallback): keep what it says.
    const readSettings = (nextOptions: readonly ConfigOption[]) => {
      const next = settingsOf(nextOptions, optionIds);
      const turn = state.turn;
      if (turn) {
        if (next.model && next.model !== state.settings.model) turn.changed.model = next.modelName ?? next.model;
        if (next.effort && next.effort !== state.settings.effort) turn.changed.effort = next.effort;
        turn.next = next;
      } else {
        state.settings = next;
      }
    };
    const connection = createAcpConnection({
      child,
      adapter,
      profile,
      state,
      callbacks,
      onSessionOptions: (nextOptions) => { sessionOptions = nextOptions; },
      readSettings,
    });

    let acceptsLiveInput = false;
    const open = async (): Promise<{ sessionId: string; configOptions?: unknown; how?: "resume" | "load" }> => {
      if (signal.aborted) throw new Error("Stopped before the agent started");
      // Notices let Codex announce a reroute as a typed update instead of text in the reply.
      const [init, browser] = await Promise.all([
        connection.initialize({
          protocolVersion: acp.PROTOCOL_VERSION,
          clientCapabilities: {
          fs: {
          readTextFile: false,
          writeTextFile: false
        },
          terminal: false,
          session: { notices: {} },
          ...(adapter.clientMeta ? { _meta: adapter.clientMeta } : {})
        }
        }),
        browserReady,
      ]);
      const sessionId = options.reopen;
      const live = adapter.liveInput;
      acceptsLiveInput = !options.probe && !!live?.supported(init);
      if (acceptsLiveInput && live?.probe) {
        const probe = live.probe;
        acceptsLiveInput = await connection.extMethod(probe.method, probe.params).then(() => false, error => probe.recognizedError(error));
      }
      if (options.authenticate) await connection.authenticate({ methodId: options.authenticate });
      // Keep the tool's session mode (Grok's auto mode) and add sandbox settings only for Claude Code.
      // The same metadata goes to new, resumed and loaded conversations.
      const baseMeta: Record<string, unknown> = {
        ...adapter.sessionMeta,
        ...(options.sandbox && adapter.sandboxMeta ? adapter.sandboxMeta(options.sandbox) : {})
      };
      const sessionMeta = adapter.prepareSessionMeta ? await adapter.prepareSessionMeta(baseMeta, { cwd, browser: !!browser }) : baseMeta;
      const meta = Object.keys(sessionMeta).length ? { _meta: sessionMeta } : {};
      const mcpServers = browser ? [browser.mcp] : [];
      if (sessionId === undefined) {
        const opened = await connection.newSession({ cwd, mcpServers, ...meta });
        if (options.probe) disposableSession = opened.sessionId;
        return opened;
      }
      const how = init.agentCapabilities?.sessionCapabilities?.resume ? "resume" : init.agentCapabilities?.loadSession ? "load" : undefined;
      if (!how) throw new ReopenFailed(`${adapter.name} cannot reopen conversations`);
      const limit = options.reopenTimeoutMs ?? REOPEN_TIMEOUT_MS;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const late = new Promise<never>((
        _,
        reject
      ) => (timer = setTimeout(
        () => reject(new ReopenFailed(`${adapter.name} did not reopen the conversation within ${duration(limit)}`)),
        limit
      )));
      const params = { sessionId, cwd, mcpServers, ...meta };
      try {
        const opened = await Promise.race([how === "resume" ? connection.resumeSession(params) : connection.loadSession(params), late]);
        return { ...opened, sessionId, how };
      } catch (error) {
        if (error instanceof ReopenFailed || sandboxFailure(error) !== undefined) throw error;
        throw new ReopenFailed(`${adapter.name} could not reopen the conversation`);
      } finally {
        clearTimeout(timer);
      }
    };

    // The same rules for a new and a reopened conversation: model, effort, then the automatic safety mode.
    // Opening is limited as a whole, handshake and settings included, so a tool that never answers never
    // hangs the step: a reopen falls back to a fresh conversation, and a fresh one fails the step, to try again.
    let whole: ReturnType<typeof setTimeout> | undefined;
    const fresh = options.reopen === undefined;
    const limit = fresh ? (options.startTimeoutMs ?? START_TIMEOUT_MS) : (options.reopenTimeoutMs ?? REOPEN_TIMEOUT_MS);
    const deadline = new Promise<never>(
      (_, reject) =>
        (whole = setTimeout(
          () => reject(fresh ? new Error(`${adapter.name} did not start within ${duration(limit)}. Try again; if it keeps happening, check that ${adapter.name} starts in a terminal.`) : new ReopenFailed(`${adapter.name} did not reopen the conversation within ${duration(limit)}`)),
          limit,
        )),
    );
    deadline.catch(() => undefined);
    let observerFailed = false;
    const ready = (async () => {
      // External observers can throw or abort synchronously. All ownership, exit and abort
      // handlers are installed now, and a failure here follows the same cleanup as a failed open.
      // A probe may report a failed opening before its stop settles. Publish cleanup
      // first, and notify the actual-handle owner even if another observer failed.
      const observerErrors: unknown[] = [];
      for (const notify of [() => options.onGone?.(processGone), () => options.onProcess?.(child)]) {
        try { notify(); } catch (error) { observerErrors.push(error); }
      }
      if (observerErrors.length) {
        observerFailed = true;
        if (observerErrors.length === 1) throw observerErrors[0];
        throw new AggregateError(observerErrors, "The agent's ownership observers failed");
      }
      // Login/identity probes send no browser work. An observer can abort before this admission.
      if (!signal.aborted && !options.probe && options.browser !== false) {
        browserReady = AgentBrowser.start(options.browserRoot, options.env ?? process.env, callbacks.onLog, options.browserTempRoot);
        browserReady.catch(() => undefined);
      }
      const session = await open();
      sessionOptions = ((session as { configOptions?: ConfigOption[] }).configOptions ?? []) as ConfigOption[];
      // Account probes send no work. Opening already tests authentication; model, thinking and
      // permission configuration only adds failure points to this short readiness check.
      if (options.probe) return session;
      const set = async (configId: string, value: string | undefined): Promise<boolean> => {
        if (!value) return false;
        const option = sessionOptions.find((entry) => entry.id === configId);
        // A value the tool doesn't offer is not forced: the session keeps the tool's default, and that is recorded.
        if (!option || !choices(option).some((entry) => entry.value === value)) return false;
        if (option.currentValue === value) return true;
        const before = sessionOptions;
        const response = await connection.setSessionConfigOption({ sessionId: session.sessionId, configId, value });
        const echoed = (response as { configOptions?: ConfigOption[] } | undefined)?.configOptions;
        if (Array.isArray(echoed)) sessionOptions = echoed;
        // A bare acknowledgement doesn't say what the session ended up on: not confirmed, never assumed,
        // unless the tool sent its options in an update meanwhile.
        else if (sessionOptions === before) sessionOptions = sessionOptions.map((entry) => (entry.id === configId ? unconfirmed(entry) : entry));
        return true;
      };
      await set(adapter.options.model, profile.modelId);
      await set(adapter.options.effort, profile.effort);
      // Mode last: Claude Code drops Auto when the model changes after it. A tool whose mode is session
      // metadata (Grok's auto mode) has already asked for it, and has no config option to set.
      const automatic = adapter.sessionMeta !== undefined || (adapter.options.mode !== undefined && (await set(adapter.options.mode, adapter.mode)));
      if (!automatic) callbacks.onLog?.(`${adapter.name}'s automatic safety mode is not available here, so it will ask you before acting`);
      readSettings(sessionOptions);
      adapter.verifySessionSettings?.(profile, state.settings);
      return session;
    })();
    ready.catch(() => undefined);

    try {
      const session = await Promise.race([ready, killed, deadline, stopped]);
      state.sessionId = session.sessionId;
      const agent = new AgentRun(child, connection, session.sessionId, state, profile, stop, session.how, await browserReady, callbacks);
      agent.acceptsLiveInput = acceptsLiveInput;
      agent.profileChoices = async (requestedModel?: string): Promise<ProfileChoices> => {
        const modelOption = () => sessionOptions.find(option => option.id === adapter.options.model);
        const models = choices(modelOption()).map(choice => ({ id: choice.value, name: choice.name ?? choice.value }));
        const modelId = requestedModel ?? (typeof modelOption()?.currentValue === "string" ? modelOption()!.currentValue as string : models[0]?.id);
        if (!modelId || !models.some(model => model.id === modelId)) throw new Error(`${adapter.name} did not offer that model.`);
        if (modelOption()?.currentValue !== modelId) {
          const before = sessionOptions;
          const response = await connection.setSessionConfigOption({ sessionId: session.sessionId, configId: adapter.options.model, value: modelId });
          const echoed = (response as { configOptions?: ConfigOption[] }).configOptions;
          if (Array.isArray(echoed)) sessionOptions = echoed;
          else if (sessionOptions === before) throw new Error(`${adapter.name} did not confirm its model settings.`);
        }
        if (modelOption()?.currentValue !== modelId) throw new Error(`${adapter.name} did not confirm the selected model.`);
        const known = new Set(["low", "medium", "high", "xhigh", "ultra"]);
        const efforts = choices(sessionOptions.find(option => option.id === adapter.options.effort)).map(choice => choice.value).filter(value => known.has(value)) as AgentProfile["effort"][];
        if (!efforts.length) throw new Error(`${adapter.name} did not report supported effort levels for this model.`);
        return { toolId: profile.toolId, models, modelId, efforts };
      };
      if (adapter.accountUsage && !options.probe) agent.accountBefore = await Promise.race([agent.readAccountUsage(), killed, deadline, stopped]);
      clearTimeout(whole);
      return agent;
    } catch (error) {
      clearTimeout(whole);
      // No agent left running behind a conversation that did not open, even one that ignores being stopped.
      signal.removeEventListener("abort", abort);
      const gone = stop();
      // A tool check must report its deadline promptly. It tracks onGone before checking again;
      // a task instead waits for all file handling before cleanup can remove its working copy.
      if (!options.probe) await gone;
      // Host recording/ownership failures are not provider or saved-conversation failures.
      if (observerFailed) throw error;
      const unsandboxed = options.sandbox && !signal.aborted ? sandboxFailure(error) : undefined;
      if (unsandboxed !== undefined) throw new SandboxUnavailable(unsandboxed);
      if (options.reopen !== undefined && !(error instanceof ReopenFailed) && !signal.aborted) throw new ReopenFailed(`${adapter.name} could not reopen the conversation`);
      throw providerError(error);
    } finally {
      signal.removeEventListener("abort", openingAborted);
    }
  }

  /** Send one turn and wait for its ending: bounded prose, complete structured result, and reported usage. */
  async prompt(text: string): Promise<TurnResult> {
    this.state.messages.boundary();
    this.state.quiet = false;
    this.state.response = new TurnText();
    delete this.state.latest;
    const turn: NonNullable<RunState["turn"]> = { changed: {}, rerouted: false, helpers: new Set() };
    this.state.turn = turn;
    delete this.state.retrying;
    this.state.activeToolCall = undefined;
    this.state.tools?.startTurn();
    this.notes = undefined;
    const notes = (): TurnNotes => ({
      changed: { ...turn.changed },
      rerouted: turn.rerouted,
      helpers: turn.helpers.size,
      ...(turn.modelSeen ? { modelSeen: turn.modelSeen } : {})
    });
    let completed = false;
    let toolsEnded = false;
    const endTools = () => { if (!toolsEnded) {
      toolsEnded = true;
      this.state.tools?.endTurn();
    } };
    let onExit!: (code: number | null) => void;
    const exited = new Promise<never>((_, reject) => {
      onExit = code => reject(new Error(`The agent stopped (exit ${code ?? "signal"})`));
      this.child.once("exit", onExit);
    });
    exited.catch(() => undefined);
    try {
      if (ADAPTERS[this.profile.toolId]?.accountUsage) {
        const out = this.rejected();
        if (out) throw out;
      }
      const pending = this.connection.prompt({ sessionId: this.sessionId, prompt: [{ type: "text", text }] });
      this.onPromptStarted?.();
      const response = await Promise.race([pending, exited]).catch(async (error: unknown) => {
        endTools();
        if (ADAPTERS[this.profile.toolId]?.accountUsage) await this.readAccountUsage();
        throw this.capacityOf(error) ?? this.limitOf(error) ?? providerError(error);
      });
      endTools();
      if (response.stopReason !== "end_turn" && response.stopReason !== "cancelled") {
        const out = this.rejected();
        if (out) {
          if (this.state.messages.streamed) out.streamed = true;
          throw out;
        }
      }
      const accounting = ADAPTERS[this.profile.toolId]?.accountUsage;
      const report = accounting ? accounting.turnReport(this.accountBefore, await this.readAccountUsage()) : reportOf(response, this.profile.toolId);
      // A finished turn can carry the overloaded stop on the response itself, with no sentence in the agent's text.
      const full = this.capacityOf(response);
      if (full) throw full;
      const failure = response.stopReason !== "cancelled" ? ADAPTERS[this.profile.toolId]?.interruptions?.failure?.(response) : undefined;
      if (failure) throw this.limitOf(failure, true) ?? failure;
      completed = response.stopReason !== "cancelled";
      return {
        stopReason: response.stopReason,
        text: this.state.response.text,
        ...(this.state.messages.streamed ? { streamed: true } : {}),
        ...(report ? { report } : {}),
        ...notes()
      };
    } finally {
      this.child.removeListener("exit", onExit);
      endTools();
      this.state.messages.boundary(!completed);
      this.notes = notes();
      this.state.turn = undefined;
      delete this.state.promptId;
      // The turn ended, however it ended: its result or error decides what happens next.
      if (this.state.retrying !== undefined) {
        delete this.state.retrying;
        this.callbacks?.onRetrying?.(undefined);
      }
      // Later turns run on whatever the tool switched the session to. A Codex reroute is per turn.
      if (turn.next) this.state.settings = turn.next;
    }
  }

  /** The adapter's native account command: no AI call or task message. */
  async readAccountUsage(): Promise<AccountReading | undefined> {
    return readAcpAccountUsage({
      child: this.child,
      connection: this.connection,
      sessionId: this.sessionId,
      profile: this.profile,
      state: this.state,
      callbacks: this.callbacks,
      onStop: () => this.stop(),
      setAccountBefore: (reading) => {
        this.accountBefore = reading;
      },
    });
  }

  /**
   * The tool's connector says this turn ended because the selected model is full. `source` is a thrown
   * provider failure or the prompt response. A native retry warning earlier in the turn is not evidence:
   * only this ending counts. An account limit the tool reported during the turn keeps its own path.
   */
  private capacityOf(source: unknown): ModelAtCapacity | undefined {
    return acpCapacityOf(this.profile, this.sessionId, this.state, this.accountBefore, source);
  }

  /** The usage limit a failed turn ran into, when that is why it failed. */
  private limitOf(error: unknown, explicitOnly = false): UsageLimited | undefined {
    return acpLimitOf(this.profile, this.state, this.accountBefore, error, explicitOnly);
  }

  /** Claude Code said, during this turn, that it is out. */
  private rejected(source: "report" | "refusal" = "report"): UsageLimited | undefined {
    return acpRejectedUsage(this.profile, this.state, this.accountBefore, source);
  }

  /** Stop the current turn (the interrupt button). */
  async cancel(): Promise<void> {
    await this.connection.cancel({ sessionId: this.sessionId }).catch(() => undefined);
  }

  /** Save the last bounded public batch before shutdown closes the store. */
  flushMessages(interrupted = true): void {
    this.state.messages.boundary(interrupted);
  }

  /** Start stopping the agent and the programs it started, without waiting. */
  close(): void {
    this.flushMessages();
    this.state.quiet = true;
    void this.stopper();
  }

  /** Stop the agent and every program it started, and wait until they have exited; forced after a few seconds. */
  stop(graceMs = FORCE_AFTER_MS): Promise<boolean> {
    this.flushMessages();
    this.state.quiet = true;
    return this.stopper(graceMs);
  }
}
