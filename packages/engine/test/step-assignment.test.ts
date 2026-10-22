import { afterAll, beforeAll, describe, expect, it, spyOn } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { BUILT_IN_ROLES, type ConversationNote, type Stage } from "@petrina/core";
import { Engine } from "./engine.js";
import { Coordination } from "../src/coordination.js";
import { AgentBrowser } from "../src/browser.js";
import { executionFor } from "../src/repository-context.js";
import { currentStepAssignment } from "../src/prompts.js";
import { BuildResult, NotesResult, ReviewResult } from "../src/roles.js";
import { Fakes, git, makeProduct, removeDir, tempDir, waitFor } from "./fixtures.js";

const ASSIGNMENT = "Current step assignment";
const RESEARCH = "Research how agent hosts handle long waits";
const REQUEST = "Complete product request: improve monitoring and establish host wait behavior.";
const BRIEF = "Approved brief: retain every monitoring requirement.";
const stage = { id: "research", kind: "do", title: RESEARCH, roleId: "researcher", profileIds: ["opus-high"], assignments: [{ profileId: "opus-high", by: "planner", reason: "PRIVATE-SELECTION-REASON", changeReason: "PRIVATE-READINESS-REASON" }] } satisfies Stage;

// Native ACP still receives the prompts; this contract does not need a browser server.
let browser: ReturnType<typeof spyOn<typeof AgentBrowser, "start">>;
beforeAll(() => { browser = spyOn(AgentBrowser, "start").mockResolvedValue(undefined as never); });
afterAll(() => browser.mockRestore());

const assignment = (current: Stage | undefined, roleId = "researcher") => currentStepAssignment({ plan: current ? { stages: [current], rationale: "PRIVATE-PLAN-RATIONALE", plannerProfileId: "opus-high" } : undefined, stageIndex: 0 }, roleId);

describe("current planned contribution", () => {
  it("uses only the stage title for built-in and custom roles, including generic labels", () => {
    for (const roleId of ["researcher", "added-specialist", "builder"]) {
      for (const title of [RESEARCH, "Build"]) {
        const sections = assignment({ ...stage, roleId, title }, roleId);
        expect(sections).toHaveLength(1);
        expect(sections[0]!.body).toContain(`Planned step: ${title}`);
        expect(sections[0]!.body).toContain("full task and approved brief remain authoritative");
        expect(sections[0]!.body).toContain("your role's duties");
        expect(JSON.stringify(sections)).not.toContain("PRIVATE-");
      }
    }
  });

  it("addresses both design participants and each review role without assigning the step to side errands", () => {
    const design: Stage = { ...stage, kind: "converge", roleId: "architect", title: "Design", reviewerProfileIds: ["sol-high"] };
    for (const roleId of ["architect", "design-reviewer"]) expect(assignment(design, roleId)).toHaveLength(1);
    const review: Stage = { ...stage, kind: "review-chain", title: "Review", roleId: "code-reviewer", profileIds: ["sol-high", "opus-high"], roleIds: ["code-reviewer", "added-reviewer"] };
    for (const roleId of ["code-reviewer", "added-reviewer"]) expect(assignment(review, roleId)[0]!.body).toContain("Planned step: Review");
    for (const roleId of ["researcher", "check-finder", "guide-keeper", "verifier"]) expect(assignment(review, roleId)).toEqual([]);
    expect(assignment({ ...stage, kind: "gate" })).toEqual([]);
  });

  it("leaves absent historical metadata unknown instead of reconstructing an assignment", () => {
    expect(assignment(undefined)).toEqual([]);
    expect(assignment({ ...stage, title: "  " })[0]!.body).toStartWith("No planned step title was recorded.");
    expect(assignment({ ...stage, title: undefined as unknown as string })[0]!.body).toStartWith("No planned step title was recorded.");
    expect(currentStepAssignment({ plan: { stages: [stage], rationale: "", plannerProfileId: "opus-high" }, stageIndex: -1 }, "planner")).toEqual([]);
  });
});

