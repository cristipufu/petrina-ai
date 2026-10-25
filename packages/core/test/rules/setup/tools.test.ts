import { describe, expect, it } from "vitest";

import { CHECK_NAMES, fixFor, isGuide, toolsGate, usableAgentTools, wontStartFix, type CheckId, type CheckStatus, type Platform, type ToolCheck } from "../../../src/setup.js";

const checks = (statuses: Partial<Record<CheckId, CheckStatus>>): ToolCheck[] => Object.entries(statuses).map(([id, status]) => ({ id: id as CheckId, status: status! }));

const all = { git: "ready", node: "ready", gh: "ready" } as const;

const sentences = (text: string) => text.split(/[.!?](?:\s|$)/).filter((part) => part.trim()).length;

describe("which agent tools the squad uses", () => {
  it("uses an installed Antigravity alone or as a fourth independent tool, and excludes its logged-out or absent state", () => {
    expect(usableAgentTools(checks({ "claude-code": "ready", codex: "ready", grok: "ready", antigravity: "ready" }))).toEqual(["claude-code", "codex", "grok", "antigravity"]);
    expect(usableAgentTools(checks({ "claude-code": "logged-out", codex: "not-installed", grok: "logged-out", antigravity: "ready" }))).toEqual(["antigravity"]);
    expect(usableAgentTools(checks({ "claude-code": "ready", antigravity: "logged-out" }))).toEqual(["claude-code"]);
    expect(toolsGate(checks({ ...all, "claude-code": "not-installed", codex: "not-installed", antigravity: "ready" })).ok).toBe(true);
  });

  it("uses the Ready ones, and only if none is Ready, the ones Petrina couldn't check", () => {
    expect(usableAgentTools(checks({ "claude-code": "ready", codex: "ready" }))).toEqual(["claude-code", "codex"]);
    expect(usableAgentTools(checks({ "claude-code": "unknown", codex: "ready" }))).toEqual(["codex"]);
    expect(usableAgentTools(checks({ "claude-code": "unknown", codex: "logged-out" }))).toEqual(["claude-code"]);
    expect(usableAgentTools(checks({ "claude-code": "not-installed", codex: "logged-out" }))).toEqual([]);
  });

  it("changes nothing before any check has answered", () => {
    expect(usableAgentTools(undefined)).toEqual(["claude-code", "codex"]);
    expect(usableAgentTools([])).toEqual(["claude-code", "codex"]);
  });

  it("keeps Grok available after the merge and applies the same login rules", () => {
    expect(usableAgentTools(checks({ "claude-code": "ready", codex: "ready", grok: "ready" }))).toEqual(["claude-code", "codex", "grok"]);
    expect(usableAgentTools(checks({ "claude-code": "unknown", codex: "logged-out", grok: "ready" }))).toEqual(["grok"]);
    expect(usableAgentTools(checks({ "claude-code": "unknown", codex: "logged-out", grok: "logged-out" }))).toEqual(["claude-code"]);
    expect(usableAgentTools(checks({ "claude-code": "unknown", codex: "unknown", grok: "not-installed" }))).toEqual(["claude-code", "codex"]);
    expect(toolsGate(checks({ ...all, "claude-code": "unknown", codex: "logged-out", grok: "ready" })).notes.join(" ")).not.toContain("so it will try");
  });
});

describe("the Tools screen with Grok", () => {
  it("goes on with Grok alone, since the squad can run a whole task on it", () => {
    const gate = toolsGate(checks({ ...all, "claude-code": "not-installed", codex: "logged-out", grok: "ready" }));
    expect(gate).toEqual({ ok: true, notes: ["Only Grok is set up, so agents will review each other's work on the same tool, and setting up Claude Code or Codex gives a second opinion."] });
    expect(toolsGate(checks({ ...all, "claude-code": "logged-out", codex: "not-installed", grok: "unknown" }))).toMatchObject({ ok: true, notes: [expect.stringContaining("Only Grok is set up"), "Petrina couldn't confirm Grok, so it will try it and tell you if it can't start."] });
  });

  it("names Grok only when it is installed", () => {
    expect(toolsGate(checks({ ...all, "claude-code": "not-installed", codex: "logged-out", grok: "logged-out" })).missing).toBe("To go on, Petrina needs Claude Code, Codex or Grok, and the fix is above.");
    expect(toolsGate(checks({ ...all, "claude-code": "not-installed", codex: "logged-out", grok: "not-installed" })).missing).toBe("To go on, Petrina needs Claude Code or Codex, and the fix is above.");
    // Grok not installed: the notes are as they were with two tools.
    expect(toolsGate(checks({ ...all, "claude-code": "ready", codex: "logged-out", grok: "not-installed" })).notes).toEqual(["Only Claude Code is set up, so agents will review each other's work on the same tool, and setting up Codex gives a second opinion."]);
  });

  it("counts Grok among the second opinions and the tools Petrina couldn't confirm", () => {
    expect(toolsGate(checks({ ...all, "claude-code": "ready", codex: "not-installed", grok: "logged-out" })).notes).toEqual(["Only Claude Code is set up, so agents will review each other's work on the same tool, and setting up Codex or Grok gives a second opinion."]);
    expect(toolsGate(checks({ ...all, "claude-code": "ready", codex: "not-installed", grok: "unknown" })).notes).toEqual(["Petrina couldn't confirm Grok, so agents will review each other's work on Claude Code alone until Grok checks out as Ready."]);
    expect(toolsGate(checks({ ...all, "claude-code": "ready", codex: "unknown", grok: "unknown" })).notes).toEqual(["Petrina couldn't confirm Codex and Grok, so agents will review each other's work on Claude Code alone until one of them checks out as Ready."]);
    // Grok still checking: no note its answer could take back.
    expect(toolsGate(checks({ ...all, "claude-code": "ready", codex: "not-installed", grok: "unchecked" })).notes).toEqual([]);
    // Two Ready tools: no single-tool note.
    expect(toolsGate(checks({ ...all, "claude-code": "not-installed", codex: "ready", grok: "ready" })).notes).toEqual([]);
  });
});

