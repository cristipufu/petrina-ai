import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ReopenFailed, type StartAgentSession } from "@petrina/orchestrator";
import { answersTo, findingIds } from "../scripted-findings.js";
import { ScriptedAgents, scriptedResult } from "../scripted-agents.js";

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
  reviewer?: "confirm" | "important";
  affectedProducts?: string[];
  reopen?: "resume";
}

export function acceptanceAgents() {
  let script: AcceptanceScript = { builder: "plain" }, repairs = 0, testerRun = 0;
  const agents = new ScriptedAgents(prompt => {
    const { result, text, cwd } = prompt;
    switch (result) {
      case "build":
        writeFileSync(join(cwd, "greeting.txt"), "Hello\n");
        if (script.fixes === "change" && text.includes("You are fixing the review findings")) writeFileSync(join(cwd, "welcome.txt"), `Hello repair ${++repairs}\n`);
        return scriptedResult({ summary: "Added the greeting.", changes: ["People see a greeting"], tests: "Petrina runs the product checks.", answers: answersTo(text) });
      case "checks": {
        const runs = script.testerRuns;
        const checks = runs?.length ? runs[Math.min(testerRun++, runs.length - 1)]
          : script.testerChecksFixed && existsSync(join(cwd, "welcome.txt")) ? script.testerChecksFixed : script.testerChecks;
        if (!checks) throw new Error("The acceptance fixture needs explicit check results");
        return scriptedResult({ summary: "Tried every acceptance item.", checks: structuredClone(checks) });
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
  });
  const start: StartAgentSession = (options, role) => {
    // Match the native stand-in's declared capability; default scenarios deliberately start fresh.
    if (options.reopen && script.reopen !== "resume") return Promise.reject(new ReopenFailed("This acceptance scenario does not reopen conversations"));
    return agents.start(options, role);
  };
  return {
    start,
    configure(next: AcceptanceScript) {
      const supported = new Set(["builder", "fixes", "testerChecks", "testerChecksFixed", "testerRuns", "reviewer", "affectedProducts", "reopen"]);
      for (const key of Object.keys(next)) if (!supported.has(key)) throw new Error(`Unsupported acceptance fixture option: ${key}`);
      script = structuredClone(next);
    },
    prompts: (roleId: string) => agents.received().filter(prompt => prompt.roleId === roleId).map(prompt => prompt.text),
    openings: (roleId: string) => agents.received().filter(prompt => prompt.roleId === roleId && prompt.turn === 1).map(prompt => prompt.text),
  };
}
