import { expect, it } from "bun:test";
import { reviewerInputPolicy } from "../../fixtures/reviewer-input-policy.js";

for (const kind of ["single", "parallel", "security", "added"] as const) it(`keeps the ${kind} seats' own conversations when planned profiles recover`, async () => {
  const pair = kind === "parallel", f = reviewerInputPolicy(pair, kind === "security" ? "security-reviewer" : kind === "added" ? "added" : "code-reviewer");
  try {
    const saved = await f.first();
    expect(Object.values(saved).every(seat => seat.profileId !== seat.plannedProfileId)).toBe(true);
    const booked = f.choose();
    expect(booked?.kind === "none" ? undefined : booked?.profile.toolId).toBe(saved["0"]!.toolId);
    const inputs = await f.round(2);
    expect(inputs).toHaveLength(pair ? 2 : 1);
    for (const input of inputs) {
      const prior = saved[input.reviewerKey!]!;
      expect(input.mode).toBe("continued");
      expect(input.profileId).toBe(prior.profileId);
      expect(input.requestedProfileId).toBe(prior.plannedProfileId);
      expect(input.taskDescription).toBeUndefined();
      expect(input.selectionReason).toContain("while the planned");
      expect(input.selectionReason).toContain("is available");
      expect(input.sections.some(section => section.title === "Design brief")).toBe(false);
      expect(JSON.stringify(input.sections)).toContain("CHANGED-BUILDER-REPORT");
      const prompts = f.world.agents.received().filter(entry => entry.sessionId === prior.sessionId);
      expect(prompts).toHaveLength(2);
      expect(prompts[1]!.text).not.toContain("ORIGINAL-SEAT-REQUEST");
      expect(f.world.starts.filter(entry => entry.sessionId === prior.sessionId).map(entry => entry.reopen ? "resume" : "new")).toEqual(["new", "resume"]);
    }
    expect(f.world.starts).toHaveLength(pair ? 4 : 2);
    expect(new Set(inputs.map(input => f.profile(input.profileId)!.toolId)).size).toBe(inputs.length);
    expect(f.world.statuses.some(entry => entry.text.includes("Kept its own conversation"))).toBe(true);
  } finally { await f.close(); }
});

for (const pair of [false, true]) it(`records the attempted ${pair ? "parallel" : "single"} seat when its fresh tool cannot start`, async () => {
  const f = reviewerInputPolicy(pair);
  try {
    const failure = Object.assign(new Error("The supplied external session could not start"), { toolId: "claude-code", status: "wont-start" });
    f.world.failures.set("opus-high", failure);
    expect(await f.roundFailure(1)).toMatchObject({ toolId: "claude-code", status: "wont-start" });
    // This is the actual one announcement effect used by native log + joined-message recording.
    expect(f.world.announcements.filter(entry => entry.roleId === f.stage.roleId && entry.profileId === "opus-high")).toHaveLength(1);
    expect(f.task.journey!.flatMap(step => step.agentInputs ?? []).filter(input => input.profileId === "opus-high")).toHaveLength(0);
  } finally { await f.close(); }
});

for (const pair of [false, true]) it(`announces each ${pair ? "parallel" : "single"} seat only once when a failed reopen selects the same planned profile`, async () => {
  const f = reviewerInputPolicy(pair);
  try {
    await f.round(1);
    const saved = structuredClone(f.task.reviewSessions![f.stage.id]!);
    for (const seat of Object.values(saved)) f.world.missingSessions.add(seat.sessionId);
    const note = { id: "current-revision", at: 1, text: "CURRENT-REVISION-NOTE" };
    f.task.notes = [note]; f.task.stepNotes = [{ ...note, kind: "changes" }];
    const inputs = await f.round(2);
    expect(inputs).toHaveLength(pair ? 2 : 1);
    for (const input of inputs) {
      const prior = saved[input.reviewerKey!]!;
      expect(input.mode).toBe("fresh");
      expect(input.profileId).toBe(prior.profileId);
      expect(input.selectionReason).toContain("could not reopen");
      expect(input.taskDescription).toBe("ORIGINAL-SEAT-REQUEST");
      expect(input.sections.find(section => section.title.startsWith("The coordinator's notes"))?.body).toContain(note.text);
      expect(input.sections.some(section => section.title === "What the coordinator said in an earlier attempt at this step")).toBe(false);
      expect(f.world.agents.received().filter(entry => entry.sessionId === prior.sessionId)).toHaveLength(1);
      expect(f.world.announcements.filter(entry => entry.roleId === f.stage.roleId && entry.profileId === prior.profileId)).toHaveLength(2);
    }
  } finally { await f.close(); }
});

