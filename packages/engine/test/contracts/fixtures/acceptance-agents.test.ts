import { afterAll, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { BUILT_IN_ROLES, DEFAULT_PROFILES, type Role } from "@petrina/core";
import type { AgentSessionOptions } from "../../../src/agent-session.js";
import { acceptanceAgents, type AcceptanceScript } from "../../fixtures/acceptance-agents.js";
import { removeDir, tempDir } from "../../fixtures.js";
import { expectRejection } from "../../rejections.js";
import { parseResult } from "../../../src/prompts.js";
import { ReviewResult, TestResult } from "../../../src/roles.js";

const roots: string[] = [];
afterAll(() => roots.forEach(removeDir));
function options(profileId = "opus-high"): AgentSessionOptions {
  const cwd = tempDir("acceptance-agent-contract-"); roots.push(cwd);
  return { profile: { ...DEFAULT_PROFILES.find(profile => profile.id === profileId)! }, cwd, browser: false, signal: new AbortController().signal,
    callbacks: { onActivity() {}, onPlanStep() {}, onPermission: async () => "deny" } };
}
const role = (result: Role["result"]) => BUILT_IN_ROLES.find(role => role.result === result)!;

it("declares fresh-only scenarios, resumes only when configured, and writes distinct repairs without a clock", async () => {
  const responses = acceptanceAgents(), launch = options(), builder = role("build");
  responses.configure({ builder: "plain", fixes: "change" });
  const first = await responses.start(launch, builder);
  await first.prompt("Build the greeting"); await first.stop();
  await expectRejection(responses.start({ ...launch, reopen: first.sessionId }, builder), "does not reopen conversations");
  responses.configure({ builder: "plain", fixes: "change", reopen: "resume" });
  const next = await responses.start({ ...launch, reopen: first.sessionId }, builder);
  try {
    expect(next.reopened).toBe("resume"); expect(next.sessionId).toBe(first.sessionId);
    await next.prompt("You are fixing the review findings");
    const before = readFileSync(join(launch.cwd, "welcome.txt"), "utf8");
    await next.prompt("You are fixing the review findings");
    expect(readFileSync(join(launch.cwd, "welcome.txt"), "utf8")).not.toBe(before);
    expect(responses.openings(builder.id)).toHaveLength(1);
    expect(responses.prompts(builder.id)).toHaveLength(3);
  } finally { await next.stop(); }
});

it("preserves scripted check order through engine-style session replacement and retains the last run", async () => {
  const responses = acceptanceAgents(), tester = role("checks");
  const fail = { text: "A greeting", result: "fail" as const, evidence: "No greeting", productIds: ["a"] };
  const pass = { ...fail, result: "pass" as const, evidence: "Greeting found" };
  responses.configure({ builder: "plain", testerRuns: [[fail], [pass]] });
  const outcomes: string[] = [];
  for (let index = 0; index < 3; index++) {
    const session = await responses.start(options(), tester);
    try {
      const parsed = parseResult((await session.prompt("Check the greeting")).text, TestResult);
      expect(parsed.ok).toBe(true);
      if (parsed.ok !== true) throw new Error("The scripted acceptance result is invalid");
      outcomes.push(parsed.value.checks[0]!.result);
      expect(parsed.value.checks[0]!.productIds).toEqual(["a"]);
    } finally { await session.stop(); }
  }
  expect(outcomes).toEqual(["fail", "pass", "pass"]);
  expect(responses.openings(tester.id)).toHaveLength(3);
});

it("assigns Important and nit reports to the same configured owner on independent tools", async () => {
  const responses = acceptanceAgents(), reviewer = BUILT_IN_ROLES.find(role => role.id === "code-reviewer")!;
  responses.configure({ builder: "plain", reviewer: "important", affectedProducts: ["a"] });
  for (const profileId of ["opus-high", "sol-high"]) {
    const session = await responses.start(options(profileId), reviewer);
    try {
      const parsed = parseResult((await session.prompt("Inspect the first review round")).text, ReviewResult);
      expect(parsed.ok).toBe(true);
      if (parsed.ok !== true) throw new Error("The scripted review result is invalid");
      expect(parsed.value.findings[0]!.productIds).toEqual(["a"]);
      expect(parsed.value.findings[0]!.text).toBe(profileId === "opus-high" ? "The greeting is missing on the welcome page." : "Consider a friendlier greeting.");
    } finally { await session.stop(); }
  }
});

it("refuses unsupported script options and unexpected roles instead of manufacturing a successful answer", async () => {
  const responses = acceptanceAgents(), script: AcceptanceScript = { builder: "plain" };
  Reflect.set(script, "unconfiguredBehavior", true);
  expect(() => responses.configure(script)).toThrow("Unsupported acceptance fixture option: unconfiguredBehavior");
  const session = await responses.start(options(), role("plan"));
  try { await expectRejection(session.prompt("Plan this task"), "Unexpected participant in the acceptance fixture: plan"); }
  finally { await session.stop(); }
});
