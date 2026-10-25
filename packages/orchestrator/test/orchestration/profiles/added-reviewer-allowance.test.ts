import { expect, it } from "vitest";
import { addRole, libraryRoles, ROLE_STARTS } from "@petrina/core";
import { UsageRecording } from "../../../src/usage-recording.js";
import { profileSelectionFixture } from "../../fixtures/profile-selection.js";

it("keeps added reviewers on their planned tool near its usage limit, just like built-in reviewers", () => {
  const f = profileSelectionFixture();
  const added = addRole({ edits: {}, added: [] }, ROLE_STARTS.find(entry => entry.id === "security")!.draft);
  f.state.roles = libraryRoles(added.changes);
  const reviewer = added.roleId;
  // Capability observations from the role contracts; selector policy remains in the real controller.
  const independent = new Set(["security-reviewer"]);
  f.host.awayFromBuilder = role => independent.has(role.id);
  const recording = new UsageRecording({ pool: () => f.state.pool, record() {}, wake() {}, toolName: id => id });
  const selection = f.selection, state = f.state;
  const recordUsage = (info: Parameters<UsageRecording["record"]>[0]) => recording.record(info, f.now());
      // A provider warning at low measured usage moves no role off its planned profile.
      recordUsage({ toolId: "claude-code", kind: "five_hour", status: "allowed_warning", utilization: 0.26 });
      for (const roleId of [reviewer, "builder", "code-reviewer", "security-reviewer", "design-reviewer", "verifier"]) {
        expect(selection.choose("opus-high", undefined, roleId)).toMatchObject({ kind: "planned", profile: { id: "opus-high" } });
      }
      recordUsage({ toolId: "claude-code", kind: "five_hour", status: "allowed_warning", utilization: 0.95 });
      // An author planned on Claude Code moves to Codex; every reviewer keeps Claude Code instead.
      expect(selection.choose("opus-high", undefined, "builder")).toMatchObject({ kind: "substitute", profile: { toolId: "codex" } });
      for (const roleId of [reviewer, "code-reviewer", "security-reviewer", "design-reviewer", "verifier"]) {
        expect(selection.choose("opus-high", undefined, roleId)).toMatchObject({ kind: "planned", profile: { id: "opus-high" } });
      }
      // A real limit still permits a stand-in; nearing a limit does not.
      state.pool.limited = [{ toolId: "claude-code", until: f.now() + 60_000, reason: "Usage used up" }];
      expect(selection.choose("opus-high", undefined, reviewer)).toMatchObject({ kind: "substitute", profile: { toolId: "codex" } });
});
