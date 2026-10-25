import { executionFor } from "@petrina/orchestrator";
import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import { draftOf, MAINTENANCE_ROLES, type JourneyStep, type Objection } from "@petrina/core";
import { Engine } from "../../engine.js";
import { Fakes, removeDir, tempDir } from "../../fixtures.js";

const NOTES = "Final design-review notes (advice only)";

const CALL = "Keep the greeting in English only.";

const point = (id: string, round: number, text: string, status: Objection["status"], extra: Partial<Objection> = {}): Objection => ({ id, round, text, blocking: false, raisedBy: "sol-high", status, ...extra });

const designStep = (id: string, roleId: string, round: number, sub: number, recorded?: readonly Objection[], extra: Partial<JourneyStep> = {}): JourneyStep => ({
  id, kind: "agent", stageId: "design", round, sub, roleId, startedAt: round * 10 + sub, endedAt: round * 10 + sub + 1, end: "done",
  ...(recorded ? { result: { objections: recorded.map((entry) => sub ? { id: entry.id, round: entry.round, text: entry.text, blocking: entry.blocking, raisedBy: entry.raisedBy, status: "open" as const } : entry) } } : {}), ...extra,
});

const designCheck = (id: string, round: number): JourneyStep => ({ id, kind: "you", stageId: "check", round, sub: 0, waitsFor: "design", startedAt: round * 10 + 5, endedAt: round * 10 + 6, end: "done" });

async function fixture() {
  const root = tempDir("petrina-design-notes-");
  const fakes = new Fakes(join(root, "fake"));
  const engine = new Engine(join(root, "data"), {
    agentCommand: () => undefined,
    toolPath: () => process.execPath, usageCommands: { codex: null, grok: null, antigravity: null },
  });
  engine.schedule = () => {};
  engine.setPoolPaused(true);
  engine.s.pool.paused = false;
  engine.s.products.push({ id: "product", name: "Product", repo: "local/product", defaultBranch: "main", tone: "blue" });
  const task = engine.task(engine.addTask({ productId: "product", title: "Add a greeting", description: "A greeting file.", backlog: true }))!;
  const scope = executionFor(task);
  task.plan = { rationale: "Design, then build", plannerProfileId: "opus-high", stages: [
    { id: "design", kind: "converge", title: "Agree on the greeting", roleId: "architect", profileIds: ["opus-high"], reviewerRoleId: "design-reviewer", reviewerProfileIds: ["sol-high"], maxRounds: 3 },
    { id: "check", kind: "gate", title: "Your design check", roleId: "architect", profileIds: [], gate: "design" },
    { id: "build", kind: "do", title: "Build", roleId: "builder", profileIds: ["opus-high"] },
    { id: "review", kind: "review-chain", title: "Review", roleId: "code-reviewer", profileIds: ["opus-high", "sol-high"] },
  ] };
  task.stageIndex = 2;
  task.brief = { summary: "A greeting file.", forUsers: ["People see a greeting"], areas: ["Greeting"], acceptance: [{ text: "A greeting file exists" }], risks: [] };
  /** The design records: the objections' current state and the journey's design steps, in order. */
  const records = (objections: readonly Objection[], journey: readonly JourneyStep[]) => {
    task.objections = structuredClone(objections) as typeof task.objections;
    task.journey = structuredClone(journey) as typeof task.journey;
  };
  const sections = (roleId = "builder") => engine["context"].sectionsFor(scope, roleId);
  const notesFor = async (roleId = "builder") => (await sections(roleId)).filter((section) => section.title.startsWith("Final design-review notes"));
  const inputs = () => task.journey!.flatMap((step) => step.agentInputs ?? []);
  const close = async () => { await engine.shutdown(); removeDir(root); };
  return { engine, task, scope, fakes, records, sections, notesFor, inputs, close };
}

const accepted = point("o1", 1, "Say who sees the greeting.", "accepted", { blocking: true, answer: "Added it." });

const rejected = point("o2", 1, "Also translate the greeting.", "rejected", { answer: "Out of scope." });

const stale = point("o3", 2, "Earlier tip: reuse the old banner helper.", "noted");

const tip = point("o4", 3, "Existing helpers drop settings passed through process variables; use a private settings file.", "noted");

const other = point("o5", 3, "The work-log fake must list both tools, or assignment assertions change.", "noted");

const revisedObjections = [accepted, rejected, stale, tip, other];

const revisedJourney = [
  designStep("j1", "architect", 1, 0),
  designStep("j2", "design-reviewer", 1, 1, [accepted, rejected]),
  designStep("j3", "architect", 2, 0, [accepted, rejected]),
  designStep("j4", "design-reviewer", 2, 1, [stale]),
  designCheck("j5", 2),
  designStep("j6", "architect", 3, 0),
  designStep("j7", "design-reviewer", 3, 1, [tip, other]),
];

const beforeRevision = revisedObjections.slice(0, 3);

