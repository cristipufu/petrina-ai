import {describe,expect,it} from "vitest";
import {finalDesignNotes}from"../../../src/design-notes.js";
import type{JourneyStep,Objection}from"../../../src/model.js";
import{stateFixture,taskFixture}from"../../fixtures/state.js";

const CALL = "Keep the greeting in English only.";

const point = (id: string, round: number, text: string, status: Objection["status"], extra: Partial<Objection> = {}): Objection => ({ id, round, text, blocking: false, raisedBy: "sol-high", status, ...extra });
/** A design step as the journey saves it: a review keeps what it raised as it handed it back, still open; an author what it answered. */
const designStep = (id: string, roleId: string, round: number, sub: number, recorded?: readonly Objection[], extra: Partial<JourneyStep> = {}): JourneyStep => ({
  id, kind: "agent", stageId: "design", round, sub, roleId, startedAt: round * 10 + sub, endedAt: round * 10 + sub + 1, end: "done",
  ...(recorded ? { result: { objections: recorded.map((entry) => sub ? { id: entry.id, round: entry.round, text: entry.text, blocking: entry.blocking, raisedBy: entry.raisedBy, status: "open" as const } : entry) } } : {}), ...extra,
});
const designCheck = (id: string, round: number): JourneyStep => ({ id, kind: "you", stageId: "check", round, sub: 0, waitsFor: "design", startedAt: round * 10 + 5, endedAt: round * 10 + 6, end: "done" });

// Round 1 raised a blocker and a point the Architect answered; round 2 settled with a point noted; the coordinator
// asked for changes at the check; the Architect revised in round 3, and that review settled with two other points.
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
const blocker = point("o6", 3, "Block: name the greeting.", "open", { blocking: true });
const perLanguage = point("o7", 3, "Consider a greeting per language.", "open");

describe.concurrent("final design-review notes for builders",()=>{it("leaves out stale, answered, blocking, sided and called-off points, and anything the records cannot place", async () => {
    const state=stateFixture(); const task=taskFixture(state,{plan: {rationale:"Design then build",plannerProfileId:"opus-high",stages:[{id:"design",kind:"converge",title:"Agree on the greeting",roleId:"architect",profileIds:["opus-high"],reviewerRoleId:"design-reviewer",reviewerProfileIds:["sol-high"],maxRounds:3}]}});
    const f={records(objections: readonly Objection[],journey:readonly JourneyStep[]) {task.objections=JSON.parse(JSON.stringify(objections)) as typeof task.objections;task.journey=JSON.parse(JSON.stringify(journey)) as typeof task.journey;},notesFor:()=>finalDesignNotes(task,state.roles)};
      const cases: [string, readonly Objection[], readonly JourneyStep[]][] = [
        // Changes asked at the check: the Architect is revising and no review has settled since.
        ["revision not reviewed yet", beforeRevision, revisedJourney.slice(0, 6)],
        // The later review raised nothing.
        ["later review raised nothing", beforeRevision, [...revisedJourney.slice(0, 6), designStep("j7", "design-reviewer", 3, 1, [])]],
        // The coordinator sided with the Architect: that review did not settle, and its points were rejected for them.
        ["coordinator sided with the Architect", [...beforeRevision, { ...blocker, status: "rejected", decidedBy: "coordinator" }, { ...perLanguage, status: "rejected", decidedBy: "coordinator" }],
          [...revisedJourney.slice(0, 6), designStep("j7", "design-reviewer", 3, 1, [blocker, perLanguage]), { id: "j8", kind: "you", stageId: "design", round: 3, sub: 1, waitsFor: "call", startedAt: 40, endedAt: 41, end: "done" }]],
        // A design call: the Architect followed it last, so the point still noted from round 2 is out of date too.
        ["design call", [...beforeRevision, { ...blocker, status: "accepted", call: CALL, answer: "As the call says." }, { ...perLanguage, status: "rejected", call: CALL, answer: "As the call says." }],
          [...revisedJourney.slice(0, 6), designStep("j7", "design-reviewer", 3, 1, [blocker, perLanguage]), designStep("j8", "architect", 3, 0, undefined, { call: true })]],
        // Older records: no journey, or a review step without its handed-back objections.
        ["no journey", [stale], []],
        ["review without a recorded result", [stale], [designStep("j1", "architect", 2, 0), designStep("j2", "design-reviewer", 2, 1)]],
        // The statuses and rounds must agree with that review: points it raised but that were answered, or another round's.
        ["noted only in another round", [point("o8", 1, "Old round tip.", "noted")], [designStep("j1", "architect", 2, 0), designStep("j2", "design-reviewer", 2, 1, [point("o8", 1, "Old round tip.", "noted")])]],
      ];
      for (const [name, objections, journey] of cases) {
        f.records(objections, journey);
        expect({ name, notes: await f.notesFor() }).toEqual({ name, notes: [] });
      }
  });
});
