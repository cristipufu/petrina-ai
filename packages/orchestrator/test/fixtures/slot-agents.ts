import { ScriptedAgents, scriptedResult } from "./scripted-agents.js";
import { findingIds } from "./scripted-findings.js";
import { ReleaseEvents } from "./release-events.js";

/** Provider responses for the real cross-stage slot journey; no ACP or process-cleanup claims. */
export function slotAgents(writeGreeting: (cwd: string) => void) {
  const releases = new ReleaseEvents();
  const agents = new ScriptedAgents(async (prompt, signal) => {
    if (prompt.turn === 1) await releases.wait(prompt.sessionId, signal);
    switch (prompt.result) {
      case "plan": return scriptedResult({
        rationale: "Exercise same-tool handoffs, design rounds and a mixed-tool review chain.",
        stages: [
          { kind: "do", title: "Research", roleId: "researcher", profileIds: ["opus-high"] },
          { kind: "converge", title: "Design", roleId: "architect", profileIds: ["opus-xhigh"], reviewerRoleId: "design-reviewer", reviewerProfileIds: ["sol-xhigh"], maxRounds: 2 },
          { kind: "do", title: "Build", roleId: "builder", profileIds: ["sol-xhigh"] },
          { kind: "review-chain", title: "Review", roleId: "code-reviewer", profileIds: ["opus-high", "opus-xhigh", "sol-high"], maxRounds: 2 },
        ],
      });
      case "notes": return scriptedResult({ summary: "Checked the greeting's audience.", notes: ["People see a greeting."] });
      case "brief": {
        if (prompt.turn === 1) return scriptedResult({ needsInput: { question: "Should the greeting be formal?", options: ["Formal", "Casual"] } });
        return scriptedResult({ summary: "A greeting file.", forUsers: ["People see a greeting"], areas: ["Greeting"], acceptance: ["A greeting file exists"], risks: [],
          answers: findingIds(prompt.text, "Objections so far").map(id => ({ id, status: "accepted", byCall: false, answer: "The greeting is visible to everyone." })) });
      }
      case "objections": return scriptedResult({ objections: prompt.text.includes("Objections so far") ? [] : [{ text: "Explain who sees the greeting.", blocking: true }] });
      case "build":
        writeGreeting(prompt.cwd);
        return scriptedResult({ summary: "Added a greeting.", description: "People see a greeting.", changes: ["People see a greeting"], tests: "Petrina runs the product checks." });
      case "check-discovery": return scriptedResult({ summary: "Git is the fixture's check.", checks: [{ name: "Version", argv: ["git", "--version"], why: "A real passing check" }] });
      case "findings": return scriptedResult({ verdict: "pass", findings: [], confirms: [], disputes: [] });
      default: throw new Error(`Unexpected participant in the slot fixture: ${prompt.result}`);
    }
  });
  return { agents, release: (sessionId: string) => releases.release(sessionId) };
}
