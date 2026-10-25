import { describe, expect, it } from "bun:test";
import { ADAPTERS } from "@petrina/agent-runtime/tools";

describe("agent safety", () => {
it("runs every tool in its own automatic safety mode", () => {
    expect(ADAPTERS["claude-code"]!.mode).toBe("auto");
    expect(ADAPTERS.codex!.mode).toBe("agent");
    expect(ADAPTERS.grok).toMatchObject({ mode: "auto", command: ["grok", "--permission-mode", "auto", "agent", "stdio"], sessionMeta: { autoMode: true } });
    expect(JSON.stringify(ADAPTERS.grok)).not.toMatch(/yolo|always-approve|bypassPermissions/);
  });
});
