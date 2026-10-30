import { readFileSync } from "node:fs";
import { join } from "node:path";
import { UsageLimited } from "@petrina/agent-runtime/failures";
import { ReopenFailed, type StartAgentSession } from "@petrina/orchestrator";
import type { Fakes } from "../fixtures.js";
import type { Scenario } from "../fake-agent.js";
import { ScriptedAgents, scriptedResult } from "../scripted-agents.js";
import { acceptanceAgents } from "./acceptance-agents.js";

/** The one recorded handback is the subject; later workflow replies wait for the fixture's stop. */
export function usageCreditAgents(roleId: "planner" | "researcher" | "check-finder") {
  return (fakes: Fakes): StartAgentSession => {
    let handedBack = false;
    const builder = acceptanceAgents();
    builder.configure({ builder: "plain" });
    const agents = new ScriptedAgents(async (prompt, signal) => {
      if (handedBack) return new Promise<never>((_resolve, reject) => {
        const stopped = () => reject(new Error("The attribution fixture stopped after its requested handback"));
        if (signal.aborted) stopped(); else signal.addEventListener("abort", stopped, { once: true });
      });
      const script = JSON.parse(readFileSync(join(fakes.dir, "scenario.json"), "utf8")) as Scenario;
      if (Object.keys(script).some(key => !["planner", "builder", "limited"].includes(key))
        || script.planner !== "research-first" || script.builder !== "plain") throw new Error("The credit fixture requires its declared Research-first recipe");
      const limit = script.limited?.find(entry => entry.model === prompt.model && entry.role?.replaceAll(" ", "-") === prompt.roleId);
      if (limit) {
        if (Object.keys(limit).some(key => !["model", "role"].includes(key))) throw new Error("The credit fixture requires its explicit tool limit");
        throw new UsageLimited(prompt.toolId, Date.now() + 3_600_000, prompt.toolId === "codex" ? "Codex's usage limit" : "Claude Code's usage limit");
      }
      let result: object;
      switch (prompt.result) {
        case "build":
          if (roleId !== "check-finder") throw new Error("Only Check finder attribution requires the actual preceding Builder");
          return builder.respond(prompt, signal);
        case "plan": result = { rationale: "Research it, build it, then review it.", stages: [
          { kind: "do", title: "Research", roleId: "researcher", profileIds: ["opus-high"] },
          { kind: "do", title: "Build", roleId: "builder", profileIds: ["sol-high"] },
          { kind: "review-chain", title: "Review", roleId: "code-reviewer", profileIds: ["sol-high"], maxRounds: 1 },
        ] }; break;
        case "notes": result = { summary: "Notes from the researcher.", notes: ["A note from the researcher"] }; break;
        case "check-discovery": result = { summary: "Checked with git, which every test machine has.",
          checks: [{ name: "Version", argv: ["git", "--version"], why: "A check that passes, for tests" }] }; break;
        default: throw new Error(`Unexpected participant before the requested credit: ${prompt.result}`);
      }
      if (prompt.roleId === roleId) handedBack = true;
      return scriptedResult(result);
    });
    return (options, role) => options.reopen
      ? Promise.reject(new ReopenFailed("The credit recipe starts fresh conversations"))
      : agents.start(options, role);
  };
}
