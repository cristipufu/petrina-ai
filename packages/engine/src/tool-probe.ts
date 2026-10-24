import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { AgentProfile, CheckId } from "@petrina/core";
import type { ToolProbe, ToolProbeRequest, ToolProbeResult } from "@petrina/orchestrator";
import type { Kernel } from "./kernel.js";
import { agentEnv } from "./env.js";
import { checkAgentTool, checkGh, checkGit, checkNode, type Which } from "./setup.js";
import { ADAPTERS, agentCommandFor, findProgram } from "./tools.js";

/** Native installation/login observations; no admission, shared-check or workflow decisions. */
export class NativeToolProbe implements ToolProbe {
  constructor(private readonly k: Kernel) {}

  absent(id: CheckId): boolean {
    const which = this.which();
    if (id === "git" || id === "node") return which(id) === null;
    if (id === "gh") return !this.k.options.gh && which("gh") === null;
    if (this.k.options.requireAgentCommand && !this.k.options.agentCommand) return true;
    return !this.k.options.agentCommand && (which(ADAPTERS[id]!.cli) === null || !(ADAPTERS[id]!.installed?.() ?? true));
  }

  async run(id: CheckId, request: ToolProbeRequest): Promise<ToolProbeResult> {
    const which = this.which();
    const timeoutMs = this.k.options.toolCheckTimeoutMs;
    const platform = this.k.s.setup?.platform ?? "linux";
    if (id === "git") return checkGit(which, platform, { ...(timeoutMs ? { timeoutMs } : {}), ...(this.k.options.developerTools ? { developerTools: this.k.options.developerTools } : {}) });
    if (id === "node") return checkNode(which, timeoutMs);
    if (id === "gh") {
      const gh = this.k.options.gh ?? [which("gh")].filter((path): path is string => path !== null);
      return gh.length ? checkGh(gh, timeoutMs) : { status: "not-installed" };
    }
    const profile = this.k.s.profiles.find((entry) => entry.toolId === id) as AgentProfile;
    const command = agentCommandFor(this.k.options, profile);
    // An empty owned folder: no product settings are read by an identity probe.
    const cwd = join(this.k.dataDir, "checks");
    await mkdir(cwd, { recursive: true, mode: 0o700 });
    return checkAgentTool({ adapter: ADAPTERS[id]!, profile, ...(command ? { command } : {}), env: agentEnv(process.env), cwd, which,
      onGone: request.onGone, signal: request.signal, ...(timeoutMs ? { timeoutMs } : {}) });
  }

  private which(): Which { return this.k.options.which ?? findProgram; }
}
