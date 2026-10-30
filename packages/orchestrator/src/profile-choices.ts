import type { ProfileChoices } from "@petrina/core";

/** Native configuration discovery and deadlines are supplied by the application adapter. */
export interface ProfileChoiceEffects {
  now(): number;
  stopped(): boolean;
  arm(expired: () => void, milliseconds: number): () => void;
  probe(toolId: string, modelId: string | undefined, signal: AbortSignal, onGone: (gone: Promise<void>) => void): Promise<ProfileChoices>;
}

/** Per-tool reservations, reusable choices and cleanup barriers; no native programs or files. */
export class ProfileChoiceController {
  private cache = new Map<string, { at: number; choices: ProfileChoices }>();
  private pending = new Map<string, Promise<ProfileChoices>>();
  private tools = new Map<string, Promise<unknown>>();
  private lingering = new Map<string, Promise<void>>();
  private stopping = new AbortController();
  constructor(private readonly effects: ProfileChoiceEffects) {}
  activity(): { checking: string[]; stopping: string[] } { return { checking: [...this.pending.keys()], stopping: [...this.lingering.keys()] }; }
  async stop(): Promise<void> {
    this.stopping.abort();
    await Promise.allSettled([...this.pending.values()]);
    const outcomes = await Promise.allSettled([...this.lingering.values()]);
    const failures = outcomes.flatMap(result => result.status === "rejected" ? [result.reason] : []);
    if (failures.length === 1) throw failures[0];
    if (failures.length) throw new AggregateError(failures, "Profile probe cleanup was not confirmed for every owner");
  }
  read(toolId: string, modelId?: string, refresh = false): Promise<ProfileChoices> {
    if (this.stopping.signal.aborted || this.effects.stopped()) return Promise.reject(new Error("The engine is stopping."));
    const key = JSON.stringify([toolId, modelId]);
    const pending = this.pending.get(key);
    if (pending) return pending;
    const cached = this.cache.get(key);
    if (!refresh && cached && this.effects.now() - cached.at < 300_000) return Promise.resolve(structuredClone(cached.choices));
    const before = this.tools.get(toolId);
    const work = (before ? before.catch(() => undefined) : Promise.resolve()).then(async () => {
      if (this.stopping.signal.aborted) throw new Error("The engine is stopping.");
      const lingering = this.lingering.get(toolId);
      if (lingering) {
        let cancel = () => {};
        try { await Promise.race([lingering, new Promise<void>(resolve => { cancel = this.effects.arm(resolve, 3_000); })]); }
        finally { cancel(); }
        if (this.lingering.get(toolId) === lingering) throw new Error("This tool is still stopping after its last configuration check. Try again in a moment.");
      }
      if (this.stopping.signal.aborted) throw new Error("The engine is stopping.");
      const choices = await this.effects.probe(toolId, modelId, this.stopping.signal, gone => {
        this.lingering.set(toolId, gone);
        void gone.then(() => { if (this.lingering.get(toolId) === gone) this.lingering.delete(toolId); }, () => undefined);
      });
      this.cache.set(key, { at: this.effects.now(), choices });
      this.cache.set(JSON.stringify([toolId, choices.modelId]), { at: this.effects.now(), choices });
      return structuredClone(choices);
    }).finally(() => {
      this.pending.delete(key);
      if (this.tools.get(toolId) === work) this.tools.delete(toolId);
    });
    this.pending.set(key, work);
    this.tools.set(toolId, work);
    return work;
  }
}
