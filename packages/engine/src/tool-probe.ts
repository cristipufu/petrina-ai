import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { AgentProfile, CheckId } from "@petrina/core";
import type { ToolProbe, ToolProbeRequest, ToolProbeResult } from "@petrina/orchestrator";
import type { Kernel } from "./kernel.js";
import { agentEnv } from "@petrina/platform/process-environment";
import { checkGh, checkGit, type Which } from "@petrina/repositories/tool-readiness";
import { checkAgentTool } from "@petrina/agent-runtime/probe";
import { ADAPTERS, agentCommandFor, ENGINE_PROFILES, findProgram } from "@petrina/agent-runtime/tools";

/** Native installation/login observations; no admission, shared-check or workflow decisions. */
export class NativeToolProbe implements ToolProbe {
  constructor(private readonly k: Kernel) {}

  absent(id: CheckId): boolean {
    const which = this.which();
    if (id === "git") return which(id) === null;
    if (id === "gh") return !this.k.options.gh && which("gh") === null;
    if (this.k.options.requireAgentCommand && !this.k.options.agentCommand) return true;
    return !this.k.options.agentCommand && which(ADAPTERS[id]!.cli) === null;
  }

  async run(id: CheckId, request: ToolProbeRequest): Promise<ToolProbeResult> {
    const which = this.which();
    const timeoutMs = this.k.options.toolCheckTimeoutMs;
    const platform = this.k.s.setup?.platform ?? "linux";
    if (id === "git") return checkGit(
      which,
      platform,
      {
      ...(timeoutMs ? { timeoutMs } : {}),
      ...(this.k.options.developerTools ? { developerTools: this.k.options.developerTools } : {})
    }
    );
    if (id === "gh") {
      const gh = this.k.options.gh ?? [which("gh")].filter((path): path is string => path !== null);
      return gh.length ? checkGh(gh, timeoutMs) : { status: "not-installed" };
    }
    const profile: AgentProfile =
      this.k.s.profiles.find((entry) => entry.toolId === id)
      ?? ENGINE_PROFILES.find((entry) => entry.toolId === id)
      ?? { id: `${id}-probe`, toolId: id, model: "Default", effort: "high" };
    const command = agentCommandFor(this.k.options, profile);
    // An empty owned folder: no product settings are read by an identity probe.
    const cwd = join(this.k.dataDir, "checks");
    await mkdir(cwd, { recursive: true, mode: 0o700 });
    return checkAgentTool({ adapter: ADAPTERS[id]!, profile, ...(command ? { command } : {}), env: agentEnv(process.env), cwd, which,
      onGone: request.onGone, signal: request.signal, ...(timeoutMs ? { timeoutMs } : {}) });
  }

  private which(): Which { return this.k.options.which ?? findProgram; }
}
