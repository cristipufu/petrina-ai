import { describe, expect, it } from "bun:test";
import { agentEnv, withoutCredentials } from "@petrina/platform/process-environment";

describe("agent safety", () => {
it("gives agents the coordinator's own logins, with nothing waiting for a typed answer and in the background", () => {
    const logins = { GH_TOKEN: "token", GITHUB_TOKEN: "token", SSH_AUTH_SOCK: "/tmp/agent", AWS_PROFILE: "work", AZURE_CONFIG_DIR: "/u/.azure", GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "credential.helper", GIT_CONFIG_VALUE_0: "manager", PATH: "/bin" };
    expect(agentEnv(logins)).toEqual({
      ...logins,
      GIT_CONFIG_COUNT: "2",
      GIT_CONFIG_KEY_1: "core.askPass",
      GIT_CONFIG_VALUE_1: "",
      GIT_TERMINAL_PROMPT: "0",
      GH_PROMPT_DISABLED: "1",
      GCM_INTERACTIVE: "never",
      SSH_ASKPASS_REQUIRE: "never",
      BROWSER: "none",
      PETRINA_AGENT: "1",
    });
  });
});

describe("agent safety", () => {
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
});

describe("agent safety", () => {
it("drops GitHub tokens from those steps whatever the variable is called", () => {
    const env = withoutCredentials({ NPM_REGISTRY_TOKEN: "ghp_example", OTHER_PAT: "github_pat_example", APP_TOKEN: "gho_example", NOT_A_TOKEN: "ghost_town", PATH: "/bin" }, "/tmp/empty-gh");
    expect(env.NPM_REGISTRY_TOKEN).toBeUndefined();
    expect(env.OTHER_PAT).toBeUndefined();
    expect(env.APP_TOKEN).toBeUndefined();
    expect(env.NOT_A_TOKEN).toBe("ghost_town");
    expect(env.PATH).toBe("/bin");
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
      GROK_AGENT: "1",
      GROK_SESSION_ID: "outer",
      GROK_HOME: "/home/me/.grok",
    };
    const env = agentEnv(outer);
    for (const name of ["CLAUDECODE", "CLAUDE_CODE_SESSION_ID", "CLAUDE_CODE_MESSAGING_SOCKET", "CLAUDE_CODE_MESSAGING_TOKEN", "CLAUDE_EFFORT", "CODEX_SANDBOX", "GROK_AGENT", "GROK_SESSION_ID"]) expect(env[name]).toBeUndefined();
    expect(env).toMatchObject({ PATH: "/usr/bin", GH_TOKEN: "ghp_example", CLAUDE_CODE_USE_BEDROCK: "1", GROK_HOME: "/home/me/.grok", PETRINA_AGENT: "1" });
    expect(withoutCredentials(outer, "/tmp/gh").CLAUDECODE).toBeUndefined();
  });
});
