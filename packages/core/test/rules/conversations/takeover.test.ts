import { describe, expect, it } from "vitest";
import type { State, Task } from "../../../src/model.js";
import { TAKE_OVER_WORDS, takeOverBlock } from "../../../src/takeover.js";

const state: Pick<State, "profiles" | "tools"> = {
  profiles: [
    { id: "opus-high", toolId: "claude-code", model: "Opus 5.5", modelId: "opus", effort: "high" },
    { id: "sol-high", toolId: "codex", model: "sol", modelId: "gpt-6.1-sol", effort: "high" },
    { id: "custom", toolId: "custom-tool", model: "Custom", effort: "high" },
    { id: "grok-high", toolId: "grok", model: "Grok 4.7", modelId: "grok-4.7", effort: "high" },
    { id: "flash-medium", toolId: "antigravity", model: "Gemini 3.8 Flash", modelId: "gemini-3.8-flash", effort: "medium" },
    { id: "opencode-sonnet-high", toolId: "opencode", model: "Claude Sonnet 4.5", modelId: "anthropic/claude-sonnet-4-5", effort: "high" },
    { id: "pi-sonnet-high", toolId: "pi", model: "Claude Sonnet 4.5", modelId: "anthropic/claude-sonnet-4-5", effort: "high" },
  ],
  tools: [
    { id: "claude-code", name: "Claude Code", command: [], status: "ready", models: [] },
    { id: "codex", name: "Codex", command: [], status: "not-installed", models: [] },
    { id: "custom-tool", name: "Custom CLI", command: [], status: "ready", models: [] },
    { id: "grok", name: "Grok", command: [], status: "ready", models: [] },
    { id: "antigravity", name: "Antigravity", command: [], status: "ready", models: [] },
    { id: "opencode", name: "OpenCode", command: [], status: "ready", models: [] },
    { id: "pi", name: "Pi", command: [], status: "ready", models: [] },
  ],
};

function task(change: Partial<Task> = {}): Task {
  return {
    id: "task-1",
    state: "running",
    holdsSlot: true,
    agent: { roleId: "builder", profileId: "opus-high", since: 0, step: 0 },
    conversation: { step: "s", roleId: "builder", profileId: "opus-high", toolId: "claude-code", model: "opus", sessionId: "x", startedAt: 0, briefed: true },
    ...change,
  } as Task;
}

describe("whether the coordinator can take over", () => {
  it("can while an agent other than the Release Manager works or waits on them, on Claude Code, Codex, Grok or Antigravity, with its instructions", () => {
    expect(takeOverBlock(task(), state)).toBeUndefined();
    expect(takeOverBlock(task({ state: "needs-you" }), state)).toBeUndefined();
    expect(
      takeOverBlock(
        task({
          agent: { roleId: "builder", profileId: "grok-high", since: 0, step: 0 },
          conversation: { ...task().conversation!, profileId: "grok-high", toolId: "grok", model: "grok-4.7" },
        }),
        state,
      ),
    ).toBeUndefined();
    expect(
      takeOverBlock(
        task({
          agent: { roleId: "builder", profileId: "flash-medium", since: 0, step: 0 },
          conversation: { ...task().conversation!, profileId: "flash-medium", toolId: "antigravity", model: "gemini-3.8-flash" },
        }),
        state,
      ),
    ).toBeUndefined();
    expect(
      takeOverBlock(
        task({
          agent: { roleId: "builder", profileId: "opencode-sonnet-high", since: 0, step: 0 },
          conversation: { ...task().conversation!, profileId: "opencode-sonnet-high", toolId: "opencode", model: "anthropic/claude-sonnet-4-5" },
        }),
        state,
      ),
    ).toBeUndefined();
    expect(
      takeOverBlock(
        task({
          agent: { roleId: "builder", profileId: "pi-sonnet-high", since: 0, step: 0 },
          conversation: { ...task().conversation!, profileId: "pi-sonnet-high", toolId: "pi", model: "anthropic/claude-sonnet-4-5" },
        }),
        state,
      ),
    ).toBeUndefined();
  });

  it("says why not, in one line", () => {
    const missingAntigravity = {
      ...state,
      tools: state.tools.map((tool) => (tool.id === "antigravity" ? { ...tool, status: "not-installed" as const } : tool)),
    };
    expect(
      takeOverBlock(
        task({
          agent: { roleId: "builder", profileId: "flash-medium", since: 0, step: 0 },
          conversation: { ...task().conversation!, profileId: "flash-medium", toolId: "antigravity", model: "gemini-3.8-flash" },
        }),
        missingAntigravity,
      ),
    ).toBe("Antigravity isn't installed on this machine");
    const missingOpenCode = {
      ...state,
      tools: state.tools.map((tool) => (tool.id === "opencode" ? { ...tool, status: "not-installed" as const } : tool)),
    };
    expect(
      takeOverBlock(
        task({
          agent: { roleId: "builder", profileId: "opencode-sonnet-high", since: 0, step: 0 },
          conversation: { ...task().conversation!, profileId: "opencode-sonnet-high", toolId: "opencode", model: "anthropic/claude-sonnet-4-5" },
        }),
        missingOpenCode,
      ),
    ).toBe("OpenCode isn't installed on this machine");
    const missingPi = {
      ...state,
      tools: state.tools.map((tool) => (tool.id === "pi" ? { ...tool, status: "not-installed" as const } : tool)),
    };
    expect(
      takeOverBlock(
        task({
          agent: { roleId: "builder", profileId: "pi-sonnet-high", since: 0, step: 0 },
          conversation: { ...task().conversation!, profileId: "pi-sonnet-high", toolId: "pi", model: "anthropic/claude-sonnet-4-5" },
        }),
        missingPi,
      ),
    ).toBe("Pi isn't installed on this machine");
    expect(takeOverBlock(task({ agent: undefined }), state)).toBe(TAKE_OVER_WORDS.noAgent);
    expect(takeOverBlock(task({ state: "waiting", holdsSlot: false }), state)).toBe(TAKE_OVER_WORDS.noAgent);
    expect(takeOverBlock(task({ state: "needs-you", holdsSlot: false }), state)).toBe(TAKE_OVER_WORDS.noAgent);
    expect(takeOverBlock(task({ agent: { roleId: "release-manager", profileId: "opus-high", since: 0, step: 0 } }), state)).toBe(TAKE_OVER_WORDS.releaseManager);
    expect(takeOverBlock(task({ conversation: undefined }), state)).toBe(TAKE_OVER_WORDS.starting);
    expect(takeOverBlock(task({ conversation: { ...task().conversation!, briefed: false } }), state)).toBe(TAKE_OVER_WORDS.starting);
    expect(takeOverBlock(task({ agent: { roleId: "builder", profileId: "custom", since: 0, step: 0 } }), state)).toBe(TAKE_OVER_WORDS.unsupported);
    expect(takeOverBlock(task({ agent: { roleId: "builder", profileId: "sol-high", since: 0, step: 0 } }), state)).toBe("Codex isn't installed on this machine");
    expect(takeOverBlock(task({ driving: { since: 0, roleId: "builder", profileId: "opus-high", toolId: "claude-code", head: "abc" } }), state)).toBe(TAKE_OVER_WORDS.driving);
  });
});
