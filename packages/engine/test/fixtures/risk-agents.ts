import { ScriptedAgents, scriptedResult } from "../scripted-agents.js";
import { acceptanceAgents } from "./acceptance-agents.js";
import { scriptedToolProbe } from "../scripted-probes.js";

export function riskAgents(risk: "high" | "low" | undefined) {
  const replies = acceptanceAgents();
  const agents = new ScriptedAgents((prompt, signal) => {
    if (["build", "findings", "votes"].includes(prompt.result)) return replies.respond(prompt, signal);
    if (prompt.result === "plan") return scriptedResult({ rationale: "Build and review the risk-labelled change.",
      ...(risk ? { risk: { level: risk, why: risk === "high" ? "It changes how people sign in." : "It is a small copy change." } } : {}),
      stages: [
        { kind: "do", title: "Build", roleId: "builder", profileIds: ["sol-xhigh"] },
        { kind: "review-chain", title: "Review", roleId: "code-reviewer", profileIds: ["opus-high"], maxRounds: 1 },
      ],
    });
    if (prompt.result === "check-discovery") return scriptedResult({ summary: "The product has a version command.", checks: [{ name: "Version", argv: [process.execPath, "--version"], why: "Checks the installed runtime without changing product files" }] });
    throw new Error(`Unexpected risk participant: ${prompt.result}`);
  });
  const openings = (role: string) => agents.received().filter(prompt => prompt.roleId.replaceAll("-", " ") === role && prompt.turn === 1).map(prompt => prompt.text);
  return { start: agents.start, openings,
    toolProbe: scriptedToolProbe({ "claude-code": { status: "ready" }, codex: { status: "ready" }, grok: { status: "ready" }, antigravity: { status: "not-installed" }, gh: { status: "not-installed" }, git: { status: "ready" } }),
  };
}