describe.concurrent("final design-review notes for builders",()=>{it("hands builders only the latest settling review's noted points, labelled as advice after the brief", async () => {
    const f = await fixture();
    try {
      f.records(revisedObjections, revisedJourney);
      const all = await f.sections();
      const titles = all.map((section) => section.title);
      expect(titles.indexOf(NOTES)).toBe(titles.indexOf("Design brief") + 1);
      const body = all.find((section) => section.title === NOTES)!.body;
      expect(body).toStartWith("From “Agree on the greeting”, round 3, by Design reviewer:");
      for (const words of ["advice only, not requirements, acceptance items or blockers", "Check each one against the current code", "The approved brief, the coordinator's notes and any design call win", "Do not add scope because of a note", "you need not answer them"]) expect(body).toContain(words);
      expect(body.split("\n").filter((line) => line.startsWith("- "))).toEqual([`- ${tip.text}`, `- ${other.text}`]);
      for (const left of [accepted, stale, rejected]) expect(body).not.toContain(left.text);
      expect(body).not.toContain("several products");
      // The rest of the Builder's input is what it was without notes.
      const without = await (async () => { const saved = f.task.journey; f.task.journey = undefined; try { return await f.sections(); } finally { f.task.journey = saved; } })();
      expect(all.filter((section) => section.title !== NOTES)).toEqual(without);
      // The warning follows the products actually taking part, not whether the task keeps a product list.
      const SEVERAL = "This task has several products, so some notes may concern another product.";
      const warned = async (repositories: NonNullable<typeof f.task.repositories>) => {
        f.task.repositories = repositories;
        const bodies = await Promise.all(repositories.filter((work) => !work.removed).map(async (work) => (await f.engine["context"].sectionsFor(executionFor(f.task, work.productId), "builder")).find((section) => section.title === NOTES)!.body));
        return bodies.map((text) => text.includes(SEVERAL));
      };
      const own = { ...f.scope.work, productId: "product", completedStages: [] };
      const api = { ...f.scope.work, productId: "api", completedStages: [] };
      // A choice narrowed to one product keeps a one-entry list; a product removed from the task no longer takes part.
      expect(await warned([own])).toEqual([false]);
      expect(await warned([own, { ...api, removed: true }])).toEqual([false]);
      // Several products: every product's Builder is warned some points may concern another one.
      expect(await warned([own, api])).toEqual([true, true]);
    } finally { await f.close(); }
  });
});

describe.concurrent("final design-review notes for builders",()=>{it("decides by role kind: custom reviewers name themselves, building roles get the notes and nothing else changes for others", async () => {
    const f = await fixture();
    try {
      // Adding a role rebuilds the role list, so the coordinator's building role comes first.
      const made = f.engine.addRole({ ...draftOf(MAINTENANCE_ROLES.find((role) => role.result === "build")!), name: "Repository caretaker" });
      f.engine.s.roles.push({ ...f.engine.role("design-reviewer")!, id: "greeting-critic", name: "Greeting critic" });
      f.task.plan!.stages[0]!.reviewerRoleId = "greeting-critic";
      f.records(revisedObjections, revisedJourney.map((step) => step.roleId === "design-reviewer" ? { ...step, roleId: "greeting-critic" } : step));
      const builder = await f.notesFor();
      expect(builder).toHaveLength(1);
      expect(builder[0]!.body).toStartWith("From “Agree on the greeting”, round 3, by Greeting critic:");
      // A building role the coordinator made, and one saved with the task only.
      expect(await f.notesFor(made)).toEqual(builder);
      f.task.maintenance = { routineId: "daily", routineName: "Daily", scheduledAt: 1, queuedAt: 1, zone: "UTC", focus: "Greeting", role: { ...MAINTENANCE_ROLES.find((role) => role.result === "build")!, id: "saved-caretaker", name: "Saved caretaker" }, profile: f.engine.profile("opus-high")!, input: "Routine input", product: f.engine.s.products[0]! };
      expect(f.engine.s.roles.some((role) => role.id === "saved-caretaker")).toBe(false);
      expect(await f.notesFor("saved-caretaker")).toEqual(builder);
      delete f.task.maintenance;
      // Every other kind, and blind review input, is exactly what it would be without notes.
      const others = f.engine.s.roles.filter((role) => role.result !== "build");
      expect(others.map((role) => role.id)).toEqual(expect.arrayContaining(["architect", "greeting-critic", "design-reviewer", "code-reviewer", "tester", "researcher", "verifier"]));
      const saved = f.task.journey;
      const read = async () => ({ review: await f.engine["context"].captureReview(f.scope), roles: await Promise.all(others.map((role) => f.sections(role.id))) });
      const withNotes = await read();
      f.task.journey = undefined;
      const without = await read();
      f.task.journey = saved;
      expect(withNotes).toEqual(without);
      expect(JSON.stringify(withNotes)).not.toContain(NOTES);
    } finally { await f.close(); }
  });
});
it("keeps the design call in the coordinator context after stale advice is omitted", async () => { const f=await fixture(); try { f.records(beforeRevision, revisedJourney.slice(0,6)); f.engine.remember(f.task,CALL,"call-note","disagreement"); expect((await f.sections()).find((section)=>section.title.startsWith("The coordinator's notes"))!.body).toContain(CALL); } finally { await f.close(); } });
