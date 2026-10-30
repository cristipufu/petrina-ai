import { ReopenFailed, type AgentSession } from "./ports/agents.js";

export interface ParticipantSessionEffects<S extends AgentSession> {
  start(sessionId?: string): Promise<{ run: S; off?: string }>;
  stop(run: S): Promise<void>;
  announce(): void;
  aborted(): boolean;
  unavailable(reason: string): Error;
}

/** A saved-session opening is a probe until it succeeds; failed probes cannot announce phantom work. */
export async function openParticipantSession<S extends AgentSession>(options: { sessionId?: string; reselect?: boolean }, effects: ParticipantSessionEffects<S>): Promise<{ run: S; off?: string; reopenFailure?: string }> {
  let announced = false;
  const announce = () => {
    if (announced || effects.aborted()) return;
    announced = true;
    effects.announce();
  };
  let reopenFailure: string | undefined;
  if (options.sessionId) {
    if (!options.reselect) announce();
    let opened: { run: S; off?: string } | undefined;
    try {
      opened = await effects.start(options.sessionId);
      announce();
      return opened;
    } catch (error) {
      if (opened) {
        try { await effects.stop(opened.run); }
        catch (cleanup) { throw new AggregateError([error, cleanup], "Starting the agent failed and its cleanup was not confirmed"); }
      }
      if (effects.aborted() || !(error instanceof ReopenFailed)) throw error;
      if (options.reselect) throw effects.unavailable(`the tool could not reopen its saved conversation (${error.message})`);
      reopenFailure = error.message;
    }
  }
  announce();
  return { ...await effects.start(), ...(reopenFailure ? { reopenFailure } : {}) };
}