for (const changed of ["assignment", "starting point", "context", "native"] as const) it(`starts fresh with the recorded reason after ${changed} changes`, async () => {
  const f = reviewerInputPolicy();
  try {
    const saved = (await f.first())["0"]!;
    let reason: string = changed;
    if (changed === "assignment") { f.stage.profileIds[0] = "grok-high"; reason = "you changed who works"; }
    else if (changed === "starting point") { f.replaceBase(); reason = "starting branch's history was replaced or diverged"; }
    else if (changed === "context") { f.world.packets.delete(saved.context!.file); reason = "saved context is unavailable"; }
    else { f.world.missingSessions.add(saved.sessionId); reason = "could not reopen"; }
    const input = (await f.round(2)).find(entry => entry.reviewerKey === "0")!;
    expect(input.mode).toBe("fresh");
    expect(input.taskDescription).toContain("ORIGINAL-SEAT-REQUEST");
    expect(input.selectionReason).toContain(reason);
    expect(input.sections.some(section => section.title === "Design brief")).toBe(true);
    expect([...f.world.statuses.map(entry => entry.text), ...f.reasons].some(text => text.includes(reason))).toBe(true);
    const current = f.task.reviewSessions![f.stage.id]!["0"]!;
    const prompts = f.world.agents.received().filter(entry => entry.sessionId === current.sessionId);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]!.text).toContain("ORIGINAL-SEAT-REQUEST");
    expect(prompts[0]!.text).toContain("UNCHANGED-BRIEF");
    if (["context", "native", "starting point"].includes(changed)) {
      expect(input.profileId).toBe("opus-high");
      expect(f.world.agents.received().filter(entry => entry.sessionId === saved.sessionId)).toHaveLength(1);
    }
    if (changed === "native") {
      expect(f.world.announcements.filter(entry => entry.roleId === f.stage.roleId && entry.profileId === saved.profileId)).toHaveLength(1);
      expect(f.world.announcements.filter(entry => entry.roleId === f.stage.roleId && entry.profileId === input.profileId)).toHaveLength(1);
    }
  } finally { await f.close(); }
});

it("checks the new tool's cap after a parallel reopen fails, and retains the reason through the wait", async () => {
  const f = reviewerInputPolicy(true);
  try {
    const saved = (await f.first())["0"]!;
    f.world.missingSessions.add(saved.sessionId); f.state.pool.toolCaps["claude-code"] = 0;
    const firstPrompts = f.world.agents.received().length;
    expect(String(await f.roundFailure(2))).toContain("Waiting for a free");
    expect(f.task.reviewSessions![f.stage.id]!["0"]!.freshReason).toContain("could not reopen");
    expect(f.task.journey!.at(-1)!.agentInputs!.some(input => input.reviewerKey === "0")).toBe(false);
    expect(f.world.agents.received().length).toBe(firstPrompts + 1);
    f.state.pool.toolCaps["claude-code"] = 1;
    const input = await f.seat("0");
    expect(input.mode).toBe("fresh"); expect(input.profileId).toBe("opus-high");
    expect(input.selectionReason).toContain("could not reopen"); expect(input.taskDescription).toContain("ORIGINAL-SEAT-REQUEST");
  } finally { await f.close(); }
});

it("retains reviewer policy near a limit and gives voters no saved-seat preference", async () => {
  const f = reviewerInputPolicy();
  try {
    const saved = (await f.first())["0"]!;
    f.state.pool.usage = [{ toolId: saved.toolId, kind: "seven_day", utilization: 0.9, status: "allowed", at: f.now(), resetsAt: f.now() + 3_600_000 }];
    expect(f.choose()).toEqual(expect.objectContaining({ profile: expect.objectContaining({ id: saved.profileId }) }));
    expect(f.selection.choose("opus-high", f.scope, "verifier")).toEqual(expect.objectContaining({ profile: expect.objectContaining({ id: "opus-high" }) }));
    expect((await f.round(2))[0]!.mode).toBe("continued");
  } finally { await f.close(); }
});

it("starts the affected seats fresh after native session changes while main advances", async () => {
  const f = reviewerInputPolicy(true);
  try {
    f.task.description = "ORIGINAL-REVIEW-REQUEST";
    await f.round(1);
    f.advanceMain();
    const prior = f.task.reviewSessions![f.stage.id]!["0"]!;
    f.world.missingSessions.add(prior.sessionId);
    const inputs = await f.round(2);
    expect(inputs.find((input) => input.reviewerKey === "0")!.mode).toBe("fresh");
    expect(inputs.find((input) => input.reviewerKey === "1")!.mode).toBe("continued");
    expect(inputs.find((input) => input.mode === "fresh")!.taskDescription).toContain("ORIGINAL-REVIEW-REQUEST");
    expect(inputs.find((input) => input.mode === "fresh")!.sections.some((section) => section.title === "Design brief")).toBe(true);
    expect(inputs.filter((input) => input.mode === "fresh").every((input) => !input.sections.some((section) => section.title === "The review base advanced since your last review"))).toBe(true);
    expect(inputs.find((input) => input.reviewerKey === "1")!.sections.some((section) => section.title === "The review base advanced since your last review")).toBe(true);
    expect(f.world.statuses.some((entry) => entry.text.includes("Could not go back to its own review conversation"))).toBe(true);
    for (const input of inputs) {
      if (input.mode === "continued") expect(input.freshReason).toBeUndefined();
      else expect(input.freshReason).toContain("could not reopen the conversation");
    }
  } finally { await f.close(); }
});
