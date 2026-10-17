import { describe, expect, it } from "vitest";
import type { State, Task } from "../src/model.js";
import { TAKE_OVER_WORDS, takeOverBlock } from "../src/takeover.js";

const state: Pick<State, "profiles" | "tools"> = {
  profiles: [
    { id: "opus-high", toolId: "claude-code", model: "Opus 5.5", modelId: "opus", effort: "high" },
    { id: "sol-high", toolId: "codex", model: "sol", modelId: "gpt-6.1-sol", effort: "high" },
    { id: "gem", toolId: "gemini", model: "Gemini", effort: "high" },
  ],
  tools: [
    { id: "claude-code", name: "Claude Code", command: [], status: "ready", models: [] },
    { id: "codex", name: "Codex", command: [], status: "not-installed", models: [] },
    { id: "gemini", name: "Gemini CLI", command: [], status: "ready", models: [] },
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
  it("can while an agent other than the Release Manager works or waits on them, on Claude Code or Codex, with its instructions", () => {
    expect(takeOverBlock(task(), state)).toBeUndefined();
    expect(takeOverBlock(task({ state: "needs-you" }), state)).toBeUndefined();
  });

  it("says why not, in one line", () => {
    expect(takeOverBlock(task({ agent: undefined }), state)).toBe(TAKE_OVER_WORDS.noAgent);
    expect(takeOverBlock(task({ state: "waiting", holdsSlot: false }), state)).toBe(TAKE_OVER_WORDS.noAgent);
    expect(takeOverBlock(task({ state: "needs-you", holdsSlot: false }), state)).toBe(TAKE_OVER_WORDS.noAgent);
    expect(takeOverBlock(task({ agent: { roleId: "release-manager", profileId: "opus-high", since: 0, step: 0 } }), state)).toBe(TAKE_OVER_WORDS.releaseManager);
    expect(takeOverBlock(task({ conversation: undefined }), state)).toBe(TAKE_OVER_WORDS.starting);
    expect(takeOverBlock(task({ conversation: { ...task().conversation!, briefed: false } }), state)).toBe(TAKE_OVER_WORDS.starting);
    expect(takeOverBlock(task({ agent: { roleId: "builder", profileId: "gem", since: 0, step: 0 } }), state)).toBe(TAKE_OVER_WORDS.unsupported);
    expect(takeOverBlock(task({ agent: { roleId: "builder", profileId: "sol-high", since: 0, step: 0 } }), state)).toBe("Codex isn't installed on this machine");
    expect(takeOverBlock(task({ driving: { since: 0, roleId: "builder", profileId: "opus-high", toolId: "claude-code", head: "abc" } }), state)).toBe(TAKE_OVER_WORDS.driving);
  });
});
