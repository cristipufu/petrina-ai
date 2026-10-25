import type { ToolProbeResult } from "@petrina/orchestrator";
import { CHECK_TIMEOUT_MS, versionCheck, type Which } from "@petrina/repositories/tool-readiness";

/** Is Node.js there? Agents' connectors run on it. */
export async function checkNode(which: Which, timeoutMs = CHECK_TIMEOUT_MS): Promise<ToolProbeResult> {
  const path = which("node");
  if (!path) return { status: "not-installed" };
  return versionCheck([path, "--version"], timeoutMs);
}

/** How to open a web page in the default browser, outside the app. */
export function browserCommand(url: string, platform: NodeJS.Platform = process.platform): string[] {
  return platform === "darwin" ? ["open", url] : platform === "win32" ? ["cmd", "/c", "start", "", url] : ["xdg-open", url];
}
