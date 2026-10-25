import { ProfileChoiceController } from "@petrina/orchestrator";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { ProfileChoices } from "@petrina/core";
import { AgentRun } from "@petrina/agent-runtime/acp-run";
import { agentEnv } from "@petrina/platform/process-environment";
import type { Kernel } from "./kernel.js";
import { ADAPTERS, agentCommandFor } from "@petrina/agent-runtime/tools";

type ProfileHost = Pick<Kernel, "dataDir" | "options" | "stopped"> & { s: Pick<Kernel["s"], "profiles"> };

/** On-demand configuration discovery: no prompt, browser, or polling. One probe per tool at a time. */
export class ProfileChoiceReader {
  private readonly controller: ProfileChoiceController;
  constructor(private readonly k: ProfileHost) {
    this.controller = new ProfileChoiceController({
      now: () => Date.now(), stopped: () => this.k.stopped,
      arm: (expired, milliseconds) => { const timer = setTimeout(expired, milliseconds); return () => clearTimeout(timer); },
      probe: (toolId, modelId, signal, onGone) => this.probe(toolId, modelId, signal, onGone),
    });
  }
  pending(): { checking: string[]; stopping: string[] } { return this.controller.activity(); }
  stop(): Promise<void> { return this.controller.stop(); }
  read(toolId: string, modelId?: string, refresh = false): Promise<ProfileChoices> { return this.controller.read(toolId, modelId, refresh); }
  private async probe(toolId: string, modelId: string | undefined, signal: AbortSignal, onGone: (gone: Promise<void>) => void): Promise<ProfileChoices> {
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
        onGone,
        command: agentCommandFor(this.k.options, profile), signal: AbortSignal.any([signal, controller.signal]), startTimeoutMs: this.k.options.startTimeoutMs,
        callbacks: { onActivity() {}, onPlanStep() {}, onPermission: async () => "deny" } });
      return await run.profileChoices(modelId);
    } catch (error) {
      if (controller.signal.aborted) throw new Error("This tool did not report its profile choices within 30 seconds. Try Refresh choices.");
      throw error;
    } finally { clearTimeout(timer); await run?.stop(); }
  }
}
