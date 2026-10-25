import { ReopenFailed, type StartAgentSession } from "@petrina/orchestrator";
import { acceptanceAgents } from "./acceptance-agents.js";
import { ReleaseEvents } from "../release-events.js";
import { ScriptedAgents, scriptedResult, type ScriptedPrompt } from "../scripted-agents.js";

/** Only the provider responses used by the real check/restart journeys, not a miniature workflow engine. */
export interface CheckScript {
  planner?: "short" | "tester-first";
  builder?: "plain";
  reviewer?: "important";
  fixes?: "change";
  controlled?: boolean;
  title?: string;
  answer?: { fixed: boolean; text: string };
}

const label = (prompt: ScriptedPrompt) => prompt.roleId.replaceAll("-", " ");

export function checkAgents() {
  let script: CheckScript = {};
  const releases = new ReleaseEvents();
  const beforeReply = (prompt: ScriptedPrompt, signal: AbortSignal) =>
    script.controlled && prompt.turn === 1 ? releases.wait(prompt.sessionId, signal) : undefined;
  const replies = acceptanceAgents({ beforeReply });
  const agents = new ScriptedAgents(async (prompt, signal) => {
    const configured = script;
    if (["build", "checks", "findings", "votes"].includes(prompt.result)) return replies.respond(prompt, signal);
    await beforeReply(prompt, signal);
    switch (prompt.result) {
      case "plan": {
        const build = { kind: "do", title: "Build", roleId: "builder", profileIds: [configured.planner === "tester-first" ? "opus-xhigh" : "sol-xhigh"] };
        const review = { kind: "review-chain", title: "Review", roleId: "code-reviewer", profileIds: configured.planner === "short" ? ["opus-high"] : configured.planner === "tester-first" ? ["opus-xhigh", "sol-xhigh"] : ["opus-high", "sol-high"], maxRounds: configured.planner === "short" ? 1 : 2 };
        return scriptedResult({ rationale: "Only the declared check workflow is under test.", stages: [
          ...(configured.planner ? [] : [{ kind: "converge", title: "Design", roleId: "architect", profileIds: ["opus-xhigh"], reviewerRoleId: "design-reviewer", reviewerProfileIds: ["sol-xhigh"], maxRounds: 2 }]),
          build,
          ...(configured.planner === "tester-first" ? [{ kind: "do", title: "Try it like a user", roleId: "tester", profileIds: ["opus-high"] }] : []),
          review,
        ] });
      }
      case "brief": return scriptedResult({ summary: "A greeting file.", forUsers: ["People see a greeting"], areas: ["Greeting"], acceptance: ["A greeting file exists"], risks: [], answers: [] });
      case "objections": return scriptedResult({ objections: [] });
      case "guide": return scriptedResult({ missed: true, line: "Every greeting also shows on the welcome page.", why: "The reviewers checked the greeting only where it was added." });
      default: throw new Error(`Unexpected participant in the check fixture: ${prompt.result}`);
    }
  });
  const start: StartAgentSession = (options, role) => {
    if (options.reopen) return Promise.reject(new ReopenFailed("This check scenario starts fresh conversations"));
    return agents.start(options, role);
  };
  const received = (role?: string) => agents.received().filter(prompt => role === undefined || label(prompt) === role)
    .map(prompt => ({ ...prompt, role: label(prompt), session: prompt.sessionId }));
  return {
    start,
    release: (sessionId: string) => releases.release(sessionId),
    received,
    prompts: (role: string) => received(role).map(prompt => prompt.text),
    openings: (role: string) => received(role).filter(prompt => prompt.turn === 1).map(prompt => prompt.text),
    scenario(next: CheckScript) {
      const supported = new Set(["planner", "builder", "reviewer", "fixes", "controlled", "title", "answer"]);
      for (const key of Object.keys(next)) if (!supported.has(key)) throw new Error(`Unsupported check fixture option: ${key}`);
      script = structuredClone(next);
      replies.configure({ builder: "plain", fixes: script.fixes, reviewer: script.reviewer,
        buildReport: { summary: "Added a greeting.", title: script.title, answer: script.answer },
        testerChecks: [{ text: "A greeting file exists", result: "pass", evidence: "The scripted greeting check returned the expected result." }],
      });
    },
  };
}
