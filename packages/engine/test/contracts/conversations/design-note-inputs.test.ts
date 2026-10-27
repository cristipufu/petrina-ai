import { engineCaseFixtures, type EngineCaseOwner } from "../../fixtures/engine-cases.js";
import { mkdtempSync } from "node:fs";
import { afterAll as closeOwnedCases } from "bun:test";
import { executionFor } from "@petrina/orchestrator";
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type ConversationNote, type JourneyStep, type Objection } from "@petrina/core";
import { BuildResult } from "../../../src/roles.js";
import { Fakes, git, makeProduct } from "../../fixtures.js";
const cases = engineCaseFixtures();
closeOwnedCases(() => cases.close());


const NOTES = "Final design-review notes (advice only)";

const point = (id: string, round: number, text: string, status: Objection["status"], extra: Partial<Objection> = {}): Objection => ({ id, round, text, blocking: false, raisedBy: "sol-high", status, ...extra });

const designStep = (id: string, roleId: string, round: number, sub: number, recorded?: readonly Objection[], extra: Partial<JourneyStep> = {}): JourneyStep => ({
  id, kind: "agent", stageId: "design", round, sub, roleId, startedAt: round * 10 + sub, endedAt: round * 10 + sub + 1, end: "done",
  ...(recorded ? { result: { objections: recorded.map((entry) => sub ? { id: entry.id, round: entry.round, text: entry.text, blocking: entry.blocking, raisedBy: entry.raisedBy, status: "open" as const } : entry) } } : {}), ...extra,
});

const designCheck = (id: string, round: number): JourneyStep => ({ id, kind: "you", stageId: "check", round, sub: 0, waitsFor: "design", startedAt: round * 10 + 5, endedAt: round * 10 + 6, end: "done" });

async function fixture(owner: EngineCaseOwner) {
  const root = mkdtempSync(join(owner.root, "petrina-design-notes-"));
  const repo = await makeProduct(root);
  const fakes = new Fakes(join(root, "fake"));
  fakes.scenario({ builder: "plain", reopen: "resume" });
  const engine = owner.open(join(root, "data"), {
    agentCommand: () => [process.execPath, join(import.meta.dir, "../../fake-agent.ts"), fakes.dir],
    toolPath: () => process.execPath, usageCommands: { codex: null, grok: null, antigravity: null },
  });
  engine.schedule = () => {};
  engine.setPoolPaused(true);
  await engine.checkTools();
  engine.s.pool.paused = false;
  engine.s.products.push({ id: "product", name: "Product", repo: "local/product", path: repo, defaultBranch: "main", tone: "blue" });
  const task = engine.task(engine.addTask({ productId: "product", title: "Add a greeting", description: "A greeting file.", backlog: true }))!;
  const scope = executionFor(task);
  Object.assign(scope.work, { worktree: repo, branch: "main", base: "main", baseSha: await git(repo, "rev-parse", "HEAD") });
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
  const close = async () => { await owner.stop(engine);  };
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

describe.concurrent("final design-review notes for builders",()=>{it("sends the notes to a fresh Builder, leaves an unchanged copy out of a continued conversation and resends changed notes", async () => {
    return cases.use("petrina-engine-case-", async owner => {
      const f = await fixture(owner);
      try {
        await owner.run(f.engine, async () => {
          f.records(revisedObjections, revisedJourney);
          const turn = async (resume?: ConversationNote) => {
            let completed!: ConversationNote;
            await f.engine["turns"].turn(f.scope, "builder", "opus-high", () => f.sections(), BuildResult, new AbortController().signal, { resume, completed: (note) => { completed = structuredClone(note); } });
            delete f.scope.work.conversation;
            return completed;
          };
          const first = await turn();
          const fresh = f.inputs()[0]!;
          const section = fresh.sections.find((entry) => entry.title === NOTES)!;
          expect(fresh.mode).toBe("fresh");
          expect(fresh.sections.map((entry) => entry.title).indexOf(NOTES)).toBe(fresh.sections.map((entry) => entry.title).indexOf("Design brief") + 1);
          expect(fresh.manifest).toContainEqual(expect.objectContaining({ name: NOTES, kind: "text", size: section.body.length }));
          expect(readFileSync(fresh.exact!.file, "utf8")).toContain(`## ${NOTES}\n${section.body}`);
          expect(readFileSync(fresh.exact!.file, "utf8")).toBe(f.fakes.received("builder")[0]!.text);

          // A fix round in the same conversation: the unchanged notes stay in the saved full context only.
          f.task.fixing = true;
          const second = await turn(first);
          const continued = f.inputs()[1]!;
          expect(continued.mode).toBe("continued");
          expect(f.fakes.received("builder")[1]!.session).toBe(first.sessionId);
          expect(f.fakes.received("builder")[1]!.text).not.toContain(tip.text);
          expect(continued.sections.some((entry) => entry.title === NOTES)).toBe(false);
          expect(continued.manifest).toContainEqual(expect.objectContaining({ name: NOTES, kind: "omitted", size: 0 }));
          expect(readFileSync(second.context!.file, "utf8")).toContain(`## ${NOTES}\n${section.body}`);

          // A later revision and review settled with a different point: it goes out again, in full.
          const newer = point("o9", 4, "The locked browser installer runs from the engine package.", "noted");
          f.records([...revisedObjections, newer], [...f.task.journey!, designCheck("j8", 3), designStep("j9", "architect", 4, 0), designStep("j10", "design-reviewer", 4, 1, [newer])]);
          const third = await turn(second);
          const changed = f.inputs()[2]!.sections.find((entry) => entry.title === NOTES)!;
          expect(changed.body).toStartWith("From “Agree on the greeting”, round 4, by Design reviewer:");
          expect(changed.body).toContain(newer.text);
          expect(changed.body).not.toContain(tip.text);
          expect(f.fakes.received("builder")[2]!.text).toContain(`## ${NOTES}\n${changed.body}`);

          // A fresh conversation gets the full section again.
          await turn();
          const restarted = f.inputs()[3]!;
          expect(restarted.mode).toBe("fresh");
          expect(f.fakes.received("builder")[3]!.session).not.toBe(third.sessionId);
          expect(restarted.sections.find((entry) => entry.title === NOTES)).toEqual(changed);

        });
      } finally { await f.close(); }

    });
  });
});
