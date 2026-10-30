import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Scenario } from "../fake-agent.js";
import { ScriptedAgents, scriptedResult } from "../scripted-agents.js";
import { scriptedToolProbe } from "../scripted-probes.js";
import { acceptanceAgents } from "./acceptance-agents.js";
import { waitFor } from "@petrina/test-support/fixtures";
import { ReopenFailed, type StartAgentSession } from "@petrina/orchestrator";
import type { PlanDraft } from "@petrina/core";

export type InstructionScript = Pick<Scenario, "planner" | "learnings" | "guide" | "reviewer"> & {
  ownFiles?: boolean;
  hold?: { title: string; file: string; role: string };
};

/** The same declared plan is used as a provider reply and as an accepted fixture prerequisite. */
export function instructionPlan(script: InstructionScript): PlanDraft {
  return { rationale: "Build, review and deliver the requested instruction change.", stages: [
    { kind: "do", title: "Build", roleId: "builder", profileIds: ["sol-xhigh"] },
    { kind: "review-chain", title: "Review", roleId: "code-reviewer", profileIds: ["opus-high"], maxRounds: 1 },
    ...(script.planner === "tester-after" ? [{ kind: "do" as const, title: "Test", roleId: "tester", profileIds: ["opus-high"] }] : []),
  ] };
}

/** Only provider replies: Git provenance, review context, offers and delivery remain real Engine behavior. */
export function instructionAgents(script: InstructionScript = {}) {
  const supported = new Set(["planner", "learnings", "guide", "reviewer", "ownFiles", "hold"]);
  for (const key of Object.keys(script)) if (!supported.has(key)) throw new Error(`Unsupported instruction reply option: ${key}`);
  if (script.planner && !["short", "tester-after"].includes(script.planner)) throw new Error("The instruction recipe needs its explicit short/tester-after plan");
  if (script.reviewer && script.reviewer !== "important") throw new Error("The instruction recipe needs its explicit Important finding");
  const ownFile = (cwd: string, title: string) => {
    if (script.ownFiles) writeFileSync(join(cwd, `${title.toLowerCase().replace(/\W+/g, "-")}.txt`), `${title}\n`);
  };
  const replies = acceptanceAgents({ beforeReply: async (prompt, signal) => {
    const title = /^# The task: (.+)$/m.exec(prompt.text)?.[1];
    if (prompt.result === "build" && title) ownFile(prompt.cwd, title);
    if (script.hold && title === script.hold.title && prompt.roleId === script.hold.role.replace(/ /g, "-")) {
      writeFileSync(`${script.hold.file}.reached`, "");
      await waitFor(() => {
        if (signal.aborted) throw new Error("The held instruction reply stopped before release");
        return !existsSync(script.hold!.file);
      }, "the instruction reply's explicit release");
    }
  } });
  replies.configure({ builder: "plain", buildReport: { summary: "Added a greeting." },
    ...(script.reviewer === "important" ? { reviewer: "important" } : {}) });
  const agents = new ScriptedAgents(async (prompt, signal) => {
    let reply: string;
    switch (prompt.result) {
      case "build": case "findings": case "votes": reply = await replies.respond(prompt, signal); break;
      case "plan": return scriptedResult(instructionPlan(script));
      case "check-discovery": return scriptedResult({ summary: "Inspect the private repository.", checks: [{ name: "Version", argv: ["git", "--version"], why: "A real passing product check" }] });
      case "checks": return scriptedResult({ summary: "Tried the greeting.", checks: [{ text: "A greeting file exists", result: "pass", evidence: "The private greeting file exists." }] });
      case "guide": return script.guide === "broken" ? "I could not tell what the reviewers missed." : scriptedResult(script.guide === "change of mind"
        ? { missed: false, line: "", why: "The note asks for a new colour: a change of mind, not a miss." }
        : { missed: true, line: "Every greeting also shows on the welcome page.", why: "The reviewers checked the greeting only where it was added." });
      default: throw new Error(`Unexpected instruction participant: ${prompt.result}`);
    }
    if (!script.learnings || !["build", "findings"].includes(prompt.result)) return reply;
    // The response is produced above by the canonical provider recipe, not parsed from application input.
    const value = JSON.parse(reply.slice("```petrina\n".length, -"\n```".length)) as object;
    const learnings = prompt.result === "build"
      ? ["Run the tests with bun test: they take a second.", "Greetings live at the repository root."]
      : prompt.roleId === "code-reviewer" ? ["Greetings live at the repository root!"] : [];
    return scriptedResult({ ...value, learnings });
  });
  const startAgentSession: StartAgentSession = (options, role) => options.reopen
    ? Promise.reject(new ReopenFailed("This instruction recipe starts fresh conversations, like its native original"))
    : agents.start(options, role);
  return { agents, startAgentSession,
    /** An explicit physical build input; no session, check or review completion is supplied. */
    acceptedBuild(cwd: string, title: string) {
      if (script.learnings) throw new Error("Learning delivery keeps the actual Builder's lesson response");
      ownFile(cwd, title);
      return replies.acceptedBuild(cwd, [], false);
    },
    toolProbe: scriptedToolProbe({ "claude-code": { status: "ready" }, codex: { status: "ready" }, grok: { status: "ready" }, antigravity: { status: "not-installed" }, gh: { status: "ready" }, git: { status: "ready" }, node: { status: "ready" } }),
    openings: (role: string) => agents.received().filter(prompt => prompt.roleId === role.replace(/ /g, "-") && prompt.turn === 1).map(prompt => prompt.text),
  };
}
