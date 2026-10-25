import type { LaunchInput, Platform } from "../../src/terminal-plan.js";
export const SESSION = "0b6f3c2e-6d2a-4f6e-9a51-2f1f7d5c9a10";
export const PATHS: Record<Platform, { dir: string; worktree: string; claude: string; codex: string; grok: string }> = {
  darwin: { dir: "/Users/ana/.petrina/takeover/task-7", worktree: "/Users/ana/.petrina/worktrees/shop/task-7", claude: "/Users/ana/.local/bin/claude", codex: "/opt/homebrew/bin/codex", grok: "/Users/ana/.grok/bin/grok" },
  linux: { dir: "/home/ana/.petrina/takeover/task-7", worktree: "/home/ana/.petrina/worktrees/shop/task-7", claude: "/home/ana/.local/bin/claude", codex: "/usr/local/bin/codex", grok: "/home/ana/.grok/bin/grok" },
  win32: {
    dir: "C:\\Users\\Ana María\\.petrina\\takeover\\task-7",
    worktree: "C:\\Users\\Ana María\\.petrina\\worktrees\\shop\\task-7",
    claude: "C:\\Users\\Ana María\\AppData\\Roaming\\npm\\claude.cmd",
    codex: "C:\\Program Files (x86)\\Codex\\codex.exe",
    grok: "C:\\Users\\Ana María\\AppData\\Local\\grok\\grok.exe",
  },
};

export function input(platform: Platform, toolId: "claude-code" | "codex" | "grok", change: Partial<LaunchInput> = {}): LaunchInput {
  const paths = PATHS[platform];
  const tool = toolId === "claude-code" ? { id: toolId, name: "Claude Code", path: paths.claude } : toolId === "grok" ? { id: toolId, name: "Grok", path: paths.grok } : { id: toolId, name: "Codex", path: paths.codex };
  const model = toolId === "claude-code" ? "opus" : toolId === "grok" ? "grok-4.7" : "gpt-6.1-sol";
  return { platform, dir: paths.dir, worktree: paths.worktree, tool, sessionId: SESSION, model, effort: "xhigh", ...change };
}

/** Anything that looks like a credential or Petrina's own secrets. */
export const SECRETS = [/token/i, /secret/i, /password/i, /api[_-]?key/i, /GH_|GITHUB_|ANTHROPIC_|OPENAI_/, /PETRINA_/, /Bearer/i, /ghp_/];
