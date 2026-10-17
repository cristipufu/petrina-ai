import { describe, expect, it } from "bun:test";
import { agentEnv, loginShellPath, mergePath, pathFromEnv, withoutCredentials } from "../src/env.js";
import { ADAPTERS } from "../src/tools.js";
import { BACKGROUND } from "../src/prompts.js";
import { join } from "node:path";

describe("agent safety", () => {
  it("runs every tool in its own automatic safety mode", () => {
    expect(ADAPTERS["claude-code"]!.mode).toBe("auto");
    expect(ADAPTERS.codex!.mode).toBe("agent");
  });

  it("gives agents the coordinator's own logins, with nothing waiting for a typed answer and in the background", () => {
    const logins = { GH_TOKEN: "token", GITHUB_TOKEN: "token", SSH_AUTH_SOCK: "/tmp/agent", AWS_PROFILE: "work", AZURE_CONFIG_DIR: "/u/.azure", GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "credential.helper", GIT_CONFIG_VALUE_0: "manager", PATH: "/bin" };
    expect(agentEnv(logins)).toEqual({ ...logins, GIT_TERMINAL_PROMPT: "0", GH_PROMPT_DISABLED: "1", BROWSER: "none", PETRINA_AGENT: "1" });
  });

  it("runs Petrina's own git steps on working copies with no login at all", () => {
    const env = withoutCredentials({ GH_TOKEN: "secret", GITHUB_TOKEN: "secret", SSH_AUTH_SOCK: "/tmp/agent", PATH: "/bin" }, "/tmp/empty-gh");
    expect(env.GH_TOKEN).toBeUndefined();
    expect(env.GITHUB_TOKEN).toBeUndefined();
    expect(env.SSH_AUTH_SOCK).toBeUndefined();
    expect(env.GH_CONFIG_DIR).toBe("/tmp/empty-gh");
    expect(env.GIT_CONFIG_KEY_0).toBe("credential.helper");
    expect(env.GIT_CONFIG_VALUE_0).toBe("");
    expect(env.GIT_SSH_COMMAND).toBe("petrina-ssh-disabled");
    expect(env.PATH).toBe("/bin");
  });

  it("drops GitHub tokens from those steps whatever the variable is called", () => {
    const env = withoutCredentials({ NPM_REGISTRY_TOKEN: "ghp_example", OTHER_PAT: "github_pat_example", APP_TOKEN: "gho_example", NOT_A_TOKEN: "ghost_town", PATH: "/bin" }, "/tmp/empty-gh");
    expect(env.NPM_REGISTRY_TOKEN).toBeUndefined();
    expect(env.OTHER_PAT).toBeUndefined();
    expect(env.APP_TOKEN).toBeUndefined();
    expect(env.NOT_A_TOKEN).toBe("ghost_town");
    expect(env.PATH).toBe("/bin");
  });
});

describe("the PATH an app opened from the Dock gets", () => {
  it("reads the PATH between the markers, whatever the shell printed around them", () => {
    expect(pathFromEnv("Welcome!\n__petrina_env__\nHOME=/u\nPATH=/opt/bin:/usr/bin\n__petrina_env__\n")).toBe("/opt/bin:/usr/bin");
    expect(pathFromEnv("no markers\nPATH=/x\n")).toBeUndefined();
  });

  it("puts the terminal's PATH first and keeps what only the app had", () => {
    expect(mergePath("/opt/homebrew/bin:/usr/bin", "/usr/bin:/bin", ":")).toBe("/opt/homebrew/bin:/usr/bin:/bin");
    expect(mergePath(undefined, "/usr/bin", ":")).toBe("/usr/bin");
  });

  it.skipIf(process.platform === "win32")("asks the login shell", async () => {
    const path = await loginShellPath({ ...process.env, SHELL: "/bin/sh" });
    expect(path?.split(":").length).toBeGreaterThan(0);
  });

  it("keeps agents in the background", () => {
    expect(BACKGROUND).toContain("Never open windows or apps");
    const result = Bun.spawnSync(["bun", join(import.meta.dir, "../src/cli.ts"), "open"], { env: { ...process.env, PETRINA_AGENT: "1", PETRINA_HOME: "/nonexistent-petrina-home" } });
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain("Agents work in the background");
  });

  it("reads the PATH even when the shell exports the marker as `_` (dash)", () => {
    const output = ["__petrina_env__", "_=__petrina_env__", "HOME=/home/me", "PATH=/usr/local/bin:/usr/bin", "__petrina_env__", ""].join("\n");
    expect(pathFromEnv(output)).toBe("/usr/local/bin:/usr/bin");
    expect(pathFromEnv("no markers here")).toBeUndefined();
  });
});

describe("an engine started from inside another coding agent's session", () => {
  it("gives its agents a session of their own: that session's markers stay behind, the coordinator's logins and settings go along", () => {
    const outer = {
      PATH: "/usr/bin",
      GH_TOKEN: "ghp_example",
      CLAUDE_CODE_USE_BEDROCK: "1",
      CLAUDECODE: "1",
      CLAUDE_CODE_SESSION_ID: "outer",
      CLAUDE_CODE_MESSAGING_SOCKET: "/tmp/outer.sock",
      CLAUDE_CODE_MESSAGING_TOKEN: "secret",
      CLAUDE_EFFORT: "low",
      CODEX_SANDBOX: "seatbelt",
    };
    const env = agentEnv(outer);
    for (const name of ["CLAUDECODE", "CLAUDE_CODE_SESSION_ID", "CLAUDE_CODE_MESSAGING_SOCKET", "CLAUDE_CODE_MESSAGING_TOKEN", "CLAUDE_EFFORT", "CODEX_SANDBOX"]) expect(env[name]).toBeUndefined();
    expect(env).toMatchObject({ PATH: "/usr/bin", GH_TOKEN: "ghp_example", CLAUDE_CODE_USE_BEDROCK: "1", PETRINA_AGENT: "1" });
    expect(withoutCredentials(outer, "/tmp/gh").CLAUDECODE).toBeUndefined();
  });
});
