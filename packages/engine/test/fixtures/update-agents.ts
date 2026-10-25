import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { ReopenFailed, type StartAgentSession } from "@petrina/orchestrator";
import { git } from "../fixtures.js";
import type { Scenario } from "../fake-agent.js";
import { ScriptedAgents, scriptedResult } from "../scripted-agents.js";
import { scriptedToolProbe } from "../scripted-probes.js";
import { sharedAgents } from "./shared-agents.js";
import { acceptanceAgents } from "./acceptance-agents.js";

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
  const agents = new ScriptedAgents(async (prompt, signal, callbacks) => {
    if (prompt.result === "build") {
      if (await callbacks.onPermission({ title: "Installing packages", kind: "execute", command: "npm install left-pad", paths: [] }) !== "allow")
        throw new Error("The update recipe requires the coordinator's explicit permission before writing");
      const reply = await base.respond(prompt, signal, callbacks);
      writeFileSync(join(prompt.cwd, "greeting.txt"), script.leak && !prompt.text.includes("You are fixing the review findings") ? "Hello from internal-db-07\n" : "Hello (with left-pad)\n");
      if (script.mergesMain && !prompt.text.includes("You are fixing the review findings")) {
        await git(prompt.cwd, "add", "-A");
        await git(prompt.cwd, "commit", "-q", "-m", "Builder's own commit");
        await git(prompt.cwd, "merge", "-q", "--no-edit", "main");
      }
      const report = JSON.parse((typeof reply === "string" ? reply : reply.text).slice("```petrina\n".length, -"\n```".length)) as object;
      return scriptedResult({ ...report, ...(script.title ? { title: script.title } : {}) });
    }
    if (prompt.result === "findings" || prompt.result === "votes") return reviews.respond(prompt, signal);
    if (prompt.result === "check-discovery") return scriptedResult({ summary: "Inspect the private repository.", checks: script.checks === "writes"
      ? [{ name: "Format", argv: ["git", "mv", "README.md", "README.txt"], why: "A real tracked-file mutation" }]
      : script.checks === "commits" ? [{ name: "Sneaky", argv: ["git", "commit", "-q", "--allow-empty", "-m", "Not reviewed"], why: "A real unreviewed commit" }]
      : [{ name: "Version", argv: ["git", "--version"], why: "A real passing product check" }] });
    const reply = await base.respond(prompt, signal, callbacks);
    if (prompt.result !== "plan" || !prompt.text.includes("[no-check]")) return reply;
    const plan = JSON.parse((typeof reply === "string" ? reply : reply.text).slice("```petrina\n".length, -"\n```".length)) as { stages: { kind: string }[] };
    return scriptedResult({ ...plan, stages: plan.stages.filter(stage => stage.kind !== "gate") });
  });
  const startAgentSession: StartAgentSession = (options, role) => {
    names.set(role.id, role.name.toLowerCase());
    if (options.reopen && script.reopen !== "resume") return Promise.reject(new ReopenFailed("The update recipe starts fresh conversations"));
    return agents.start(options, role);
  };
  const received = (role: string) => agents.received().filter(prompt => names.get(prompt.roleId) === role)
    .map(prompt => ({ role, text: prompt.text, session: prompt.sessionId, turn: prompt.turn }));
  return { startAgentSession,
    toolProbe: scriptedToolProbe({ "claude-code": { status: "ready" }, codex: { status: "ready" }, grok: { status: "ready" }, antigravity: { status: "not-installed" }, gh: { status: "ready" }, git: { status: "ready" }, node: { status: "ready" } }),
    received, prompts: (role: string) => received(role).map(prompt => prompt.text),
    openings: (role: string) => received(role).filter(prompt => prompt.turn === 1).map(prompt => prompt.text),
  };
}
