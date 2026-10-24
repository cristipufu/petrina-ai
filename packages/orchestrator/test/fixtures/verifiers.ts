import { BUILT_IN_ROLES, createTaskState, roleForTask, type Finding, type Stage, type VerifierSeat, type Vote } from "@petrina/core";
import { VerifierBallots, type RuntimeTask, type VerifierCatalog, type VerifierRecording, type VerifierResolution, type VerifierSelection } from "../../src/index.js";

export function verifierFixture() {
  const task: RuntimeTask = createTaskState({ productId: "product", title: "Review the greeting", backlog: true },
    [{ id: "product", name: "Product", repo: "local/product", tone: "blue" }], { id: "task", timelineId: "created", now: 100, priority: 0 });
  task.repository = { productId: "product", delivery: "local" };
  const stage = { id: "review", title: "Review", kind: "review-chain", roleId: "code-reviewer", profileIds: ["a-high", "b-high"], maxRounds: 2 } satisfies Stage;
  const build = { id: "build", title: "Build", kind: "do", roleId: "builder", profileIds: ["a-high"] } satisfies Stage;
  task.plan = { rationale: "Focused ballot", plannerProfileId: "a-high", stages: [build, stage] }; task.stageIndex = 1;
  task.hunt = { stageId: stage.id, round: 1, reported: {}, input: { file: "input.json", digest: "snapshot", heads: { product: "head" } } };
  const profiles = new Map(["a", "b", "c", "d"].map(toolId => [`${toolId}-high`, { id: `${toolId}-high`, toolId }]));
  const candidates = [...profiles.keys()];
  const resolutions = new Map<string, VerifierResolution | undefined>([...profiles].map(([id, profile]) => [id, { kind: "selected", profile }]));
  const checkpoints: RuntimeTask[] = [], changes: RuntimeTask[] = [], notes: { tone: string; text: string }[] = [];
  const roles = [...BUILT_IN_ROLES];
  let closed = false, now = 200;
  const catalog: VerifierCatalog = { profile: id => profiles.get(id), profileName: id => id, toolName: id => `Tool ${id}`,
    roleResult: (id, task) => roleForTask(roles, id, task)?.result };
  const selection: VerifierSelection = { candidates: () => [...candidates], resolve: (_task, id) => {
    if (!resolutions.has(id)) throw new Error(`Unexpected profile selection: ${id}`);
    return resolutions.get(id);
  }, admissionsClosed: () => closed };
  const recording: VerifierRecording = { checkpoint: current => { checkpoints.push(structuredClone(current)); },
    changed: current => { changes.push(structuredClone(current)); },
    note: (_task, tone, text) => { notes.push({ tone, text }); }, now: () => now };
  const ballots = new VerifierBallots(catalog, selection, recording);
  function finding(id = "finding", raisedBy = "a-high"): Finding {
    const value = { id, text: `The ${id} greeting is missing.`, severity: "blocking" as const, raisedBy, confirmedBy: [], status: "open" as const };
    task.findings.push(value);
    return value;
  }
  function answer(seat: VerifierSeat, verdict: Vote["verdict"], id = "finding"): void {
    const finding = task.findings.find(finding => finding.id === id);
    if (!finding) throw new Error(`Unknown finding: ${id}`);
    ballots.recordAnswers(task, { place: seat, profileId: seat.profileId, plannedProfileId: seat.profileId, findingIds: seat.findingIds },
      [{ id, verdict, reason: `Tool ${seat.toolId} checked ${id}.` }]);
  }
  return { task, stage, profiles, roles, candidates, resolutions, checkpoints, changes, notes, catalog, selection, recording, ballots, finding, answer,
    next: () => ballots.next(task, stage), closeAdmissions: () => { closed = true; }, openAdmissions: () => { closed = false; }, advance: () => { now++; } };
}
