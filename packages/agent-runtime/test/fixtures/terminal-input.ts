import type { LaunchInput, Platform } from "../../src/terminal-plan.js";
export const SESSION = "0b6f3c2e-6d2a-4f6e-9a51-2f1f7d5c9a10";
export const OPENCODE_SESSION = "ses_49470b5c7ffe1a2b3c4d";
export const PATHS: Record<
  Platform,
  { dir: string; worktree: string; claude: string; codex: string; grok: string; opencode: string; pi: string }
> = {
  darwin: {
    dir: "/Users/ana/.petrina/takeover/task-7",
    worktree: "/Users/ana/.petrina/worktrees/shop/task-7",
    claude: "/Users/ana/.local/bin/claude",
    codex: "/opt/homebrew/bin/codex",
    grok: "/Users/ana/.grok/bin/grok",
    opencode: "/Users/ana/.opencode/bin/opencode",
    pi: "/opt/homebrew/bin/pi",
  },
  linux: {
    dir: "/home/ana/.petrina/takeover/task-7",
    worktree: "/home/ana/.petrina/worktrees/shop/task-7",
    claude: "/home/ana/.local/bin/claude",
    codex: "/usr/local/bin/codex",
    grok: "/home/ana/.grok/bin/grok",
    opencode: "/home/ana/.opencode/bin/opencode",
    pi: "/usr/local/bin/pi",
  },
  win32: {
    dir: "C:\\Users\\Ana María\\.petrina\\takeover\\task-7",
    worktree: "C:\\Users\\Ana María\\.petrina\\worktrees\\shop\\task-7",
    claude: "C:\\Users\\Ana María\\AppData\\Roaming\\npm\\claude.cmd",
    codex: "C:\\Program Files (x86)\\Codex\\codex.exe",
    grok: "C:\\Users\\Ana María\\AppData\\Local\\grok\\grok.exe",
    opencode: "C:\\Users\\Ana María\\AppData\\Roaming\\npm\\opencode.cmd",
    pi: "C:\\Users\\Ana María\\AppData\\Roaming\\npm\\pi.cmd",
  },
};

export function input(
  platform: Platform,
  toolId: "claude-code" | "codex" | "grok" | "opencode" | "pi",
  change: Partial<LaunchInput> = {},
): LaunchInput {
  const paths = PATHS[platform];
  const tool =
    toolId === "claude-code"
      ? { id: toolId, name: "Claude Code", path: paths.claude }
      : toolId === "grok"
        ? { id: toolId, name: "Grok", path: paths.grok }
        : toolId === "opencode"
          ? { id: toolId, name: "OpenCode", path: paths.opencode }
          : toolId === "pi"
            ? { id: toolId, name: "Pi", path: paths.pi }
            : { id: toolId, name: "Codex", path: paths.codex };
  const model =
    toolId === "claude-code"
      ? "opus"
      : toolId === "grok"
        ? "grok-4.7"
        : toolId === "opencode"
          ? "anthropic/claude-sonnet-4-5"
          : toolId === "pi"
            ? "openai/gpt-5"
            : "gpt-6.1-sol";
  const sessionId = toolId === "opencode" ? OPENCODE_SESSION : SESSION;
  return { platform, dir: paths.dir, worktree: paths.worktree, tool, sessionId, model, effort: "xhigh", ...change };
}

/** Anything that looks like a credential or Petrina's own secrets. */
export const SECRETS = [/token/i, /secret/i, /password/i, /api[_-]?key/i, /GH_|GITHUB_|ANTHROPIC_|OPENAI_/, /PETRINA_/, /Bearer/i, /ghp_/];
