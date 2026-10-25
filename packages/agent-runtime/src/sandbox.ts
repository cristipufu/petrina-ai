// Claude Code's own sandbox around every Claude Code agent's commands. Petrina builds no sandbox:
// it asks Claude Code for its own through the connector's session option
// (`_meta.claudeCode.options.sandbox`) and says where commands may write. Claude Code enforces it,
// merged with the coordinator's and the product's own Claude Code settings. Auto mode still reviews
// every command, and may let one run outside the sandbox (ssh and headless browsers on a Mac need
// that). Codex keeps its own workspace sandbox, untouched.

import { realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

/** The part of Claude Code's sandbox settings Petrina sets. */
export interface ClaudeSandbox {
  enabled: true;
  /** Required: when it cannot start, Claude Code refuses the conversation instead of running unsandboxed. */
  failIfUnavailable: true;
  /** Off: a sandboxed command is not approved for being sandboxed, so Auto mode reviews every one. */
  autoAllowBashIfSandboxed: false;
  /** Claude Code may still run a command outside the sandbox, when Auto mode approves. */
  allowUnsandboxedCommands: true;
  /** Writes allowed besides the working copy, Claude Code's own default. */
  filesystem: { allowWrite: string[] };
  network: { allowedDomains: string[]; allowLocalBinding?: boolean };
  /** Mac: the system's certificate check (trustd), which gh and other Go tools need. */
  enableWeakerNetworkIsolation?: boolean;
}

export interface Machine {
  home: string;
  tmp: string;
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
}

const thisMachine = (): Machine => ({ home: homedir(), tmp: tmpdir(), platform: process.platform, env: process.env });

/** Claude Code's sandbox for an agent: the same for every role. */
export function claudeSandbox(machine: Machine = thisMachine()): ClaudeSandbox {
  const mac = machine.platform === "darwin";
  return {
    enabled: true,
    failIfUnavailable: true,
    autoAllowBashIfSandboxed: false,
    allowUnsandboxedCommands: true,
    filesystem: { allowWrite: [...new Set(writable(machine))] },
    // Every website, without asking the coordinator; on a Mac, local test servers too.
    network: { allowedDomains: ["*"], ...(mac ? { allowLocalBinding: true } : {}) },
    ...(mac ? { enableWeakerNetworkIsolation: true } : {}),
  };
}

/** Where commands may write besides the working copy: temporary folders, sign-in caches and package download caches. */
function writable({ home, tmp, platform, env }: Machine): string[] {
  const mac = platform === "darwin";
  const windows = platform === "win32";
  const local = env.LOCALAPPDATA || join(home, "AppData", "Local");
  const cache = mac ? join(home, "Library", "Caches") : windows ? local : env.XDG_CACHE_HOME || join(home, ".cache");
  const data = mac ? join(home, "Library") : windows ? local : env.XDG_DATA_HOME || join(home, ".local", "share");
  const npm = windows ? join(local, "npm-cache") : join(home, ".npm");
  return [
    // Temporary folders: the system's and the user's own.
    ...(windows ? [] : ["/tmp"]),
    ...(mac ? ["/private/tmp"] : []),
    tmp,
    real(tmp),
    // Sign-in caches. aws: its SSO, CLI and login caches, never its config or credentials files.
    join(home, ".aws", "sso", "cache"),
    join(home, ".aws", "cli", "cache"),
    join(home, ".aws", "login", "cache"),
    // az, and Git Credential Manager (the Azure DevOps sign-in helper) with its Microsoft sign-in cache.
    env.AZURE_CONFIG_DIR || join(home, ".azure"),
    join(home, ".gcm"),
    windows ? join(local, ".IdentityService") : join(home, ".local", ".IdentityService"),
    // Package managers' download caches, never where they keep installed programs.
    join(npm, "_cacache"),
    join(npm, "_logs"),
    join(home, ".bun", "install", "cache"),
    join(cache, windows ? "pnpm-cache" : "pnpm"),
    join(data, "pnpm", "store"),
    windows ? join(local, "Yarn", "Cache") : join(cache, mac ? "Yarn" : "yarn"),
    join(home, ".yarn", "berry", "cache"),
    join(cache, "pip"),
    windows ? join(local, "uv", "cache") : join(home, ".cache", "uv"),
    join(home, ".cargo", "registry"),
    join(home, ".cargo", "git"),
    join(home, "go", "pkg", "mod"),
    join(cache, "go-build"),
  ];
}

function real(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}
