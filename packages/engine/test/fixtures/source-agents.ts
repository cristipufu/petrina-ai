import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ReopenFailed, type StartAgentSession } from "@petrina/orchestrator";
import { ScriptedAgents, scriptedResult } from "../scripted-agents.js";
import { scriptedToolProbe } from "../scripted-probes.js";
import { answersTo } from "../scripted-findings.js";
import { recordPrompt } from "../prompt-records.js";
import { git, type Fakes } from "../fixtures.js";
import type { Scenario } from "../fake-agent.js";
import type { World } from "../support.js";

/** Sources exercise real repositories, GitHub peers and persistence; ordinary provider replies do not need ACP. */
export function sourceAgents(world: World, fakes: Fakes) {
  const names = new Map<string, string>();
  const agents = new ScriptedAgents(async (prompt, _signal, callbacks) => {
    const scenario = JSON.parse(readFileSync(join(fakes.dir, "scenario.json"), "utf8")) as Scenario;
    const name = names.get(prompt.roleId);
    if (!name) throw new Error(`The source fixture did not open ${prompt.roleId}`);
    await recordPrompt(fakes.dir, { role: name, session: prompt.sessionId, text: prompt.text });
    const { text, cwd } = prompt;
    switch (prompt.result) {
      case "plan": {
        const added = (name: string) => {
          const id = new RegExp(`^- (added-[a-z0-9-]+) \\(${name}\\):`, "m").exec(text)?.[1];
          if (!id) throw new Error(`No ${name} in the source planner's actual input`);
          return id;
        };
        const build = { kind: "do", title: "Build", roleId: "builder", profileIds: ["sol-xhigh"] };
        const review = { kind: "review-chain", title: "Review", roleId: "code-reviewer", profileIds: ["opus-high"], maxRounds: text.includes("[quick]") ? 2 : scenario.reviewRounds ?? 1 };
        const common = { ...(scenario.worksOn ? { worksOn: scenario.worksOn } : {}), ...(scenario.risk ? { risk: { level: scenario.risk, why: scenario.risk === "high" ? "It changes how people sign in." : "Only the greeting's words change." } } : {}) };
        if (scenario.planner === "source-brief" || scenario.planner === "source-roles") return scriptedResult({ rationale: "Build and review the approved source.", stages: [build,
          { ...review, profileIds: ["opus-high", "sol-high"], roleIds: ["code-reviewer", added("Security specialist")] },
          ...(scenario.planner === "source-roles" ? [
            { kind: "do", title: "Copy", roleId: added("Copywriter"), profileIds: ["opus-high"] },
            { kind: "do", title: "Fact check", roleId: added("Fact checker"), profileIds: ["opus-high"] },
          ] : []),
        ] });
        if (scenario.planner === "short" || text.includes("[quick]")) return scriptedResult({ rationale: "A small change: build it, one reviewer.", ...common, stages: [build, review] });
        if (scenario.planner !== undefined) throw new Error(`Unsupported source planner: ${scenario.planner}`);
        return scriptedResult({ rationale: "A small feature: agree on a design, build it, two reviewers.", ...common, stages: [
          { kind: "converge", title: "Design", roleId: "architect", profileIds: ["opus-xhigh"], reviewerRoleId: "design-reviewer", reviewerProfileIds: ["sol-xhigh"], maxRounds: 2 },
          { kind: "gate", title: "Your design check", roleId: "architect", gate: "design" }, build,
          { ...review, profileIds: ["opus-high", "sol-high"], maxRounds: scenario.reviewRounds ?? 2 },
        ] });
      }
      case "brief": return scriptedResult({ summary: "A greeting file.", forUsers: ["People see a greeting"], areas: ["Greeting"], acceptance: ["A greeting file exists"], risks: [] });
      case "objections": return scriptedResult({ objections: [] });
      case "build": {
        if (scenario.builder !== undefined && scenario.builder !== "plain") throw new Error(`Unsupported scripted source Builder: ${scenario.builder}`);
        callbacks.onActivity("Writing the greeting");
        const allowed = scenario.builder !== undefined || await callbacks.onPermission({ title: "npm install left-pad", kind: "execute", command: "npm install left-pad", paths: [] }) === "allow";
        writeFileSync(join(cwd, "greeting.txt"), allowed ? "Hello (with left-pad)\n" : "Hello\n");
        return scriptedResult({ summary: "Added a greeting.", changes: ["People see a greeting"], tests: "1 passed", answers: answersTo(text, scenario.answer),
          ...(text.includes('"description"') ? { description: "Adds a greeting file.\n\nTested with the greeting test." } : {}),
        });
      }
      case "findings":
        if (prompt.roleId !== "code-reviewer" && scenario.addedReviewer !== "pass") throw new Error(`Unsupported source reviewer: ${name}`);
        return scriptedResult({ verdict: "pass", findings: prompt.roleId === "code-reviewer" ? [{ text: "Consider a friendlier greeting.", severity: "nit" }] : [], confirms: [], disputes: [] });
      case "check-discovery":
        if (scenario.checks !== undefined) throw new Error(`Unsupported source check discovery: ${scenario.checks}`);
        return scriptedResult({ summary: "Checked with git, which every test machine has.", checks: [{ name: "Version", argv: ["git", "--version"], why: "A check that passes, for tests" }] });
      case "delivery":
        world.setScript(script => { script.releaseManagerPrompts = [...(script.releaseManagerPrompts ?? []), text]; });
        return scriptedResult({ summary: "Prepared the release notes.", notes: "A greeting was added." });
      case "notes": {
        if (text.includes("[roles]")) {
          const file = `${name.replace(/[^a-z0-9]+/g, "-")}.txt`, readOnly = /[Yy]ou are read-only/.test(text);
          writeFileSync(join(cwd, file), `Written while ${readOnly ? "read-only" : "changing the product"}\n`);
          if (readOnly) { await git(cwd, "add", file); await git(cwd, "commit", "--quiet", "-m", `${name} commits anyway`); }
        }
        return scriptedResult({ summary: `Notes from the ${name}.`, notes: [`A note from the ${name}`] });
      }
      default: throw new Error(`Unexpected source participant: ${prompt.result}`);
    }
  });
  const startAgentSession: StartAgentSession = (options, role) => {
    const scenario = JSON.parse(readFileSync(join(fakes.dir, "scenario.json"), "utf8")) as Scenario;
    if (options.reopen && scenario.reopen !== "resume") return Promise.reject(new ReopenFailed("This source scenario does not reopen conversations"));
    names.set(role.id, role.name.toLowerCase());
    return agents.start(options, role);
  };
  return { startAgentSession, toolProbe: scriptedToolProbe({ "claude-code": { status: "ready" }, codex: { status: "ready" }, grok: { status: "ready" }, antigravity: { status: "not-installed" }, gh: { status: "ready" }, git: { status: "ready" }, node: { status: "ready" } }) };
}
