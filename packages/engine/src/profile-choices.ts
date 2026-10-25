import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { ProfileChoices } from "@petrina/core";
import { AgentRun } from "@petrina/agent-runtime/acp-run";
import { agentEnv } from "./env.js";
import type { Kernel } from "./kernel.js";
import { ADAPTERS, agentCommandFor } from "@petrina/agent-runtime/tools";

type ProfileHost = Pick<Kernel, "dataDir" | "options" | "stopped"> & { s: Pick<Kernel["s"], "profiles"> };

/** On-demand configuration discovery: no prompt, browser, or polling. One probe per tool at a time. */
export class ProfileChoiceReader {
  private cache = new Map<string, { at: number; choices: ProfileChoices }>();
  private pending = new Map<string, Promise<ProfileChoices>>();
  private tools = new Map<string, Promise<unknown>>();
  private lingering = new Map<string, Promise<void>>();
  private stopping = new AbortController();
  constructor(private readonly k: ProfileHost) {}
  async stop(): Promise<void> { this.stopping.abort(); await Promise.allSettled([...this.pending.values()]); await Promise.allSettled([...this.lingering.values()]); }
  read(toolId: string, modelId?: string, refresh = false): Promise<ProfileChoices> {
    if (this.stopping.signal.aborted || this.k.stopped) return Promise.reject(new Error("The engine is stopping."));
    const key = JSON.stringify([toolId, modelId]);
    const pending = this.pending.get(key);
    if (pending) return pending;
    const cached = this.cache.get(key);
    if (!refresh && cached && Date.now() - cached.at < 300_000) return Promise.resolve(structuredClone(cached.choices));
    const before = this.tools.get(toolId);
    const work = (before ? before.catch(() => undefined) : Promise.resolve()).then(async () => {
      if (this.stopping.signal.aborted) throw new Error("The engine is stopping.");
      const lingering = this.lingering.get(toolId);
      if (lingering) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try { await Promise.race([lingering, new Promise<void>(resolve => { timer = setTimeout(resolve, 3_000); })]); }
        finally { clearTimeout(timer); }
        if (this.lingering.get(toolId) === lingering) throw new Error("This tool is still stopping after its last configuration check. Try again in a moment.");
      }
      if (this.stopping.signal.aborted) throw new Error("The engine is stopping.");
      const choices = await this.probe(toolId, modelId);
      this.cache.set(key, { at: Date.now(), choices });
      this.cache.set(JSON.stringify([toolId, choices.modelId]), { at: Date.now(), choices });
      return structuredClone(choices);
    }).finally(() => { this.pending.delete(key); if (this.tools.get(toolId) === work) this.tools.delete(toolId); });
    this.pending.set(key, work); this.tools.set(toolId, work);
    return work;
  }
  private async probe(toolId: string, modelId?: string): Promise<ProfileChoices> {
    if (!ADAPTERS[toolId]) throw new Error("Choose an installed coding tool.");
    if (this.k.options.profileChoices) return this.k.options.profileChoices(toolId, modelId);
    const profile = this.k.s.profiles.find(profile => profile.toolId === toolId) ?? { id: "configuration", toolId, model: "Configuration", effort: "high" as const };
    const cwd = join(this.k.dataDir, "checks", "profiles", toolId);
    await mkdir(cwd, { recursive: true });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30_000);
    let run: AgentRun | undefined;
    try {
      run = await AgentRun.start({ profile, cwd, env: agentEnv(process.env), probe: true, browser: false,
        onGone: gone => {
          this.lingering.set(toolId, gone);
          void gone.then(() => { if (this.lingering.get(toolId) === gone) this.lingering.delete(toolId); }, () => undefined);
        },
        command: agentCommandFor(this.k.options, profile), signal: AbortSignal.any([this.stopping.signal, controller.signal]), startTimeoutMs: this.k.options.startTimeoutMs,
        callbacks: { onActivity() {}, onPlanStep() {}, onPermission: async () => "deny" } });
      return await run.profileChoices(modelId);
    } catch (error) {
      if (controller.signal.aborted) throw new Error("This tool did not report its profile choices within 30 seconds. Try Refresh choices.");
      throw error;
    } finally { clearTimeout(timer); await run?.stop(); }
  }
}
