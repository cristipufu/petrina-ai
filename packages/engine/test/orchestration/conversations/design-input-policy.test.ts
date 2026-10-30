import { expect, it } from "bun:test";
import { designInputPolicy } from "../../fixtures/design-input-policy.js";

for (const side of ["author", "reviewer"] as const) it(`keeps the healthy ${side} stand-in after the planned tool recovers`, async () => {
  const f = designInputPolicy(side);
  try {
    await f.first();
    const roleId = side === "author" ? "architect" : "design-reviewer";
    const first = f.input.agents.received().find(prompt => prompt.roleId === roleId)!;
    f.state.pool.limited = [];
    const task = await f.second();
    const input = task.journey!.find(step => step.round === 2 && step.roleId === roleId)!.agentInputs![0]!;
    expect(input.mode).toBe("continued");
    expect(input.requestedProfileId).toBe(side === "author" ? "opus-xhigh" : "sol-xhigh");
    expect(input.profileId).toBe(side === "author" ? "sol-xhigh" : "grok-xhigh");
    expect(input.taskDescription).toBeUndefined();
    expect(input.selectionReason).toContain("while the planned"); expect(input.selectionReason).toContain("is available");
    expect(f.input.starts.filter(entry => entry.sessionId === first.sessionId).map(entry => entry.reopen ? "resume" : "new")).toEqual(["new", "resume"]);
    const prompt = f.input.agents.received().filter(prompt => prompt.roleId === roleId).at(-1)!.text;
    expect(prompt).not.toContain("ORIGINAL-DESIGN-REQUEST");
    const author = task.journey!.find(step => step.round === 2 && step.roleId === "architect")!.agentInputs![0]!;
    const reviewer = task.journey!.find(step => step.round === 2 && step.roleId === "design-reviewer")!.agentInputs![0]!;
    expect(f.profile(author.profileId)!.toolId).not.toBe(f.profile(reviewer.profileId)!.toolId);
  } finally { await f.close(); }
});

for (const side of ["author", "reviewer"] as const) it(`records the usual near-limit policy for the ${side} stand-in after the planned tool recovers`, async () => {
  const f = designInputPolicy(side);
  try {
    await f.first();
    const roleId = side === "author" ? "architect" : "design-reviewer";
    const earlier = f.input.agents.received().filter(prompt => prompt.roleId === roleId), first = earlier[0]!;
    const firstInput = f.task.journey!.find(step => step.round === 1 && step.roleId === roleId)!.agentInputs![0]!;
    const previous = f.profile(firstInput.profileId)!;
    f.state.pool.limited = [];
    f.state.pool.usage = [{ toolId: previous.toolId, kind: "seven_day", utilization: 0.9, status: "allowed", at: f.now(), resetsAt: f.now() + 3_600_000 }];
    const task = await f.second();
    const input = task.journey!.find(step => step.round === 2 && step.roleId === roleId)!.agentInputs![0]!;
    expect(input.requestedProfileId).toBe(side === "author" ? "opus-xhigh" : "sol-xhigh");
    const prompt = f.input.agents.received().filter(prompt => prompt.roleId === roleId)[earlier.length]!;
    if (side === "author") {
      expect(input.mode).toBe("fresh"); expect(input.profileId).toBe("opus-xhigh");
      expect(input.taskDescription).toContain("ORIGINAL-DESIGN-REQUEST");
      expect(input.selectionReason).toContain("The saved profile is near a usage limit; selected another tool at the same effort with room available.");
      expect(input.selectionReason).not.toContain("independence");
      expect(prompt.sessionId).not.toBe(first.sessionId); expect(prompt.text).toContain("ORIGINAL-DESIGN-REQUEST");
      expect(f.input.starts.filter(entry => entry.sessionId === first.sessionId).map(entry => entry.reopen ? "resume" : "new")).toEqual(["new"]);
    } else {
      expect(input.mode).toBe("continued"); expect(input.profileId).toBe(previous.id); expect(input.taskDescription).toBeUndefined();
      expect(input.selectionReason).toContain("while the planned");
      expect(prompt.sessionId).toBe(first.sessionId); expect(prompt.text).not.toContain("ORIGINAL-DESIGN-REQUEST");
      expect(f.input.starts.filter(entry => entry.sessionId === first.sessionId).map(entry => entry.reopen ? "resume" : "new")).toEqual(["new", "resume"]);
    }
    expect(f.input.statuses.some(entry => entry.roleId === roleId && entry.text === input.selectionReason)).toBe(true);
  } finally { await f.close(); }
});

it("drops the saved reviewer stand-in when the new author now uses its tool", async () => {
  const f = designInputPolicy("reviewer");
  try {
    await f.first(); f.state.pool.limited = []; f.stage.profileIds[0] = "grok-xhigh";
    const task = await f.second();
    const input = task.journey!.find(step => step.round === 2 && step.roleId === "design-reviewer")!.agentInputs![0]!;
    expect(input.mode).toBe("fresh"); expect(input.profileId).toBe("sol-xhigh");
    expect(input.taskDescription).toContain("ORIGINAL-DESIGN-REQUEST");
    expect(input.selectionReason).toContain("Selected a more independent tool or model for this review.");
  } finally { await f.close(); }
});

it("records a rejected design continuation's known reason while the unaffected participant continues", async () => {
  const f = designInputPolicy(undefined, false, true);
  try {
    const held = await f.firstHeld(); f.task.description += " A changed recorded request.";
    f.releaseReviewer(); await held.operation;
    const task = await f.second();
    const author = task.journey!.find(step => step.roleId === "architect" && step.round === 2)!.agentInputs![0]!;
    expect(author).toMatchObject({ mode: "fresh", freshReason: "its role, profile, request or starting point changed" });
    const reviewer = task.journey!.find(step => step.roleId === "design-reviewer" && step.round === 2)!.agentInputs![0]!;
    expect(reviewer.mode).toBe("continued"); expect(reviewer.freshReason).toBeUndefined();
  } finally { await f.close(); }
});

it("keeps the actual replacement reviewer's own conversation in the next round", async () => {
  const f = designInputPolicy(undefined, true);
  try {
    await f.first(); const task = await f.second();
    const reviewer = Object.values(task.designSessions!).find(entry => entry.plannedProfileId === "sol-xhigh")!;
    expect(reviewer.toolId).toBe("grok");
    expect(f.input.starts.filter(entry => entry.sessionId === reviewer.sessionId).map(entry => entry.reopen ? "resume" : "new")).toEqual(["new", "resume"]);
    const second = task.journey!.find(step => step.roleId === "design-reviewer" && step.round === 2)!;
    expect(second.agentInputs!.find(entry => entry.profileId === reviewer.profileId)!.mode).toBe("continued");
  } finally { await f.close(); }
});
