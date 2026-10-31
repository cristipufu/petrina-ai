import {describe,expect,it} from "bun:test";
import {terminalEnv, UnsafeValue} from "../../../src/terminal-plan.js";
import {launchPlan} from "../../fixtures/terminal-plan.js";
import {input,OPENCODE_SESSION,PATHS,SESSION,SECRETS} from "../../fixtures/terminal-input.js";
import type {LaunchInput} from "../../../src/terminal-plan.js";

describe("each system's launch plan", () => {
  for (const platform of ["darwin", "linux", "win32"] as const) {
    for (const toolId of ["claude-code", "codex", "grok", "opencode", "pi"] as const) {
      it(`${platform}, ${toolId}: the tool on the same conversation in its normal mode, with no credentials`, () => {
        const plan = launchPlan(input(platform, toolId));
        const expectedSession = toolId === "opencode" ? OPENCODE_SESSION : SESSION;
        for (const pattern of SECRETS) {
          expect(plan.script).not.toMatch(pattern);
          expect(plan.copy).not.toMatch(pattern);
        }
        // Never a skip-permissions, always-approve or yolo option.
        for (const flag of ["dangerously", "bypass", "approve-for-me", "auto_review", "acceptEdits", "dontAsk", "never", "danger-full-access", "yolo", "always-approve"]) expect(plan.args.join(" ").toLowerCase()).not.toContain(flag.toLowerCase());
        expect(plan.args).toContain(expectedSession);
        expect(plan.args).toContain(
          toolId === "claude-code"
            ? "opus"
            : toolId === "grok"
              ? "grok-4.7"
              : toolId === "opencode"
                ? "anthropic/claude-sonnet-4-5"
                : toolId === "pi"
                  ? "openai/gpt-5"
                  : "gpt-6.1-sol",
        );
        expect(plan.script).toContain(PATHS[platform].worktree);
        // The copied command runs the launcher, nothing else.
        expect(plan.copy).toContain(plan.file);
        expect(plan.copy).not.toContain(expectedSession);
        if (platform === "win32") {
          expect(plan.file).toBe(`${PATHS.win32.dir}\\open.ps1`);
          expect(plan.copy).toBe(`powershell -NoLogo -ExecutionPolicy Bypass -File "${plan.file}"`);
        } else {
          expect(plan.file).toBe(`${PATHS[platform].dir}/open.${platform === "darwin" ? "command" : "sh"}`);
          expect(plan.script.startsWith("#!/bin/sh\n")).toBe(true);
          expect(plan.copy).toBe(`'${plan.file}'`);
        }
      });
    }
  }

  const unsafe: [string, Partial<LaunchInput>][] = [
    ["a folder with a quote", { worktree: "/Users/o'neil/.petrina/worktrees/shop/task-7" }],
    ["a folder with a $", { worktree: "/Users/ana/$HOME/task-7" }],
    ["a folder with a ;", { dir: "/Users/ana/.petrina/takeover/a;rm -rf ~" }],
    ["a folder with a backtick", { worktree: "/Users/ana/`whoami`" }],
    ["a folder with a line break", { worktree: "/Users/ana/x\ny" }],
    ["a folder with ..", { worktree: "/Users/ana/../../etc" }],
    ["a relative folder", { worktree: "worktrees/task-7" }],
    ["a conversation id that is not one", { sessionId: "abc; rm -rf /" }],
    ["a model with a space", { model: "opus --dangerously-skip-permissions" }],
    ["an unknown effort", { effort: "max" }],
    ["a tool path with a pipe", { tool: { id: "claude-code", name: "Claude Code", path: "/usr/bin/claude|sh" } }],
    ["a Windows folder with a %", { platform: "win32", worktree: "C:\\Users\\%USERNAME%\\task-7" }],
    ["a Windows folder with a smart quote", { platform: "win32", worktree: "C:\\Users\\Ana‘s\\task-7" }],
    ["a permission mode that skips prompts", { tool: { id: "claude-code", name: "Claude Code", path: "/usr/bin/claude", mode: "bypassPermissions" as never } }],
  ];
  for (const [what, change] of unsafe) {
    it(`refuses ${what}`, () => {
      expect(() => launchPlan(input(change.platform ?? "darwin", "claude-code", change))).toThrow(UnsafeValue);
    });
  }

  it("Windows: the launcher carries a byte order mark, so Windows PowerShell reads accented folder names as written", () => {
    const plan = launchPlan(input("win32", "codex"));
    expect(plan.script.startsWith("\uFEFF# Petrina")).toBe(true);
    expect(plan.script).toContain("Set-Location -LiteralPath 'C:\\Users\\Ana María\\.petrina\\worktrees\\shop\\task-7'");
    expect(Buffer.from(plan.script, "utf8").subarray(0, 3)).toEqual(Buffer.from([0xef, 0xbb, 0xbf]));
    // One copy at a time: the lock file is held open for this copy alone until it ends.
    expect(plan.script).toContain("[System.IO.File]::Open((Join-Path $dir 'lock'), 'OpenOrCreate', 'ReadWrite', 'None')");
  });

  it("leaves Petrina's own variables out of the terminal and keeps the coordinator's", () => {
    const env = terminalEnv({ PATH: "/usr/bin", HOME: "/Users/ana", PETRINA_HOME: "/x", PETRINA_BRIDGE_SECRET: "s", GH_TOKEN: "theirs" });
    expect(env).toEqual({ PATH: "/usr/bin", HOME: "/Users/ana", GH_TOKEN: "theirs" });
  });
});