/** Exercise native prompts directly; planning, design and check discovery are unrelated to this contract. */
async function fixture() {
  const root = tempDir("petrina-step-assignment-");
  const repo = makeProduct(root);
  const fakes = new Fakes(join(root, "fake"));
  fakes.scenario({ builder: "plain", reopen: "resume" });
  const engine = new Engine(join(root, "data"), {
    agentCommand: () => [process.execPath, join(import.meta.dir, "fake-agent.ts"), fakes.dir],
    toolPath: () => "/bin/true", usageCommands: { codex: null, grok: null, antigravity: null },
  });
  engine.schedule = () => {};
  engine.setPoolPaused(true);
  await engine.checkTools();
  engine.s.products.push({ id: "product", name: "Product", repo: "local/product", path: repo, defaultBranch: "main", tone: "blue" });
  const task = engine.task(engine.addTask({ productId: "product", title: "Improve long waits", description: REQUEST, backlog: true }))!;
  const scope = executionFor(task);
  Object.assign(scope.work, { worktree: repo, branch: "main", base: "main", baseSha: git(repo, "rev-parse", "HEAD") });
  task.plan = { stages: [structuredClone(stage)], rationale: "PRIVATE-PLAN-RATIONALE", plannerProfileId: "opus-high" };
  task.stageIndex = 0;
  engine.s.pool.paused = false;
  const sections = () => [{ title: "Design brief", body: BRIEF }];
  const inputs = () => task.journey!.flatMap(step => step.agentInputs ?? []);
  const close = async () => { await engine.shutdown(); removeDir(root); };
  return { engine, task, scope, fakes, repo, sections, inputs, close };
}

