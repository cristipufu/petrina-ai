import type { Role } from "@petrina/core";
import { ReopenFailed, type AgentSession, type AgentSessionOptions, type StartAgentSession, type TurnResult } from "@petrina/orchestrator";

export interface ScriptedPrompt {
  readonly sessionId: string;
  readonly roleId: string;
  readonly result: Role["result"];
  readonly profileId: string;
  readonly toolId: string;
  readonly model: string;
  readonly cwd: string;
  readonly text: string;
  readonly turn: number;
}

export function scriptedResult(value: unknown): string {
  return `\`\`\`petrina\n${JSON.stringify(value)}\n\`\`\``;
}

/**
 * Script only the provider response. The engine still builds/parses prompts, runs Git and checks,
 * records SQLite state and owns scheduling, review, restart and delivery. ACP/OS behavior belongs
 * in the native fake-agent tests; this fixture must not be used to claim process-cleanup coverage.
 * Keep this owner across an in-process engine restart to retain its conversations.
 */
export class ScriptedAgents {
  private readonly sessions = new Map<string, { roleId: string; toolId: string; model: string; turns: number }>();
  private readonly prompts: ScriptedPrompt[] = [];

  constructor(private readonly respond: (prompt: ScriptedPrompt, signal: AbortSignal) => string | Promise<string>) {}

  received(result?: Role["result"]): readonly ScriptedPrompt[] {
    return this.prompts.filter(prompt => result === undefined || prompt.result === result).map(prompt => ({ ...prompt }));
  }

  readonly start: StartAgentSession = async (options, role) => {
    if (options.signal.aborted) throw new Error("Stopped before the scripted session started");
    if (options.browser) throw new Error("Browser assertions require the native fake agent");
    const roleId = role.id, result = role.result;
    const model = options.profile.modelId ?? options.profile.model;
    const saved = options.reopen ? this.sessions.get(options.reopen) : undefined;
    if (options.reopen && (!saved || saved.roleId !== role.id || saved.toolId !== options.profile.toolId || saved.model !== model)) {
      throw new ReopenFailed("The scripted conversation is unavailable for this participant");
    }
    const sessionId = options.reopen ?? crypto.randomUUID();
    const session = saved ?? { roleId: role.id, toolId: options.profile.toolId, model, turns: 0 };
    this.sessions.set(sessionId, session);
    return new ScriptedSession(options, sessionId, !!saved, text => {
      const prompt = { sessionId, roleId, result, profileId: options.profile.id, toolId: options.profile.toolId, model, cwd: options.cwd, text, turn: ++session.turns };
      this.prompts.push(prompt);
      return prompt;
    }, this.respond);
  };
}

class ScriptedSession implements AgentSession {
  readonly reopened?: "resume";
  readonly liveInput = false;
  private readonly stopped = new AbortController();
  private pending?: Promise<string>;
  prompting = false;
  onPromptStarted?: () => void;
  private readonly abort = () => this.close();
  private readonly confirmed;

  constructor(private readonly options: AgentSessionOptions, readonly sessionId: string, reopened: boolean,
    private readonly record: (text: string) => ScriptedPrompt,
    private readonly respond: (prompt: ScriptedPrompt, signal: AbortSignal) => string | Promise<string>) {
    if (reopened) this.reopened = "resume";
    this.confirmed = { model: options.profile.modelId ?? options.profile.model, effort: options.profile.effort };
    options.signal.addEventListener("abort", this.abort, { once: true });
  }

  get settings() { return { ...this.confirmed }; }
  get lastTurn() { return { changed: {}, rerouted: false, helpers: 0 }; }

  async prompt(text: string): Promise<TurnResult> {
    if (this.stopped.signal.aborted) throw new Error("The scripted session stopped");
    if (this.prompting) throw new Error("The scripted session already has a turn");
    this.prompting = true;
    try {
      this.onPromptStarted?.();
      if (this.stopped.signal.aborted) throw new Error("The scripted session stopped");
      const work = Promise.resolve().then(() => {
        if (this.stopped.signal.aborted) throw new Error("The scripted session stopped");
        return this.respond(this.record(text), this.stopped.signal);
      });
      this.pending = work;
      const reply = await work;
      if (this.stopped.signal.aborted) throw new Error("The scripted session stopped");
      return { ...this.lastTurn, text: reply, stopReason: "end_turn" };
    } finally { this.pending = undefined; this.prompting = false; }
  }

  async guide(): Promise<"unsupported"> { return "unsupported"; }
  async cancel(): Promise<void> { this.close(); }
  close(): void { this.stopped.abort(); }
  async stop(): Promise<boolean> {
    this.close();
    this.options.signal.removeEventListener("abort", this.abort);
    // The callback sees the stop signal. Never claim it ended while it can still change fixture files.
    await this.pending?.catch(() => undefined);
    return true;
  }
}
