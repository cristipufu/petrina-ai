import { describe, expect, it } from "bun:test";
import { claudeSandbox } from "../../../src/sandbox.js";

describe("what Petrina asks of Claude Code's sandbox", () => {
  const mac = { home: "/Users/me", tmp: "/var/folders/xy/T", platform: "darwin" as const, env: {} };

  it("required, every command reviewed by Auto mode, with Claude Code's own escape hatch kept", () => {
    const sandbox = claudeSandbox(mac);
    expect(sandbox).toMatchObject({ enabled: true, failIfUnavailable: true, autoAllowBashIfSandboxed: false, allowUnsandboxedCommands: true });
    // Every website without a question; on a Mac, local test servers and the system's certificate check.
    expect(sandbox.network).toEqual({ allowedDomains: ["*"], allowLocalBinding: true });
    expect(sandbox.enableWeakerNetworkIsolation).toBe(true);
    // Nothing else: no command lists, no reading limits, no credential rules.
    expect(Object.keys(sandbox).sort()).toEqual(["allowUnsandboxedCommands", "autoAllowBashIfSandboxed", "enableWeakerNetworkIsolation", "enabled", "failIfUnavailable", "filesystem", "network"]);
    expect(Object.keys(sandbox.filesystem)).toEqual(["allowWrite"]);
    const linux = claudeSandbox({ ...mac, home: "/home/me", tmp: "/tmp", platform: "linux" });
    expect(linux.network).toEqual({ allowedDomains: ["*"] });
    expect(linux.enableWeakerNetworkIsolation).toBeUndefined();
  });

  it("writes only to temporary folders, sign-in caches and package download caches, beside the working copy", () => {
    const write = claudeSandbox(mac).filesystem.allowWrite;
    for (const path of [
      "/tmp",
      "/private/tmp",
      "/var/folders/xy/T",
      "/Users/me/.aws/sso/cache",
      "/Users/me/.aws/cli/cache",
      "/Users/me/.aws/login/cache",
      "/Users/me/.azure",
      "/Users/me/.gcm",
      "/Users/me/.local/.IdentityService",
      "/Users/me/.npm/_cacache",
      "/Users/me/.bun/install/cache",
      "/Users/me/Library/Caches/pnpm",
      "/Users/me/Library/pnpm/store",
      "/Users/me/Library/Caches/Yarn",
      "/Users/me/Library/Caches/pip",
      "/Users/me/.cargo/registry",
      "/Users/me/go/pkg/mod",
    ])
      expect(write).toContain(path);
    // Never aws's settings or credentials, the home folder itself, or where tools keep installed programs.
    for (const path of ["/Users/me", "/Users/me/.aws", "/Users/me/.aws/config", "/Users/me/.aws/credentials", "/Users/me/.bun", "/Users/me/.bun/bin", "/Users/me/.cargo", "/Users/me/.cargo/bin", "/Users/me/.npm", "/Users/me/Library/pnpm", "/Users/me/.ssh", "/Users/me/.config/gh"])
      expect(write).not.toContain(path);
    expect(new Set(write).size).toBe(write.length);
  });

  it("follows the coordinator's own az folder", () => {
    expect(claudeSandbox({ ...mac, env: { AZURE_CONFIG_DIR: "/Users/me/work/azure" } }).filesystem.allowWrite).toContain("/Users/me/work/azure");
  });

});
