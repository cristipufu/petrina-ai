import { expect, it } from "bun:test";
import { sandboxFailure } from "../../../src/sandbox-failures.js";

  it("reads Claude Code's own report that its sandbox cannot start, in plain words", () => {
    const report = (details: string) => Object.assign(new Error("Internal error"), { code: -32603, data: { details } });
    expect(
      sandboxFailure(
        report(
          "Claude Code returned an error result: Sandbox required but unavailable: sandbox is enabled but dependencies are missing: bubblewrap (bwrap) not installed, socat not installed · install missing tools (e.g. apt install bubblewrap socat) or see https://code.claude.com/docs/en/sandboxing. Set sandbox.failIfUnavailable=false to allow unsandboxed execution.",
        ),
      ),
    ).toBe("this computer lacks what it needs (bubblewrap (bwrap) not installed, socat not installed)");
    expect(sandboxFailure(report("Claude Code returned an error result: Sandbox required but unavailable: sandbox is enabled but the Windows sandbox is not active on this session (feature gate off). Set sandbox.failIfUnavailable=false to allow unsandboxed execution."))).toBe(
      "it is not switched on for Windows on this computer",
    );
    expect(sandboxFailure(report("Claude Code returned an error result: Sandbox required but unavailable: sandbox is enabled but freebsd is not supported (requires macOS, Linux, or WSL2). Set sandbox.failIfUnavailable=false to allow unsandboxed execution."))).toBe(
      "it does not run on this system",
    );
    // Broken sandbox settings are not a missing sandbox: Claude Code keeps it required, and Petrina keeps it on for everyone else.
    expect(sandboxFailure(report("Sandbox is required but failed to initialize: invalid sandbox settings. Fix the sandbox settings to retry (a --settings file is pinned for the process: restart)."))).toBeUndefined();
    // Any other failure to open is not about the sandbox.
    expect(sandboxFailure(report("Claude Code returned an error result: Authentication required"))).toBeUndefined();
    expect(sandboxFailure(new Error("Resource not found"))).toBeUndefined();
    expect(sandboxFailure(undefined)).toBeUndefined();
  });
