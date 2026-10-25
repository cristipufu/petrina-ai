import { ScriptedAgents, scriptedResult } from "../../scripted-agents.js";
import { scriptedToolProbe } from "../../scripted-probes.js";
import { expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NOTES_HANDOFF_RULE, type CheckId } from "@petrina/core";
import { Engine } from "../../engine.js";
import { EARLIER_REPORTS_RULE } from "../../../src/context.js";
import { executionFor } from "@petrina/orchestrator";
import { git, makeProduct, removeDir, tempDir } from "../../fixtures.js";

const HANDED_BACK = "What earlier agents on this task handed back";
const SUMMARY = "Private test copies resolve dependencies differently by path.";
const FACT = "Bun 1.4.2 resolves the copy's linked folder through the synchronous resolver, while Node keeps the link path.";
const SOURCE = "Source: https://github.com/oven-sh/bun/blob/bun-v1.4.2/src/resolver/resolver.zig and test/fixtures.ts";
const LIMIT = "Not run: no Windows machine was available, so the Windows behaviour is unverified.";
const COMMENTARY = "Commentary only: the fixture already uses Windows directory links.";

it("hands a notes report's facts, sources and limits on exactly as returned, never its commentary, in fresh and continued inputs", async () => {
  const root = tempDir("petrina-notes-handoff-");
  const agents = new ScriptedAgents((prompt, _signal, callbacks) => {
    if (prompt.result === "notes") {
      if (prompt.roleId === "researcher") {
        callbacks.onMessage?.({ id: 1, text: `${COMMENTARY}\nThe notes below are what I found.` });
        return scriptedResult({ summary: SUMMARY, notes: [FACT, SOURCE, LIMIT] });
      }
      return scriptedResult({ summary: "Notes from the ux designer.", notes: ["A note from the ux designer"] });
    }
    if (prompt.result === "build") return scriptedResult({ summary: "Read the handed-back research", changes: [], answers: [], learnings: [] });
    throw new Error(`Unexpected handoff participant: ${prompt.result}`);
  });
  const fakes = {
    received: () => agents.received(),
    openings: (role: string) => agents.received().filter(prompt => prompt.roleId === role && prompt.turn === 1).map(prompt => prompt.text),
    prompts: (role: string) => agents.received().filter(prompt => prompt.roleId === role).map(prompt => prompt.text),
  };
  const engine = new Engine(join(root, "data"), { startAgentSession: agents.start, toolProbe: scriptedToolProbe({ "claude-code": { status: "ready" }, codex: { status: "ready" }, grok: { status: "ready" }, antigravity: { status: "not-installed" }, gh: { status: "not-installed" }, git: { status: "ready" }, node: { status: "ready" } }) });
  try {
    engine.schedule = () => {};
    engine.s.setup!.checks = engine.s.tools.map(tool => ({ id: tool.id as CheckId, status: "ready" }));
    engine.s.tools.forEach(tool => { tool.status = "ready"; });
    const repo = await makeProduct(root);
    engine.s.products.push({ id: "p", name: "Product", path: repo, repo: "local/product", tone: "blue" });
    const task = engine.task(engine.addTask({ productId: "p", title: "Reach installed dependencies", description: "Make private test copies reliably reach installed dependencies.", backlog: true }))!;
    const scope = executionFor(task);
    Object.assign(scope.work, { worktree: repo, branch: "main", base: "main", baseSha: await git(repo, "rev-parse", "HEAD") });
    const research = { id: "research", kind: "do" as const, roleId: "researcher", title: "Research", profileIds: ["sol-high"] };
    const screens = { id: "screens", kind: "do" as const, roleId: "ux-designer", title: "Screens", profileIds: ["sol-high"] };
    const build = { id: "build", kind: "do" as const, roleId: "builder", title: "Build", profileIds: ["sol-high"] };
    task.plan = { rationale: "Research, build, then review", plannerProfileId: "sol-high", stages: [research, build, screens, { id: "review", kind: "review-chain", roleId: "code-reviewer", title: "Review", profileIds: ["grok-high"] }] };
    const run = async (stage: typeof research, fixing = false) => {
      task.stageIndex = task.plan!.stages.indexOf(stage);
      task.fixing = fixing;
      await engine["work"].runDo(scope, stage, new AbortController().signal);
      engine.finishStep(scope);
      const input = task.journey!.at(-1)!.agentInputs!.at(-1)!;
      // The journey keeps the exact message the agent really received.
      expect(readFileSync(input.exact!.file, "utf8")).toBe(fakes.received().at(-1)!.text);
      return input;
    };

    await run(research);
    expect(fakes.openings("researcher")[0]!.split(NOTES_HANDOFF_RULE)).toHaveLength(2);
    const returned = task.journey!.at(-1)!.agentResults!.at(-1)!.value;
    expect(returned).toEqual({ summary: SUMMARY, notes: [FACT, SOURCE, LIMIT] });
    expect(task.handedBack).toEqual([expect.objectContaining({ stageId: "research", roleName: "Researcher", summary: SUMMARY, notes: [FACT, SOURCE, LIMIT] })]);
    // The commentary stays in the conversation the coordinator reads; it is not part of the report.
    expect(task.session.some(line => line.from === "agent" && line.text.includes(COMMENTARY))).toBe(true);
    expect(JSON.stringify(task.handedBack)).not.toContain(COMMENTARY);

    const report = `${EARLIER_REPORTS_RULE}\n\nResearcher, in “Research”: ${SUMMARY}\n- ${FACT}\n- ${SOURCE}\n- ${LIMIT}`;
    const fresh = await run(build);
    expect(fresh.mode).toBe("fresh");
    expect(fresh.sections.find(section => section.title === HANDED_BACK)?.body).toBe(report);
    expect(fakes.prompts("builder")[0]).toContain(`## ${HANDED_BACK}\n${report}`);
    expect(fakes.prompts("builder")[0]).not.toContain(COMMENTARY);

    // An unchanged report is left out of the continued conversation but stays readable in its complete context.
    const unchanged = await run(build, true);
    expect(unchanged.mode).toBe("continued");
    expect(unchanged.sessionId).toBe(fresh.sessionId);
    expect(unchanged.sections.some(section => section.title === HANDED_BACK)).toBe(false);
    expect(unchanged.manifest).toContainEqual(expect.objectContaining({ name: HANDED_BACK, kind: "omitted" }));
    expect(fakes.prompts("builder")[1]).not.toContain(FACT);
    expect(readFileSync(scope.work.builderSession!.context!.file, "utf8")).toContain(`## ${HANDED_BACK}\n${report}`);

    // A later report changes the handoff, so the continued conversation receives it whole.
    await run(screens);
    const current = `${report}\n\nUX designer, in “Screens”: Notes from the ux designer.\n- A note from the ux designer`;
    const changed = await run(build, true);
    expect(changed.mode).toBe("continued");
    expect(changed.sessionId).toBe(fresh.sessionId);
    expect(changed.sections.find(section => section.title === HANDED_BACK)?.body).toBe(current);
    expect(changed.manifest).toContainEqual(expect.objectContaining({ name: HANDED_BACK, kind: "text" }));
    expect(fakes.prompts("builder")[2]).toContain(`## ${HANDED_BACK}\n${current}`);

    // A fresh conversation receives the complete current reports.
    delete scope.work.builderSession;
    const restarted = await run(build, true);
    expect(restarted.mode).toBe("fresh");
    expect(restarted.sessionId).not.toBe(fresh.sessionId);
    expect(restarted.sections.find(section => section.title === HANDED_BACK)?.body).toBe(current);
    expect(fakes.prompts("builder").at(-1)).toContain(`## ${HANDED_BACK}\n${current}`);
    for (const prompt of fakes.prompts("builder")) expect(prompt).not.toContain(COMMENTARY);
  } finally { await engine.shutdown(); removeDir(root); }
});