describe("the Tools screen's Continue", () => {
  it("goes on with Git, Node.js and one agent tool that is Ready or couldn't be checked, without waiting for slower rows", () => {
    expect(toolsGate(checks({ ...all, "claude-code": "ready", codex: "ready" }))).toEqual({ ok: true, notes: [] });
    // Codex and the GitHub CLI still checking: Continue does not wait for them.
    expect(toolsGate(checks({ git: "ready", node: "unknown", "claude-code": "ready" })).ok).toBe(true);
  });

  it("says in one sentence what is missing", () => {
    const noAgents = toolsGate(checks({ ...all, "claude-code": "not-installed", codex: "logged-out" }));
    expect(noAgents).toMatchObject({ ok: false, missing: "To go on, Petrina needs Claude Code or Codex, and the fix is above." });
    const noGit = toolsGate(checks({ ...all, git: "not-installed", "claude-code": "ready" }));
    expect(noGit.missing).toBe("To go on, Petrina needs Git, and the fix is above.");
    const waiting = toolsGate(checks({ "claude-code": "ready", node: "ready" }));
    expect(waiting).toMatchObject({ ok: false, missing: "Waiting for the check of Git." });
  });

  it("notes a single tool, tools it will only try, and a GitHub CLI that is not ready", () => {
    const one = toolsGate(checks({ git: "ready", node: "ready", gh: "logged-out", "claude-code": "unknown", codex: "not-installed" }));
    expect(one.ok).toBe(true);
    expect(one.notes).toEqual([
      "Only Claude Code is set up, so agents will review each other's work on the same tool, and setting up Codex gives a second opinion.",
      "Petrina couldn't confirm Claude Code, so it will try it and tell you if it can't start.",
      "You can set up the GitHub CLI later, but Petrina needs it logged in before it opens your first pull request.",
    ]);
    for (const note of one.notes) expect(sentences(note)).toBe(1);
  });

  it("notes the same tool when the other is one Petrina couldn't check, since the squad uses only the Ready one", () => {
    const uncertain = toolsGate(checks({ ...all, "claude-code": "ready", codex: "unknown" }));
    expect(usableAgentTools(checks({ "claude-code": "ready", codex: "unknown" }))).toEqual(["claude-code"]);
    expect(uncertain).toEqual({ ok: true, notes: ["Petrina couldn't confirm Codex, so agents will review each other's work on Claude Code alone until Codex checks out as Ready."] });
    // Both uncertain: the squad tries both, so no same-tool note, only that it will try them.
    expect(toolsGate(checks({ ...all, "claude-code": "unknown", codex: "unknown" })).notes).toEqual(["Petrina couldn't confirm Claude Code and Codex, so it will try them and tell you if one can't start."]);
    // The other still checking: no note its answer could take back.
    expect(toolsGate(checks({ ...all, "claude-code": "ready" })).notes).toEqual([]);
  });
});

describe("fixes", () => {
  const platforms: Platform[] = ["darwin", "win32", "linux"];

  const ids = Object.keys(CHECK_NAMES) as CheckId[];

  it("give uncertain checks a retry instruction and only confirmed setup problems a terminal command", () => {
    for (const platform of platforms) {
      for (const id of ids) {
        expect(fixFor(id, "ready", platform)).toBeUndefined();
        for (const status of ["not-installed", "logged-out", "unknown"] as const) {
          const fix = fixFor(id, status, platform)!;
          expect(sentences(fix.sentence)).toBe(1);
          if (status === "unknown") {
            expect(fix.command).toBeUndefined();
            expect(fix.sentence).toContain("Check again");
            expect(fix.sentence).not.toMatch(/log in|install.*again/);
          } else {
            expect(fix.command).toMatch(/^[\w-]/);
            expect(fix.command).not.toContain("\n");
          }
          expect(fix.guide).toMatch(/^https:\/\//);
          expect(isGuide(fix.guide)).toBe(true);
        }
        expect(isGuide(wontStartFix(id, platform).guide)).toBe(true);
        expect(sentences(wontStartFix(id, platform).sentence)).toBe(1);
      }
    }
    expect(fixFor("codex", "logged-out", "darwin")!.command).toBe("codex login");
    expect(fixFor("git", "not-installed", "darwin")!.command).toBe("xcode-select --install");
    expect(fixFor("git", "not-installed", "win32")!.sentence).toContain("in a terminal");
    expect(isGuide("https://example.com/")).toBe(false);
  });
});
