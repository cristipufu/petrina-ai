import { readFileSync } from "node:fs";
import { join } from "node:path";
import { UsageLimited } from "@petrina/agent-runtime/failures";
import { ReopenFailed, type StartAgentSession } from "@petrina/orchestrator";
import type { Fakes } from "../fixtures.js";
import type { Scenario } from "../fake-agent.js";
import { ScriptedAgents, scriptedResult } from "../scripted-agents.js";
import { acceptanceAgents } from "./acceptance-agents.js";

/** Attribution consumes explicit participant results; ACP refusal decoding has its own native controls. */
export function usageAttributionAgents(fakes: Fakes): StartAgentSession {
  const review = acceptanceAgents();
  review.configure({ builder: "plain", reviewer: "confirm" });
  const agents = new ScriptedAgents((prompt, signal) => {
    const script = JSON.parse(readFileSync(join(fakes.dir, "scenario.json"), "utf8")) as Scenario;
    const supported = new Set(["builder", "planner", "reviewer", "limited"]);
    for (const key of Object.keys(script)) if (!supported.has(key)) throw new Error(`Unsupported attribution response: ${key}`);
    if (script.builder !== undefined && script.builder !== "plain") throw new Error("Attribution requires its explicit plain Builder reply");
    if (script.planner !== undefined && script.planner !== "claude-build") throw new Error("Attribution requires its declared plan input");
    if (script.reviewer !== undefined && script.reviewer !== "confirm") throw new Error("Attribution requires its explicit confirming review");
    const limit = script.limited?.find(entry => entry.model === prompt.model && entry.role?.replaceAll(" ", "-") === prompt.roleId);
    if (limit) {
      if (Object.keys(limit).some(key => !["model", "role", "type"].includes(key))) throw new Error("Unsupported attribution limit input");
      if (limit.type !== undefined && limit.type !== "seven_day_opus") throw new Error("Attribution only supplies an Opus-model or tool usage limit");
      const opus = limit.type === "seven_day_opus";
      throw new UsageLimited(prompt.toolId, Date.now() + 3_600_000,
        opus ? "Claude Code's weekly Opus limit" : "Codex's usage limit", opus ? "opus" : undefined);
    }
    switch (prompt.result) {
      case "brief": {
        const brief = { summary: "A greeting file.", forUsers: ["People see a greeting"], areas: ["Greeting"], acceptance: ["A greeting file exists"], risks: [] };
        if (prompt.text.includes("Your result block could not be used")) return scriptedResult({ ...brief,
          answers: [...prompt.text.matchAll(/^- \[([^\]]+)\]/gm)].map(match => ({ id: match[1], status: "accepted", byCall: false, answer: "Added it to the brief." })) });
        if (!prompt.text.includes("The coordinator answered")) return scriptedResult({ needsInput: { question: "Should the greeting be formal?", options: ["Formal", "Casual"] } });
        return scriptedResult({ ...brief, answers: [] });
      }
      case "objections":
        if (!prompt.text.includes("[disagree]")) throw new Error("Attribution only supplies its explicit disputed design");
        return scriptedResult({ objections: [{ text: "The brief does not say who sees the greeting.", blocking: true }, { text: "Consider a greeting per language.", blocking: false }] });
      case "build": case "findings": case "votes":
        if (script.reviewer !== "confirm") throw new Error(`Unexpected participant after the attribution design: ${prompt.result}`);
        return review.respond(prompt, signal);
      default: throw new Error(`Unexpected attribution participant: ${prompt.result}`);
    }
  });
  // The original attribution scenarios declared no continuation capability. A return starts fresh.
  return (options, role) => options.reopen
    ? Promise.reject(new ReopenFailed("The attribution recipe starts fresh conversations"))
    : agents.start(options, role);
}
