import { ReopenFailed, type StartAgentSession } from "@petrina/orchestrator";
import type { Scenario } from "../fake-agent.js";
import { ScriptedAgents, scriptedResult } from "../scripted-agents.js";
import { scriptedToolProbe } from "../scripted-probes.js";
import { acceptanceAgents } from "./acceptance-agents.js";

/** Provider replies for acceptance/repair composition; no native transport or account claims. */
export function testerAgents() {
  let script: Scenario = {}, tested = 0, omitted = false;
  const replies = acceptanceAgents();
  const agents = new ScriptedAgents((prompt, signal) => {
    if (["build", "findings", "votes"].includes(prompt.result)) return replies.respond(prompt, signal);
    switch (prompt.result) {
      case "plan": {
        const first = script.planner === "tester-first";
        return scriptedResult({ rationale: "Build, try acceptance, review and deliver the greeting.",
          ...(script.risk ? { risk: { level: script.risk, why: "Only a greeting file changes." } } : {}), stages: [
          ...(!first ? [{ kind: "converge", title: "Design", roleId: "architect", profileIds: ["opus-xhigh"], reviewerRoleId: "design-reviewer", reviewerProfileIds: ["sol-xhigh"], maxRounds: 2 }] : []),
          { kind: "do", title: "Build", roleId: "builder", profileIds: [first ? "opus-xhigh" : "sol-xhigh"] },
          { kind: "do", title: "Try acceptance", roleId: "tester", profileIds: ["opus-high"] },
          { kind: "review-chain", title: "Review", roleId: "code-reviewer", profileIds: first ? ["opus-xhigh", "sol-xhigh"] : ["opus-high", "sol-high"], maxRounds: 2 },
        ] });
      }
      case "brief": return scriptedResult({ summary: "A greeting file.", forUsers: ["People see a greeting"], areas: ["Greeting"], acceptance: ["A greeting file exists"], risks: [], answers: [] });
      case "objections": return scriptedResult({ objections: [] });
      case "check-discovery": return scriptedResult({ summary: "Check the private product with Git.", checks: [{ name: "Version", argv: ["git", "--version"], why: "Verify the private repository" }] });
      case "checks": {
        if (script.tester === "omit-once" && !omitted) { omitted = true; return scriptedResult({ summary: "It looks fine.", checks: [] }); }
        if (script.tester === "blocked") return scriptedResult({ summary: "The live account is unavailable.", checks: [{ text: "A greeting file exists", result: "blocked", reason: "The Claude Code weekly limit prevents opening a live session." }] });
        if (script.tester === "no-evidence") return scriptedResult({ summary: "It looks fine.", checks: [{ text: "A greeting file exists", result: "pass" }] });
        const failed = script.tester === "always-fail" || script.tester === "fail-once" && tested === 1;
        tested++;
        return scriptedResult({ summary: failed ? "The greeting still does not appear." : "Tried it: it works.", checks: [{ text: "A greeting file exists", pass: !failed,
          evidence: failed ? "The scripted guest welcome page has no greeting; expected the greeting to be visible." : "The scripted greeting check returned the expected result." }] });
      }
      case "guide": return scriptedResult({ missed: true, line: "Every greeting also shows on the welcome page.", why: "The review checked only the greeting file." });
      default: throw new Error(`Unexpected acceptance participant: ${prompt.result}`);
    }
  });
  const start: StartAgentSession = (options, role) => options.reopen
    ? Promise.reject(new ReopenFailed("This acceptance recipe starts fresh conversations")) : agents.start(options, role);
  return {
    start,
    toolProbe: scriptedToolProbe({ "claude-code": { status: "ready" }, codex: { status: "ready" }, grok: { status: "ready" }, antigravity: { status: "not-installed" }, gh: { status: "not-installed" }, git: { status: "ready" }, node: { status: "ready" } }),
    scenario(next: Scenario) {
      for (const key of Object.keys(next)) if (!["planner", "builder", "tester", "risk", "fixes", "reviewer"].includes(key)) throw new Error(`Unsupported acceptance reply recipe: ${key}`);
      script = structuredClone(next);
      replies.configure({ builder: "plain", fixes: next.fixes, reviewer: next.reviewer === "important" ? "important" : undefined });
    },
    prompts(role: string) { return agents.received().filter(prompt => prompt.roleId.replaceAll("-", " ") === role).map(prompt => prompt.text); },
    openings(role: string) { return agents.received().filter(prompt => prompt.roleId.replaceAll("-", " ") === role && prompt.turn === 1).map(prompt => prompt.text); },
  };
}
