import {describe,expect,it} from "bun:test";
import {toolArgs} from "../../../src/terminal.js";
import {input,PATHS,SESSION} from "../../fixtures/terminal-input.js";

describe("each system's launch plan",()=>{
it("asks Claude Code for its ask-before-acting mode, and Codex for its workspace sandbox with approvals the coordinator answers", () => {
    expect(toolArgs(input("darwin", "claude-code"))).toEqual([PATHS.darwin.claude, "--resume", SESSION, "--model", "opus", "--effort", "xhigh", "--permission-mode", "default"]);
    const current = input("darwin", "claude-code");
    expect(toolArgs({ ...current, tool: { ...current.tool, mode: "manual" } }).slice(-2)).toEqual(["--permission-mode", "manual"]);
    expect(toolArgs(input("darwin", "codex"))).toEqual([PATHS.darwin.codex, "resume", SESSION, "--model", "gpt-6.1-sol", "-c", "model_reasoning_effort=xhigh", "--sandbox", "workspace-write", "--ask-for-approval", "on-request", "-c", "approvals_reviewer=user", "--no-daemon"]);
    expect(toolArgs(input("darwin", "grok"))).toEqual([PATHS.darwin.grok, "--resume", SESSION, "--model", "grok-4.7", "--effort", "xhigh"]);
  });
});