describe.concurrent("assignment in native and saved input", () => {
  it("reports a lone Builder's takeover with the previous participant and its own saved input", async () => {
    const f = await fixture();
    try {
      f.fakes.scenario({ builder: "plain", limited: [{ model: "opus", role: "builder", spendCap: true }] });
      f.task.plan!.stages[0]!.roleId = "builder";
      await f.engine["turns"].turn(f.scope, "builder", "opus-high", f.sections, BuildResult, new AbortController().signal);
      const inputs = f.inputs();
      expect(inputs).toHaveLength(2);
      const nodes = f.task.journey!;
      expect(nodes[0]!.reason).toBe("another agent took over");
      const c = new Coordination(f.engine);
      const page = await c.call("watch.events", { taskIds: [f.task.id], from: "oldest", kinds: ["profile.replaced", "seat.started"], timeoutMs: 0 });
      const events = page.events as { kind: string; refs: { previousInput: Record<string, unknown> } }[];
      expect(events.filter(event => event.kind === "profile.replaced")).toEqual([expect.objectContaining({ previousProfileId: "opus-high", profileId: inputs[1]!.profileId, previousNodeId: nodes[0]!.id, reason: "Claude Code's spend limit" })]);
      const replaced = events.find(event => event.kind === "profile.replaced")!;
      expect(await c.call("journey.input", replaced.refs.previousInput)).toMatchObject({ outcome: "completed", conversation: inputs[0]!.sessionId, profileId: "opus-high", evidence: "exact" });
      expect(events.filter(event => event.kind === "seat.started")[1]).toMatchObject({ replaced: { previousProfileId: "opus-high", nodeId: nodes[0]!.id, conversation: inputs[0]!.sessionId } });
    } finally { await f.close(); }
  });

  it("records the bound product before a shared agent starts, independently of the selected product", async () => {
    const f = await fixture();
    try {
      const base = f.scope.work.baseSha!;
      f.task.repositories = [{ ...f.scope.work, productId: "first", completedStages: [], baseSha: "first-base", stepAttempts: 1 }, { ...f.scope.work, completedStages: [], stepAttempts: 6 }];
      delete f.task.repository;
      f.task.activeProductId = "first";
      const scope = executionFor(f.task, "product");
      await f.engine["turns"].turn(scope, "researcher", "opus-high", f.sections, NotesResult, new AbortController().signal);
      expect(f.inputs()[0]).toMatchObject({ productId: "product", stepAttempts: 7, versions: { base } });
      const page = await new Coordination(f.engine).call("watch.events", { taskIds: [f.task.id], from: "oldest", kinds: ["seat.started"], timeoutMs: 0 });
      expect(page.events).toContainEqual(expect.objectContaining({ productId: "product", stepAttempts: 7, versions: { base } }));
    } finally { await f.close(); }
  });

  it("sends a fresh supporting role its specific contribution and preserves the exact section", async () => {
    const f = await fixture();
    try {
      const roleId = f.engine.addRole({ ...BUILT_IN_ROLES.find(role => role.id === "researcher")!, name: "Host researcher" });
      f.task.plan!.stages[0]!.roleId = roleId;
      await f.engine["turns"].turn(f.scope, roleId, "opus-high", f.sections, NotesResult, new AbortController().signal);
      const sent = f.fakes.received("host researcher")[0]!.text;
      const saved = f.inputs()[0]!;
      expect(saved.mode).toBe("fresh");
      const section = saved.sections.find(section => section.title === ASSIGNMENT)!;
      expect(section.body).toContain(RESEARCH);
      expect(sent).toContain(`## ${section.title}\n${section.body}`);
      expect(sent).toContain(REQUEST); expect(sent).toContain(BRIEF);
      expect(sent).not.toContain("PRIVATE-");
      expect(saved.assignment?.reason).toBe("PRIVATE-SELECTION-REASON");
      expect(saved.taskDescription).toBe(REQUEST);
      expect(readFileSync(saved.exact!.file, "utf8")).toBe(sent);
      expect(saved.manifest).toContainEqual(expect.objectContaining({ name: ASSIGNMENT, kind: "text", size: section.body.length }));
    } finally { await f.close(); }
  });

  it("updates a Builder's edited assignment on return, while retaining unchanged background in its packet", async () => {
    const f = await fixture();
    try {
      Object.assign(f.task.plan!.stages[0]!, { roleId: "builder", title: "Build" });
      const turn = async (resume?: ConversationNote) => {
        let completed!: ConversationNote;
        await f.engine["turns"].turn(f.scope, "builder", "opus-high", f.sections, BuildResult, new AbortController().signal, { resume, completed: note => { completed = structuredClone(note); } });
        delete f.scope.work.conversation;
        return completed;
      };
      const first = await turn();
      expect(f.fakes.prompts("builder")[0]).toContain("Planned step: Build");
      f.task.plan!.stages[0]!.title = "Implement host wait monitoring";
      const second = await turn(first);
      const sent = f.fakes.received("builder")[1]!;
      expect(sent.session).toBe(first.sessionId);
      expect(sent.text).toContain("Planned step: Implement host wait monitoring");
      expect(sent.text).not.toContain(REQUEST); expect(sent.text).not.toContain(BRIEF);
      expect(f.inputs()[1]!.sections.find(section => section.title === ASSIGNMENT)!.body).toContain("Implement host wait monitoring");
      expect(f.inputs()[1]!.mode).toBe("continued");
      const third = await turn(second);
      expect(f.fakes.prompts("builder")[2]).not.toContain(`## ${ASSIGNMENT}`);
      expect(readFileSync(third.context!.file, "utf8")).toContain("Planned step: Implement host wait monitoring");
      expect(readFileSync(third.context!.file, "utf8")).toContain(BRIEF);
      expect(f.inputs()[2]!.manifest).toContainEqual(expect.objectContaining({ name: ASSIGNMENT, kind: "omitted" }));
    } finally { await f.close(); }
  });

  it("sends ordinary single and parallel reviewers the current planned step", async () => {
    const f = await fixture();
    try {
      Object.assign(f.task.plan!.stages[0]!, { kind: "review-chain", roleId: "code-reviewer", title: "Review", profileIds: ["opus-high"] });
      await f.engine["turns"].turn(f.scope, "code-reviewer", "opus-high", f.sections, ReviewResult, new AbortController().signal, { reviewerKey: "0" });
      delete f.scope.work.conversation;
      f.task.hunt = { stageId: f.task.plan!.stages[0]!.id, round: 1, reported: {}, findings: 0 };
      let completed!: ConversationNote;
      await f.engine["turns"].parallel(f.scope, "code-reviewer", "opus-high", f.repo, f.sections, ReviewResult, new AbortController().signal, { reviewerKey: "0", reviewContext: true, completed: note => { completed = structuredClone(note); } });
      expect(f.fakes.prompts("code reviewer")).toHaveLength(2);
      for (const [index, sent] of f.fakes.prompts("code reviewer").entries()) {
        const section = f.inputs()[index]!.sections.find(section => section.title === ASSIGNMENT)!;
        expect(section.body).toContain("Planned step: Review");
        expect(sent).toContain(`## ${section.title}\n${section.body}`);
        expect(sent).not.toContain("PRIVATE-");
      }
      f.task.plan!.stages[0]!.title = "Review host wait monitoring";
      await f.engine["turns"].parallel(f.scope, "code-reviewer", "opus-high", f.repo, f.sections, ReviewResult, new AbortController().signal, { reviewerKey: "0", reviewContext: true, resume: completed });
      const continued = f.fakes.received("code reviewer")[2]!;
      expect(continued.session).toBe(completed.sessionId);
      expect(continued.text).toContain("Planned step: Review host wait monitoring");
      expect(continued.text).not.toContain(REQUEST); expect(continued.text).not.toContain(BRIEF);
      expect(f.inputs()[2]!.mode).toBe("continued");
      const updated = f.inputs()[2]!.sections.find(section => section.title === ASSIGNMENT)!;
      expect(continued.text).toContain(`## ${updated.title}\n${updated.body}`);
      f.task.capacityResume = [{ sessionId: completed.sessionId, profileId: completed.profileId, roleId: completed.roleId, toolId: completed.toolId, model: completed.model, member: "code-reviewer:opus-high" }];
      f.task.plan!.stages[0]!.title = "Review the updated host wait handling";
      await f.engine["turns"].parallel(f.scope, "code-reviewer", "opus-high", f.repo, f.sections, ReviewResult, new AbortController().signal, { reviewerKey: "0" });
      const retry = f.fakes.received("code reviewer")[3]!;
      expect(retry.session).toBe(completed.sessionId);
      expect(retry.text).toContain("Planned step: Review the updated host wait handling");
      expect(retry.text).not.toContain(REQUEST); expect(retry.text).not.toContain(BRIEF);
      expect(f.inputs().at(-1)!.updates!.at(-1)!.text).toBe(retry.text);
      const resumed = f.inputs().at(-1)!;
      expect(resumed).toMatchObject({ resumed: true, mode: "continued", requestedProfileId: "opus-high", reviewerKey: "0", sessionId: completed.sessionId });
      expect(resumed.sections.map(section => section.title)).toEqual([ASSIGNMENT]);
      expect(readFileSync(resumed.exact!.file, "utf8")).toBe(retry.text);
      const c = new Coordination(f.engine);
      const events = await c.call("watch.events", { taskIds: [f.task.id], from: "oldest", kinds: ["seat.started"], timeoutMs: 0 });
      expect(events.events).toContainEqual(expect.objectContaining({ seat: "reviewer:0", attempt: 4, mode: "resumed", conversation: completed.sessionId }));
      expect(await c.call("journey.input", { taskId: f.task.id, nodeId: f.task.journey!.at(-1)!.id, seat: "reviewer:0", index: 3 })).toMatchObject({ mode: "resumed", evidence: "exact", text: retry.text });
      expect(f.task.journey!.at(-1)!.agentResults!.map(result => result.inputIndex)).toEqual([0, 1, 2, 3]);
    } finally { await f.close(); }
  });

  for (const reopen of ["resume", undefined] as const) it(`refreshes an interrupted supporting assignment with ${reopen ?? "fresh fallback"} and saves the input actually sent`, async () => {
    const f = await fixture();
    const abort = new AbortController();
    let running: Promise<unknown> | undefined;
    let failure: unknown;
    try {
      f.fakes.scenario({ controlled: true, cancelHeld: true, reopen });
      running = f.engine["turns"].turn(f.scope, "researcher", "opus-high", f.sections, NotesResult, abort.signal).catch(error => { failure = error; return error; });
      await waitFor(() => {
        if (failure) throw failure;
        return f.fakes.received("researcher").length && f.scope.work.conversation?.briefed;
      }, "the supporting role to receive its assignment");
      abort.abort(); expect(await running).toBeInstanceOf(Error);
      const original = f.fakes.received("researcher")[0]!;
      expect(original.text).toContain(`Planned step: ${RESEARCH}`);
      f.task.plan!.stages[0]!.title = "Research host wait limits and resume behavior";
      f.fakes.scenario({ reopen });
      await f.engine["turns"].turn(f.scope, "researcher", "opus-high", f.sections, NotesResult, new AbortController().signal);
      const sent = f.fakes.received("researcher")[1]!;
      expect(sent.text).toContain("Planned step: Research host wait limits and resume behavior");
      expect(f.inputs()[0]!.sections.find(section => section.title === ASSIGNMENT)!.body).toContain(`Planned step: ${RESEARCH}`);
      if (reopen) {
        expect(sent.session).toBe(original.session);
        expect(sent.text).not.toContain(REQUEST); expect(sent.text).not.toContain(BRIEF);
        expect(f.inputs().at(-1)!.updates!.at(-1)!.text).toBe(sent.text);
        expect(f.inputs().at(-1)).toMatchObject({ resumed: true, mode: "continued", requestedProfileId: "opus-high", sessionId: original.session });
        expect(f.inputs().at(-1)!.sections.map(section => section.title)).toEqual([ASSIGNMENT]);
      } else {
        expect(sent.session).not.toBe(original.session);
        expect(sent.text).toContain(REQUEST); expect(sent.text).toContain(BRIEF);
        expect(f.inputs().at(-1)!.sections.find(section => section.title === ASSIGNMENT)!.body).toContain("Research host wait limits and resume behavior");
        expect(f.inputs().at(-1)!.freshReason).toBeString();
        expect(f.inputs().at(-1)!.resumed).toBeUndefined();
      }
      expect(readFileSync(f.inputs().at(-1)!.exact!.file, "utf8")).toBe(sent.text);
    } finally { abort.abort(); await running; await f.close(); }
  });
});
