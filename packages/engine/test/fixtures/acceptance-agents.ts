import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { JourneyStep } from "@petrina/core";
import { ReopenFailed, type StartAgentSession } from "@petrina/orchestrator";
import { answersTo, findingIds } from "../scripted-findings.js";
import { ScriptedAgents, scriptedResult, type ScriptedPrompt } from "../scripted-agents.js";

interface Check {
  text: string;
  result: "pass" | "fail" | "blocked";
  evidence?: string;
  reason?: string;
  productIds?: string[];
}

/** Only the responses this acceptance journey needs. Unexpected participants fail immediately. */
export interface AcceptanceScript {
  builder: "plain";
  fixes?: "change";
  testerChecks?: Check[];
  testerChecksFixed?: Check[];
  testerRuns?: Check[][];
  testerProofAnswers?: JourneyStep["proofChecks"];
  reviewer?: "confirm" | "important";
  affectedProducts?: string[];
  reopen?: "resume";
  buildReport?: { summary?: string; title?: string; answer?: { fixed: boolean; text: string } };
}

/** Caller-owned work finishes before the report. A turn keeps its starting recipe while that work runs. */
export function acceptanceAgents(effects: {
  beforeChecks?(prompt: ScriptedPrompt, signal: AbortSignal): void | Promise<void>;
  beforeReply?(prompt: ScriptedPrompt, signal: AbortSignal): void | Promise<void>;
} = {}) {
  let configured: AcceptanceScript = { builder: "plain" }, repairs = 0, testerRun = 0;
  const build = (cwd: string, answers: ReturnType<typeof answersTo>, fixing: boolean, script: AcceptanceScript) => {
    const greetingPath = join(cwd, "greeting.txt");
    if (!existsSync(greetingPath) || readFileSync(greetingPath, "utf8") !== "Hello\n") writeFileSync(greetingPath, "Hello\n");
    if (script.fixes === "change" && fixing) writeFileSync(join(cwd, "welcome.txt"), `Hello repair ${++repairs}\n`);
    return { summary: script.buildReport?.summary ?? "Added the greeting.", ...(script.buildReport?.title ? { title: script.buildReport.title } : {}),
      changes: ["People see a greeting"], tests: "Petrina runs the product checks.", answers };
  };
  const respond = async (prompt: ScriptedPrompt, signal: AbortSignal): Promise<string> => {
    const script = configured;
    const { result, text, cwd } = prompt;
    await effects.beforeReply?.(prompt, signal);
    switch (result) {
      case "build":
        return scriptedResult(build(cwd, answersTo(text, script.buildReport?.answer), text.includes("You are fixing the review findings"), script));
      case "checks": {
        const runs = script.testerRuns;
        const run = runs?.length ? Math.min(testerRun++, runs.length - 1) : undefined;
        await effects.beforeChecks?.(prompt, signal);
        const checks = run !== undefined ? runs![run]
          : script.testerChecksFixed && existsSync(join(cwd, "welcome.txt")) ? script.testerChecksFixed : script.testerChecks;
        if (!checks) throw new Error("The acceptance fixture needs explicit check results");
        return scriptedResult({ summary: "Tried every acceptance item.", checks: structuredClone(checks),
          ...(script.testerProofAnswers ? { proofAnswers: structuredClone(script.testerProofAnswers) } : {}) });
      }
      case "findings": {
        if (prompt.roleId === "security-reviewer") return scriptedResult({ verdict: "pass", findings: [], confirms: [], disputes: [] });
        if (prompt.roleId !== "code-reviewer") throw new Error(`Unexpected findings role in the acceptance fixture: ${prompt.roleId}`);
        if (script.reviewer === "confirm") {
          const ids = text.includes("This is review round") ? [] : findingIds(text, "Findings so far (confirm or dispute by id)");
          return scriptedResult({ verdict: ids.length ? "fail" : "pass", findings: [], confirms: ids, disputes: [] });
        }
        if (script.reviewer === "important" && prompt.model === "opus" && !text.includes("This is review round") && !(script.fixes === "change" && existsSync(join(cwd, "welcome.txt")))) {
          return scriptedResult({ verdict: "fail", findings: [{ text: "The greeting is missing on the welcome page.", where: "greeting.txt", severity: "important", evidence: "Opened the welcome page", productIds: script.affectedProducts }], confirms: [], disputes: [] });
        }
        return scriptedResult({ verdict: "pass", findings: [{ text: "Consider a friendlier greeting.", severity: "nit", productIds: script.affectedProducts }], confirms: [], disputes: [] });
      }
      case "votes": return scriptedResult({ verdicts: findingIds(text, "Important findings to check (a verdict on every one, by id)").map(id => ({ id, verdict: "real", reason: "The scripted welcome page has no greeting." })) });
      default: throw new Error(`Unexpected participant in the acceptance fixture: ${result}`);
    }
  };
  const agents = new ScriptedAgents(respond);
  const start: StartAgentSession = (options, role) => {
    // Match the native stand-in's declared capability; default scenarios deliberately start fresh.
    if (options.reopen && configured.reopen !== "resume") return Promise.reject(new ReopenFailed("This acceptance scenario does not reopen conversations"));
    return agents.start(options, role);
  };
  return {
    start,
    // Other workflow fixtures compose these same replies with their own explicit prerequisite participants.
    respond,
    /** Same accepted reply recipe for fixtures whose subject starts after provider execution. */
    acceptedBuild(cwd: string, findingIds: readonly string[], fixing: boolean) {
      const script = configured;
      return build(cwd, findingIds.map(id => ({ id, ...(script.buildReport?.answer ?? { fixed: true, text: "Fixed it." }) })), fixing, script);
    },
    configure(next: AcceptanceScript) {
      const supported = new Set(["builder", "fixes", "testerChecks", "testerChecksFixed", "testerRuns", "testerProofAnswers", "reviewer", "affectedProducts", "reopen", "buildReport"]);
      for (const key of Object.keys(next)) if (!supported.has(key)) throw new Error(`Unsupported acceptance fixture option: ${key}`);
      configured = structuredClone(next);
    },
    prompts: (roleId: string) => agents.received().filter(prompt => prompt.roleId === roleId).map(prompt => prompt.text),
    openings: (roleId: string) => agents.received().filter(prompt => prompt.roleId === roleId && prompt.turn === 1).map(prompt => prompt.text),
  };
}
