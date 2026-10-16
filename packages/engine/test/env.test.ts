import { describe, expect, it } from "bun:test";
import { agentEnv } from "../src/env.js";
import { ADAPTERS } from "../src/tools.js";

describe("agent safety", () => {
  it("runs every tool in its own automatic safety mode", () => {
    expect(ADAPTERS["claude-code"]!.mode).toBe("auto");
    expect(ADAPTERS.codex!.mode).toBe("agent");
  });

  it("gives non-shipper agents no GitHub credentials", () => {
    const env = agentEnv({ GH_TOKEN: "secret", GITHUB_TOKEN: "secret", SSH_AUTH_SOCK: "/tmp/agent", PATH: "/bin" }, "/tmp/empty-gh");
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
