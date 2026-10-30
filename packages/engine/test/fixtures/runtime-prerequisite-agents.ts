import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { PlanDraft } from "@petrina/core";
import type { StartAgentSession } from "@petrina/orchestrator";
import type { Fakes } from "../fixtures.js";
import type { Scenario } from "../fake-agent.js";
import { recordPrompt } from "../prompt-records.js";
import { ScriptedAgents, scriptedResult } from "../scripted-agents.js";
import { answersTo, findingIds } from "../scripted-findings.js";
import { acceptanceAgents } from "./acceptance-agents.js";

/** The same short/parallel plan supplied by the native stand-in, without a Planner prerequisite. */
export function runtimePrerequisitePlan(parallel: boolean): PlanDraft {
  return { rationale: "A small change: build it, one reviewer.", stages: [
    { kind: "do", title: "Build", roleId: "builder", profileIds: ["sol-xhigh"] },
    { kind: "review-chain", title: "Review", roleId: "code-reviewer", profileIds: parallel ? ["opus-high", "sol-high"] : ["opus-high"], maxRounds: 1 },
  ] };
}

/** Controlled participant replies for real runtime admission, source refresh and persisted partial groups. */
export function runtimePrerequisiteAgents(fakes: Fakes) {
  const released = new Set<string>(), waiting = new Map<string, () => void>();
  const review = acceptanceAgents();
  const names = new Map<string, string>();
  const recipe = () => {
    const script = JSON.parse(readFileSync(join(fakes.dir, "scenario.json"), "utf8")) as Scenario;
    if (Object.keys(script).some(key => !["controlled", "planner", "builder", "reopen", "reviewer", "verifier"].includes(key))
      || !script.controlled || script.builder !== "plain" || script.reopen !== "resume"
      || !["short", "parallel"].includes(script.planner ?? "")
      || script.reviewer !== undefined && script.reviewer !== "important"
      || script.verifier !== undefined && script.verifier !== "not-a-bug")
      throw new Error("Runtime prerequisite replies require their explicit controlled recipe");
    return script;
  };
  const agents = new ScriptedAgents(async (prompt, signal, callbacks) => {
    const name = names.get(prompt.roleId);
    if (!name) throw new Error("The runtime prerequisite participant was not opened");
    await recordPrompt(fakes.dir, { role: name, session: prompt.sessionId, text: prompt.text });
    signal.throwIfAborted();
    if (prompt.turn === 1 && !released.has(prompt.sessionId)) {
      callbacks.onActivity(`${name} is working`);
      await new Promise<void>((resolve, reject) => {
        const stop = () => { waiting.delete(prompt.sessionId); reject(new Error("The controlled prerequisite participant stopped")); };
        const release = () => { signal.removeEventListener("abort", stop); waiting.delete(prompt.sessionId); resolve(); };
        if (signal.aborted) stop();
        else { waiting.set(prompt.sessionId, release); signal.addEventListener("abort", stop, { once: true }); }
      });
    }
    signal.throwIfAborted();
    const script = recipe();
    switch (prompt.result) {
      case "plan": return scriptedResult(runtimePrerequisitePlan(script.planner === "parallel"));
      case "build":
        callbacks.onActivity("Writing the greeting");
        writeFileSync(join(prompt.cwd, "greeting.txt"), "Hello (with left-pad)\n");
        return scriptedResult({ summary: "Added a greeting.", changes: ["People see a greeting"], tests: "1 passed", answers: answersTo(prompt.text),
          ...(prompt.text.includes('"description"') ? { description: "Adds a greeting file.\n\nTested with the greeting test." } : {}) });
      case "findings":
        review.configure({ builder: "plain", ...(script.reviewer === "important" ? { reviewer: "important" as const } : {}) });
        return review.respond(prompt, signal);
      case "votes":
        if (script.verifier !== "not-a-bug") throw new Error("The prerequisite vote requires its explicit not-a-bug response");
        return scriptedResult({ verdicts: findingIds(prompt.text, "Important findings to check (a verdict on every one, by id)")
          .map(id => ({ id, verdict: "not-a-bug", reason: "The welcome page shows the greeting already." })) });
      default: throw new Error(`Unexpected runtime prerequisite participant: ${prompt.result}`);
    }
  });
  const startAgentSession: StartAgentSession = (options, role) => {
    recipe(); names.set(role.id, role.name.toLowerCase());
    return agents.start(options, role);
  };
  return { startAgentSession, release(session: string) { released.add(session); waiting.get(session)?.(); } };
}
