import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { WorkChoice } from "@petrina/core";
import { ReopenFailed, type StartAgentSession } from "@petrina/orchestrator";
import { waitFor } from "@petrina/test-support/fixtures";
import { ScriptedAgents, scriptedResult } from "../scripted-agents.js";
import { answersTo, findingIds } from "../scripted-findings.js";

/** Provider replies only. The real Engine still owns plans, routing, Git, checks, versions and delivery. */
interface SharedScript {
  planner?: "short" | "parallel" | "tester-first" | "tester-with-design" | "copy";
  builder?: "plain";
  reopen?: "resume";
  affectedProducts?: string[];
  worksOn?: WorkChoice[];
  risk?: "low";
  reviewer?: "important-twice";
  reviewRounds?: number;
  unassignedFinding?: boolean;
  fixes?: "change";
  architect?: "writes";
  controlled?: boolean;
}

/** This one narrowly scripted recipe replaces ACP only where a workflow does not assert transport. */
export function sharedAgents(dir: string) {
  mkdirSync(dir, { recursive: true });
  let script: SharedScript = { planner: "short", builder: "plain", reopen: "resume" }, repairs = 0;
  const names = new Map<string, string>(), roleIds = new Map<string, string>();
  const agents = new ScriptedAgents(async (prompt, signal) => {
    const plan = script, { result, cwd, text } = prompt;
    if (plan.controlled && prompt.turn === 1) await waitFor(() => {
      if (signal.aborted) throw new Error("The shared provider reply stopped before it was released");
      return existsSync(join(dir, `release-${prompt.sessionId}`));
    }, "the explicitly held shared provider reply");
    const done = (value: unknown) => scriptedResult(value);
    switch (result) {
      case "plan": {
        const build = { kind: "do", title: "Build", roleId: "builder", profileIds: [plan.planner === "tester-first" ? "opus-xhigh" : "sol-xhigh"] };
        const test = { kind: "do", title: "Try acceptance", roleId: "tester", profileIds: ["opus-high"] };
        const review = { kind: "review-chain", title: "Review", roleId: "code-reviewer", profileIds: plan.planner === "short" || plan.planner === "copy" ? ["opus-high"] : plan.planner === "tester-first" ? ["opus-xhigh", "sol-xhigh"] : ["opus-high", "sol-high"], maxRounds: plan.reviewRounds ?? (plan.planner === "short" || plan.planner === "parallel" || plan.planner === "copy" ? 1 : 2) };
        const design = { kind: "converge", title: "Design", roleId: "architect", profileIds: ["opus-xhigh"], reviewerRoleId: "design-reviewer", reviewerProfileIds: ["sol-xhigh"], maxRounds: 2 };
        const check = { kind: "gate", title: "Your design check", roleId: "architect", gate: "design" };
        const stages = plan.planner === "tester-first" ? [build, test, review]
          : plan.planner === "copy" ? [build, { kind: "do", title: "Copy", roleId: roleIds.get("copywriter"), profileIds: ["opus-high"] }, review]
          : ["short", "parallel"].includes(plan.planner ?? "") ? [build, review]
          : [design, check, build, ...(plan.planner === "tester-with-design" ? [test] : []), review];
        return done({ rationale: "Explicit shared repository prerequisites.", stages,
          ...(plan.worksOn ? { worksOn: plan.worksOn } : {}),
          ...(plan.risk ? { risk: { level: plan.risk, why: "Only the greeting's words change." } } : {}) });
      }
      case "check-discovery": return done({ summary: "Git is the fixture's check.", checks: [{ name: "Version", argv: ["git", "--version"], why: "A real passing product check" }] });
      case "brief":
        if (plan.architect === "writes") writeFileSync(join(cwd, "architecture.txt"), "Before the design review");
        return done({ summary: "A greeting file.", forUsers: ["People see a greeting"], areas: ["Greeting"], acceptance: ["A greeting file exists"], risks: [], answers: [] });
      case "objections": return done({ objections: [] });
      case "build":
        writeFileSync(join(cwd, "greeting.txt"), "Hello\n");
        if (plan.fixes === "change" && text.includes("You are fixing the review findings")) writeFileSync(join(cwd, "welcome.txt"), `Hello repair ${++repairs}\n`);
        return done({ summary: "Added a greeting.", changes: ["People see a greeting"], tests: "Petrina runs the configured checks.",
          ...(text.includes('"description"') ? { description: "Adds a greeting file.\n\nTested with the greeting test." } : {}), answers: answersTo(text) });
      case "checks": return done({ summary: "Tried it: it works.", checks: [{ text: "A greeting file exists", result: "pass", evidence: "The scripted greeting check returned the expected result.", ...(plan.affectedProducts ? { productIds: plan.affectedProducts } : {}) }] });
      case "findings": {
        if (prompt.roleId === "security-reviewer") return done({ verdict: "pass", findings: [], confirms: [], disputes: [] });
        if (prompt.roleId !== "code-reviewer") throw new Error(`Unexpected findings participant: ${prompt.roleId}`);
        const important = plan.reviewer === "important-twice" && !text.includes("This is review round") && !(plan.fixes === "change" && existsSync(join(cwd, "welcome.txt")));
        const finding = { text: important ? prompt.model === "opus" ? "The greeting is missing on the welcome page." : "The GREETING is missing on the welcome page!" : "Consider a friendlier greeting.",
          ...(important ? { where: "greeting.txt" } : {}), severity: important ? "important" : "nit", evidence: important ? "Opened the welcome page" : "On the current welcome page the greeting is still terse; a warmer greeting would be friendlier.",
          ...(plan.affectedProducts ? { productIds: plan.affectedProducts } : {}) };
        return done({ verdict: important ? "fail" : "pass", findings: [finding,
          ...(important && plan.unassignedFinding && plan.affectedProducts ? [{ text: "The shared ownership needs a coordinator decision.", severity: "important" }] : [])], confirms: [], disputes: [] });
      }
      case "votes": return done({ verdicts: findingIds(text, "Important findings to check (a verdict on every one, by id)").map(id => ({ id, verdict: "real", reason: "The scripted welcome page has no greeting." })) });
      case "guide": return done({ missed: true, line: "Every greeting also shows on the welcome page.", why: "The reviewers checked the greeting only where it was added." });
      case "delivery": {
        const titles = [...text.matchAll(/^### (.+)$/gm)].map(match => match[1]!);
        return done({ summary: `Wrote the notes on ${titles.length} changes.`, notes: `## What's new\n${titles.map(title => `- ${title}`).join("\n")}` });
      }
      case "notes":
        if (names.get(prompt.roleId) !== "copywriter") throw new Error(`Unexpected notes participant: ${prompt.roleId}`);
        writeFileSync(join(cwd, "copywriter.txt"), "Written while changing the product\n");
        return done({ summary: "Notes from the copywriter.", notes: ["A note from the copywriter"] });
      default: throw new Error(`Unexpected participant in the shared repository recipe: ${result}`);
    }
  });
  const start: StartAgentSession = (options, role) => {
    names.set(role.id, role.name.toLowerCase());
    roleIds.set(role.name.toLowerCase(), role.id);
    // Planner needs the added notes role's identity; it is declared in the supplied prompt.
    if (options.reopen && script.reopen !== "resume") return Promise.reject(new ReopenFailed("This shared recipe starts fresh conversations"));
    return agents.start(options, role);
  };
  const received = (role?: string) => agents.received().map(prompt => ({ role: names.get(prompt.roleId)!, session: prompt.sessionId, text: prompt.text, turn: prompt.turn })).filter(entry => !role || entry.role === role);
  return { dir, start, agents,
    scenario(next: SharedScript) {
      const supported = new Set(["planner", "builder", "reopen", "affectedProducts", "worksOn", "risk", "reviewer", "reviewRounds", "unassignedFinding", "fixes", "architect", "controlled"]);
      for (const key of Object.keys(next)) if (!supported.has(key)) throw new Error(`Unsupported shared provider option: ${key}`);
      script = structuredClone(next);
    },
    received,
    openings: (role: string) => received(role).filter(entry => entry.turn === 1).map(entry => entry.text),
    /** The real role catalogue is an input to a plan, never inferred from an English role name. */
    roles(entries: readonly { id: string; name: string }[]) { for (const role of entries) roleIds.set(role.name.toLowerCase(), role.id); },
  };
}
