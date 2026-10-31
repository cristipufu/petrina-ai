import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { ReopenFailed, type StartAgentSession } from "@petrina/orchestrator";
import { git } from "../fixtures.js";
import type { Scenario } from "../fake-agent.js";
import { ScriptedAgents, scriptedResult } from "../scripted-agents.js";
import { scriptedToolProbe } from "../scripted-probes.js";
import { sharedAgents, sharedPlan } from "./shared-agents.js";
import { acceptanceAgents } from "./acceptance-agents.js";

/** The update provider uses this same plan, including its explicit no-design-check variant. */
export function updatePlan(script: Scenario, text: string) {
  const plan = sharedPlan({ ...(script.planner === "tester-first" ? { planner: "tester-first" as const } : {}),
    ...(script.fixes === "change" ? { fixes: "change" as const } : {}) });
  return text.includes("[no-check]") ? { ...plan, stages: plan.stages.filter(stage => stage.kind !== "gate") } : plan;
}

/** The same declared command inputs serve discovery and source-update boundary fixtures. */
export function updateChecks(script: Scenario) {
  if (script.checks && !["writes", "commits"].includes(script.checks)) throw new Error("The update recipe needs its explicit tracked-file or commit check");
  return { summary: "Inspect the private repository.", checks: script.checks === "writes"
    ? [{ name: "Format", argv: ["git", "mv", "README.md", "README.txt"], why: "A real tracked-file mutation" }]
    : script.checks === "commits" ? [{ name: "Sneaky", argv: ["git", "commit", "-q", "--allow-empty", "-m", "Not reviewed"], why: "A real unreviewed commit" }]
    : [{ name: "Version", argv: ["git", "--version"], why: "A real passing product check" }] };
}

/** Porting/check journeys own real Git and inbox effects; provider transport has separate native controls. */
export function updateAgents(dir: string, script: Scenario) {
  const supported = new Set(["planner", "reviewer", "fixes", "checks", "title", "leak", "mergesMain", "reopen"]);
  for (const key of Object.keys(script)) if (!supported.has(key)) throw new Error(`Unsupported update reply option: ${key}`);
  if (script.planner && script.planner !== "tester-first") throw new Error("The update recipe needs its explicit default/tester-first plan");
  if (script.reviewer && script.reviewer !== "important") throw new Error("The update recipe needs its explicit Important finding");
  if (script.checks && !["writes", "commits"].includes(script.checks)) throw new Error("The update recipe needs its explicit tracked-file or commit check");
  const base = sharedAgents(dir);
  base.scenario({ ...(script.planner === "tester-first" ? { planner: "tester-first" } : {}),
    ...(script.fixes === "change" ? { fixes: "change" } : {}) });
  const reviews = acceptanceAgents();
  reviews.configure({ builder: "plain", ...(script.reviewer === "important" ? { reviewer: "important" } : {}),
    ...(script.fixes === "change" ? { fixes: "change" } : {}) });
  const names = new Map<string, string>();
  const finishBuild = async (cwd: string, fixing: boolean, report: object, signal: AbortSignal) => {
    signal.throwIfAborted();
    writeFileSync(join(cwd, "greeting.txt"), script.leak && !fixing ? "Hello from internal-db-07\n" : "Hello (with left-pad)\n");
    if (script.mergesMain && !fixing) {
      await git(cwd, "add", "-A"); signal.throwIfAborted();
      await git(cwd, "commit", "-q", "-m", "Builder's own commit"); signal.throwIfAborted();
      await git(cwd, "merge", "-q", "--no-edit", "main"); signal.throwIfAborted();
    }
    return { ...report, ...(script.title ? { title: script.title } : {}) };
  };
  const agents = new ScriptedAgents(async (prompt, signal, callbacks) => {
    if (prompt.result === "build") {
      if (await callbacks.onPermission({ title: "Installing packages", kind: "execute", command: "npm install left-pad", paths: [] }) !== "allow")
        throw new Error("The update recipe requires the coordinator's explicit permission before writing");
      const reply = await base.respond(prompt, signal, callbacks);
      const report = JSON.parse((typeof reply === "string" ? reply : reply.text).slice("```petrina\n".length, -"\n```".length)) as object;
      return scriptedResult(await finishBuild(prompt.cwd, prompt.text.includes("You are fixing the review findings"), report, signal));
    }
    if (prompt.result === "findings" || prompt.result === "votes") return reviews.respond(prompt, signal);
    if (prompt.result === "check-discovery") return scriptedResult(updateChecks(script));
    if (prompt.result === "plan") return scriptedResult(updatePlan(script, prompt.text));
    return base.respond(prompt, signal, callbacks);
  });
  const startAgentSession: StartAgentSession = (options, role) => {
    names.set(role.id, role.name.toLowerCase());
    if (options.reopen && script.reopen !== "resume") return Promise.reject(new ReopenFailed("The update recipe starts fresh conversations"));
    return agents.start(options, role);
  };
  const received = (role: string) => agents.received().filter(prompt => names.get(prompt.roleId) === role)
    .map(prompt => ({ role, text: prompt.text, session: prompt.sessionId, turn: prompt.turn }));
  return { startAgentSession,
    acceptedInitialBuild(cwd: string, signal: AbortSignal) {
      signal.throwIfAborted();
      return finishBuild(cwd, false, base.acceptedInitialBuild(cwd), signal);
    },
    toolProbe: scriptedToolProbe({ "claude-code": { status: "ready" }, codex: { status: "ready" }, grok: { status: "ready" }, antigravity: { status: "not-installed" }, gh: { status: "ready" }, git: { status: "ready" } }),
    received, prompts: (role: string) => received(role).map(prompt => prompt.text),
    openings: (role: string) => received(role).filter(prompt => prompt.turn === 1).map(prompt => prompt.text),
  };
}
