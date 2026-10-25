import { expect, it } from "vitest";
import { verifierProfiles } from "../../../src/verifier-panel.js";
import { verifierProfileFixture } from "../../fixtures/verifier-profiles.js";

it("uses high-effort verifiers without changing discovery profiles, retaining a configured fallback when high is absent", () => {
  const { input, stage } = verifierProfileFixture();
  const voters = verifierProfiles(input);
  expect(voters.length).toBeGreaterThan(1);
  expect(voters.every(id => input.profiles.find(profile => profile.id === id)!.effort === "high")).toBe(true);
  expect(stage.profileIds).toEqual(["opus-xhigh", "sol-xhigh"]);
  input.profiles = input.profiles.filter(profile => profile.toolId !== "codex" || profile.effort !== "high");
  expect(verifierProfiles(input)).toContain("sol-xhigh");
});

it("keeps ready tools in their declared order and within the usable set without mutating the catalog", () => {
  const { input } = verifierProfileFixture();
  input.tools = [...input.tools].reverse(); input.usable = ["codex", "grok"];
  const before = JSON.parse(JSON.stringify(input)) as typeof input;
  expect(verifierProfiles(input)).toEqual(["grok-high", "sol-high"]);
  expect(input).toEqual(before);
});

it.each(["not-installed", "logged-out"] as const)("keeps the stage's candidates when every tool is %s, leaving availability to resolution", status => {
  const { input } = verifierProfileFixture();
  input.tools = input.tools.map(tool => ({ ...tool, status })); input.usable = [];
  expect(verifierProfiles(input)).toEqual(["opus-high", "sol-high"]);
});

it("excludes standby high profiles, prefers the planned choice and otherwise keeps the first current profile", () => {
  const { input } = verifierProfileFixture();
  const medium = input.profiles.find(profile => profile.id === "sol-medium")!;
  input.profiles = [medium, ...input.profiles.filter(profile => profile.id !== medium.id)].map(profile => profile.id === "sol-high" ? { ...profile, standby: true } : profile);
  input.tools = [{ id: "codex", status: "ready" }]; input.usable = ["codex"];
  expect(verifierProfiles(input)).toEqual(["sol-xhigh"]);
  input.planned = [];
  expect(verifierProfiles(input)).toEqual(["sol-medium"]);
});
