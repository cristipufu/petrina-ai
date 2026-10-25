import { expect, it } from "bun:test";
import { UsageLimited } from "@petrina/agent-runtime/failures";
import { WaitingForUsage } from "../../../src/usage.js";
import { failureReason } from "../../../src/failure-reason.js";
const now = new Date(2026, 9, 17, 15, 0, 0).getTime();
  it("files a task that stopped on any limit as a usage limit in Analytics, whatever the limit is called", () => {
    expect(failureReason(new UsageLimited("claude-code", now, "Claude Code's spend limit"))).toBe("limit");
    expect(failureReason(new UsageLimited("codex", now, "Codex's rate limit"))).toBe("limit");
    expect(failureReason(new WaitingForUsage("Waiting for Claude Code's limit to reset"))).toBe("limit");
    expect(failureReason(new Error("Claude Code's extra usage limit is used up"))).toBe("limit");
    expect(failureReason(new Error("The agent stopped (exit 1)"))).toBe("agent-stopped");
    expect(failureReason(new Error("Builder did not hand back a usable result: no result block"))).toBe("unusable");
    expect(failureReason(new Error("git push failed"))).toBe("other");
  });
