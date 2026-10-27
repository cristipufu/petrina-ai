import { engineCaseFixtures, type EngineCaseOwner } from "../../fixtures/engine-cases.js";
import { afterAll } from "bun:test";
import { completeAll } from "@petrina/core";
import { nativeCoordinatorTask } from "../../fixtures/coordinator-native.js";
import { expect, it } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ConversationNote } from "@petrina/core";
import { BuildResult, ReviewResult } from "../../../src/roles.js";
import { routeMessages } from "@petrina/core";
import { MESSAGE_RECOVERY_OPTIONS } from "../../../src/messages.js";
import { EARLIER_ATTEMPT } from "../../../src/prompts.js";
import { makeProduct, waitFor } from "../../fixtures.js";
const cases = engineCaseFixtures();
afterAll(() => cases.close());


async function prepareFixture(owner: EngineCaseOwner) {
  return nativeCoordinatorTask(owner, async ({ root, fakes, engine, task, scope, dispose: close }) => {
  try {
    task.plan = { rationale: "Build only", plannerProfileId: "sol-high", stages: [{ id: "build", title: "Build", kind: "do", roleId: "builder", profileIds: ["sol-high"] }] };
    task.stageIndex = 0; task.state = "running"; task.holdsSlot = true;
    task.brief = { summary: "UNCHANGED-BACKGROUND", forUsers: [], areas: [], acceptance: [], risks: [] };
    const controllers: AbortController[] = [];
    const pending: Promise<unknown>[] = [];
    owner.onStop(async () => { await completeAll([...controllers.map(async controller => { controller.abort(); }), Promise.allSettled(pending).then(() => undefined)]); });
    const start = (resume?: ConversationNote, given = () => engine["context"].sectionsFor(scope, "builder")) => {
      owner.check();
      const controller = new AbortController(); controllers.push(controller);
      task.state = "running"; task.holdsSlot = true;
      task.agent = { roleId: "builder", profileId: "sol-high", since: Date.now(), step: 0 };
      const result = engine["turns"].turn(scope, "builder", "sol-high", given, BuildResult, controller.signal, { ...(resume ? { resume } : {}) });
      pending.push(result); result.catch(() => {});
      return result;
    };
    const first = async () => {
      engine.sendMessage(task.id, "ALREADY-HEARD", "queue");
      const receipt = task.queued[0]!;
      const running = start();
      const prompt = await waitFor(() => fakes.received("builder")[0], "the first opening", undefined, { during: running });
      writeFileSync(join(fakes.dir, `release-${prompt.session}`), "go");
      await running;
      expect(receipt.deliveries?.main?.state).toBe("applied");
      expect(task.queued).toEqual([]);
      return structuredClone(scope.work.conversation!);
    };
    const dispose = async () => {
      controllers.forEach(controller => controller.abort());
      await Promise.allSettled(pending);
      await close();
    };
    return { engine, task, scope, fakes, start, first, dispose, root, controllers, pending };
  } catch (error) { await close(); throw error; }

  }, "Keep queued instructions", { builder: "plain", reopen: "resume", controlled: true });
}

function fixture<T>(owner: EngineCaseOwner, body: (value: Awaited<ReturnType<typeof prepareFixture>>) => Promise<T>): Promise<T> {
  return owner.prepare(async () => { const fixture = await prepareFixture(owner); owner.check(); return body(fixture); });
}

for (const path of ["fresh start", "earlier conversation"] as const) it(`shows opening instructions in the recorded input (${path})`, async () => {
  return cases.use("petrina-queued-continuation-", owner => fixture(owner, async f => {
  try {
    const saved = path === "earlier conversation" ? await f.first() : undefined;
    if (saved) f.engine.finishStep(f.scope);
    const text = "Keep the original integrity requirement when checking the artifact.";
    f.engine.sendMessage(f.task.id, text, "queue");
    const receipt = f.task.queued[0]!;
    const next = f.start(saved);
    const opening = await waitFor(() => f.fakes.received("builder")[saved ? 1 : 0], "the opening with new guidance", undefined, { during: next });
    writeFileSync(join(f.fakes.dir, `release-${opening.session}`), "go");
    await next;
    const input = f.task.journey!.at(-1)!.agentInputs!.at(-1)!;
    expect(opening.session === saved?.sessionId).toBe(!!saved);
    expect(f.scope.work.stepAttempts).toBe(1);
    expect(opening.text.split(text)).toHaveLength(2);
    expect(readFileSync(input.exact!.file, "utf8")).toBe(opening.text);
    expect(receipt.deliveries?.main?.state).toBe("applied");
    expect(input.sections.filter(section => section.body.includes(text))).toEqual([
      { title: "Messages from the coordinator, in order", body: `1. ${text}` },
    ]);
    expect(input.sections.every(section => !!section.body)).toBe(true);
    expect(input.instructions).not.toContain(text);
    expect(input.updates ?? []).toEqual([]);
  } finally { await f.dispose(); }

  }));
});

for (const path of ["earlier conversation", "fresh fallback", "same step", "during preparation"] as const) it(`hands paused guidance to the actual prompt exactly once (${path})`, async () => {
  return cases.use("petrina-queued-continuation-", owner => fixture(owner, async f => {
  const prepared = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  owner.onStop(() => release.resolve());
  try {
    const saved = await f.first();
    if (path !== "same step") {
      f.engine.pause(f.task.id);
      expect(f.task.state).toBe("paused");
      expect(f.scope.work.conversation).toBeUndefined();
    }
    if (path === "fresh fallback") f.fakes.scenario({ builder: "plain", controlled: false });
    const texts = ["The original integrity requirement still applies.", "Check the saved artifact before finishing."];
    const ids = texts.map(text => f.engine.sendMessage(f.task.id, text, "queue")!);
    const queued = [...f.task.queued];
    if (path !== "same step") f.engine.resume(f.task.id);
    const next = f.start(path === "same step" ? undefined : saved, async () => {
      const sections = await f.engine["context"].sectionsFor(f.scope, "builder");
      if (path === "during preparation") { prepared.resolve(); await release.promise; }
      return sections;
    });
    const late = "Also preserve the latest clarification.";
    if (path === "during preparation") {
      await waitFor(() => prepared.promise.then(() => true), "the prepared context boundary", undefined, { during: next });
      expect(queued.every(message => message.deliveries?.main === undefined)).toBe(true);
      f.engine.sendMessage(f.task.id, late, "queue");
      queued.push(f.task.queued.at(-1)!);
      texts.push(late);
      release.resolve();
    }
    await next;
    const prompts = f.fakes.received("builder");
    expect(prompts).toHaveLength(2);
    const opening = prompts[1]!;
    expect(opening.session === saved.sessionId).toBe(path !== "fresh fallback");
    for (const text of texts) expect(opening.text.split(text)).toHaveLength(2);
    expect(opening.text.indexOf(texts[0]!)).toBeLessThan(opening.text.indexOf(texts[1]!));
    if (path !== "fresh fallback") {
      expect(opening.text).not.toContain("ALREADY-HEARD");
      expect(opening.text).not.toContain("UNCHANGED-BACKGROUND");
    } else expect(opening.text).toContain("UNCHANGED-BACKGROUND");
    const input = f.task.journey!.at(-1)!.agentInputs!.at(-1)!;
    expect(readFileSync(input.exact!.file, "utf8")).toBe(opening.text);
    expect(input.mode).toBe(path === "fresh fallback" ? "fresh" : "continued");
    expect(input.resumed === true).toBe(path === "same step");
    expect(input.manifest!.some(entry => entry.name === "Messages from the coordinator, in order" && entry.kind === "text")).toBe(true);
    for (const text of texts) {
      const visible = [input.instructions ?? "", ...input.sections.map(section => section.body), ...(input.updates ?? []).map(update => update.text)].join("\n");
      expect(visible.split(text)).toHaveLength(2);
    }
    expect(input.sections.every(section => !!section.body)).toBe(true);
    expect(queued.map(message => message.deliveries?.main?.state)).toEqual(texts.map(() => "applied"));
    expect(queued.every(message => message.recipients?.main && message.deliveries?.main?.sessionId === opening.session)).toBe(true);
    expect(f.task.queued).toEqual([]);
    expect(f.task.session.filter(line => ids.includes(line.coordinatorMessageId ?? ""))).toHaveLength(2);
    // A later step rebuilds context; a same-step reopen bypasses that preparation.
    f.fakes.scenario({ builder: "plain", reopen: "resume" });
    const continued = structuredClone(f.scope.work.conversation!);
    if (path !== "same step") f.engine.finishStep(f.scope);
    await f.start(path !== "same step" ? continued : undefined);
    const again = f.fakes.received("builder")[2]!.text;
    for (const text of texts) expect(again).not.toContain(text);
  } finally { release.resolve(); await f.dispose(); }

  }));
});

it("removes withdrawn guidance from the actual opening and its complete context packet", async () => {
  return cases.use("petrina-queued-continuation-", owner => fixture(owner, async f => {
  const captured = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  owner.onStop(() => release.resolve());
  try {
    const saved = await f.first();
    f.engine.pause(f.task.id);
    const text = "WITHDRAWN-INSTRUCTION";
    const id = f.engine.sendMessage(f.task.id, text, "queue")!;
    const withdrawn = f.task.queued[0]!;
    f.engine.resume(f.task.id);
    const next = f.start(saved, async () => {
      const sections = await f.engine["context"].sectionsFor(f.scope, "builder");
      expect(sections.some(section => section.background?.includes(text))).toBe(true);
      captured.resolve(); await release.promise;
      return sections;
    });
    await waitFor(() => captured.promise.then(() => true), "the captured context boundary", undefined, { during: next });
    f.engine.removeQueued(f.task.id, id);
    f.engine.sendMessage(f.task.id, "KEEP-THE-NEW-INSTRUCTION", "queue");
    release.resolve(); await next;
    const opening = f.fakes.received("builder")[1]!.text;
    expect(opening).not.toContain(text);
    expect(opening.split("KEEP-THE-NEW-INSTRUCTION")).toHaveLength(2);
    const packet = readFileSync(f.scope.work.conversation!.context!.file, "utf8");
    expect(packet).not.toContain(text);
    expect(packet).toContain("KEEP-THE-NEW-INSTRUCTION");
    expect(withdrawn.deliveries).toBeUndefined();
    expect(f.task.session.some(line => line.coordinatorMessageId === id)).toBe(false);
    expect(f.task.queued).toEqual([]);
  } finally { release.resolve(); await f.dispose(); }

  }));
});

for (const mode of ["queue", "interrupt"] as const) it(`records guidance arriving after opening reservation in the input actually sent (${mode})`, async () => {
  return cases.use("petrina-queued-continuation-", owner => fixture(owner, async f => {
  const reserved = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  owner.onStop(() => release.resolve());
  const turns = f.engine["turns"], prepare = turns["prepareTurnPrompt"].bind(turns);
  try {
    const saved = await f.first();
    f.engine.pause(f.task.id);
    f.engine.sendMessage(f.task.id, "NORMAL-RESERVED-INSTRUCTION", "queue");
    const normal = f.task.queued[0]!;
    turns["prepareTurnPrompt"] = async (...args) => {
      reserved.resolve(); await release.promise;
      return prepare(...args);
    };
    f.engine.resume(f.task.id);
    const next = f.start(saved);
    await waitFor(() => reserved.promise.then(() => true), "the reserved context boundary", undefined, { during: next });
    expect(normal.deliveries?.main).toEqual({ state: "sending", via: "prompt" });
    const text = "ARRIVED-WHILE-SAVING-THE-PACKET";
    f.engine.sendMessage(f.task.id, text, mode);
    const late = f.task.queued.find(message => message.text === text)!;
    expect(late.deliveries).toBeUndefined();
    release.resolve(); await next;
    const prompts = f.fakes.received("builder").slice(1);
    expect(prompts).toHaveLength(mode === "interrupt" ? 1 : 2);
    expect(prompts.map(prompt => prompt.text).join("\n").split(text)).toHaveLength(2);
    const input = f.task.journey!.at(-1)!.agentInputs!.at(-1)!;
    expect(readFileSync(input.exact!.file, "utf8")).toBe(prompts[0]!.text);
    if (mode === "interrupt") {
      expect(prompts[0]!.text.indexOf(text)).toBeLessThan(prompts[0]!.text.indexOf(normal.text));
      expect(input.sections.some(section => section.body.includes(text))).toBe(true);
    } else {
      expect(prompts[0]!.text).not.toContain(text);
      expect(input.sections.some(section => section.body.includes(text))).toBe(false);
      const update = input.updates!.find(update => update.reason === "message")!;
      expect(readFileSync(update.exact!.file, "utf8")).toBe(prompts[1]!.text);
      expect(update.text.split(text)).toHaveLength(2);
    }
    expect(normal.deliveries?.main?.state).toBe("applied");
    expect(late.deliveries?.main?.state).toBe("applied");
    expect(f.task.queued).toEqual([]);
  } finally { turns["prepareTurnPrompt"] = prepare; release.resolve(); await f.dispose(); }

  }));
});

for (const attempts of [0, 2]) it(`keeps broadcast receipts per seat and retains heard guidance for a fresh replacement (step attempts=${attempts})`, async () => {
  return cases.use("petrina-queued-continuation-", owner => fixture(owner, async f => {
  try {
    f.fakes.scenario({ builder: "plain", reopen: "resume" });
    const copies = [f.scope.work.worktree!, await makeProduct(join(f.root, "peer"))];
    const saved: ConversationNote[] = [];
    f.task.hunt = { stageId: "build", round: 1, reported: {}, profiles: { "0": "sol-high", "1": "astra-xhigh" } };
    const run = (seat: number, resume?: ConversationNote) => {
      owner.check();
      const member = `review-${seat}`, profile = seat ? "astra-xhigh" : "sol-high";
      const controller = new AbortController(); f.controllers.push(controller);
      const result = f.engine["turns"].parallel(f.scope, "builder", profile, copies[seat]!,
        () => f.engine["context"].sectionsFor(f.scope, "builder", member), BuildResult, controller.signal,
        { key: String(seat), member, reviewerKey: String(seat), seat: profile, reviewContext: true,
          ...(resume ? { resume } : {}), completed: note => { saved[seat] = structuredClone(note); } });
      f.pending.push(result); result.catch(() => {});
      return result;
    };
    const text = "BROADCAST-INTEGRITY-CONSTRAINT";
    f.engine.sendMessage(f.task.id, text, "queue");
    routeMessages(f.task, ["review-0", "review-1"]);
    const broadcast = f.task.queued[0]!;
    await run(0);
    const first = saved[0]!;
    expect(f.task.journey!.at(-1)!.agentInputs!.at(-1)!.sections).toContainEqual({ title: "Messages from the coordinator, in order", body: `1. ${text}` });
    expect(broadcast.recipients).toEqual({ "review-0": true, "review-1": false });
    expect(broadcast.deliveries?.["review-0"]?.state).toBe("applied");
    expect(broadcast.deliveries?.["review-1"]).toBeUndefined();
    // The step may have started more than once; a parallel opening still has no earlier-attempt section.
    if (attempts) f.scope.work.stepAttempts = attempts;
    // A warm cross-round return hears no duplicate while its peer is still waiting.
    await run(0, first);
    expect(f.fakes.received("builder")[1]!.text).not.toContain(text);
    expect(broadcast.recipients).toEqual({ "review-0": true, "review-1": false });
    // A replacement conversation still needs this product guidance as background.
    const onlyPeer = "ONLY-THE-SECOND-SEAT";
    const id = f.engine.sendMessage(f.task.id, onlyPeer, "queue")!;
    f.task.queued.find(message => message.id === id)!.recipients = { "review-1": false };
    f.fakes.scenario({ builder: "plain" });
    await run(0, first);
    const replacement = f.fakes.received("builder")[2]!;
    expect(replacement.session).not.toBe(first.sessionId);
    expect(replacement.text.split(text)).toHaveLength(2);
    expect(replacement.text).not.toContain(onlyPeer);
    expect(replacement.text).not.toContain("## Messages from the coordinator, in order");
    expect(replacement.text).not.toContain(EARLIER_ATTEMPT);
    const replaced = f.task.journey!.at(-1)!.agentInputs!.at(-1)!;
    expect(readFileSync(replaced.exact!.file, "utf8")).toBe(replacement.text);
    expect(replaced.sections.find(section => section.title.startsWith("The coordinator's notes"))?.body).toContain(text);
    // Background only: the receipt still names the conversation that heard it.
    expect(broadcast.deliveries?.["review-0"]).toEqual(expect.objectContaining({ state: "applied", sessionId: first.sessionId }));
    expect(broadcast.recipients).toEqual({ "review-0": true, "review-1": false });
    await run(1);
    const peer = f.fakes.received("builder")[3]!;
    expect(peer.text.split(text)).toHaveLength(2);
    expect(peer.text.split(onlyPeer)).toHaveLength(2);
    expect(f.task.journey!.at(-1)!.agentInputs!.at(-1)!.sections).toContainEqual({ title: "Messages from the coordinator, in order", body: `1. ${text}\n2. ${onlyPeer}` });
    expect(broadcast.recipients).toEqual({ "review-0": true, "review-1": true });
    expect(broadcast.deliveries?.["review-1"]?.state).toBe("applied");
    expect(f.task.queued).toEqual([]);
    expect(f.task.session.filter(line => line.coordinatorMessageId === broadcast.id)).toHaveLength(1);
    for (const input of f.task.journey!.at(-1)!.agentInputs!) {
      const prompt = f.fakes.received("builder").find(prompt => prompt.session === input.sessionId && prompt.text === readFileSync(input.exact!.file, "utf8"));
      expect(prompt).toBeDefined();
    }
  } finally { await f.dispose(); }

  }));
});

it("says heard guidance once when a single conversation starts the step again fresh", async () => {
  return cases.use("petrina-queued-continuation-", owner => fixture(owner, async f => {
  try {
    await f.first();
    // The step's saved conversation cannot be reopened, so its second start is a fresh one.
    f.fakes.scenario({ builder: "plain", controlled: false });
    await f.start();
    const opening = f.fakes.received("builder")[1]!;
    expect(f.scope.work.stepAttempts).toBe(2);
    expect(opening.text).toContain(`## ${EARLIER_ATTEMPT}`);
    expect(opening.text.split("ALREADY-HEARD")).toHaveLength(2);
    expect(opening.text).toContain("(earlier attempt) A message from the coordinator: ALREADY-HEARD");
    expect(opening.text).toContain("UNCHANGED-BACKGROUND");
    expect(opening.text).not.toContain("## Messages from the coordinator, in order");
    const input = f.task.journey!.at(-1)!.agentInputs!.at(-1)!;
    expect(input.mode).toBe("fresh");
    expect(readFileSync(input.exact!.file, "utf8")).toBe(opening.text);
    expect(input.sections.find(section => section.title.startsWith("The coordinator's notes"))?.body ?? "").not.toContain("ALREADY-HEARD");
  } finally { await f.dispose(); }

  }));
});

it("delivers a new instruction even when its words match an already heard instruction", async () => {
  return cases.use("petrina-queued-continuation-", owner => fixture(owner, async f => {
  try {
    const saved = await f.first();
    f.engine.pause(f.task.id);
    const id = f.engine.sendMessage(f.task.id, "ALREADY-HEARD", "queue")!;
    const receipt = f.task.queued[0]!;
    f.engine.resume(f.task.id);
    await f.start(saved);
    expect(f.fakes.received("builder")[1]!.text.split("ALREADY-HEARD")).toHaveLength(2);
    expect(receipt.id).toBe(id);
    expect(receipt.deliveries?.main?.state).toBe("applied");
    expect(f.task.queued).toEqual([]);
  } finally { await f.dispose(); }

  }));
});

for (const [peerWaiting, attempts] of [[true, 0], [false, 0], [true, 2]] as const) it(`keeps guidance after declining a resend in a fresh reviewer conversation (peer waiting=${peerWaiting}, step attempts=${attempts})`, async () => {
  return cases.use("petrina-queued-continuation-", owner => fixture(owner, async f => {
  try {
    f.fakes.scenario({ reopen: "resume" });
    f.task.plan!.stages = [{ id: "review", title: "Review", kind: "review-chain", roleId: "code-reviewer", profileIds: ["sol-high", "astra-xhigh"] }];
    f.task.hunt = { stageId: "review", round: 1, reported: {}, profiles: { "0": "sol-high", "1": "astra-xhigh" } };
    const copies = [f.scope.work.worktree!, await makeProduct(join(f.root, "peer"))];
    let saved: ConversationNote | undefined;
    const run = (seat: number, resume?: ConversationNote) => {
      owner.check();
      const member = `review-${seat}`, profile = seat ? "astra-xhigh" : "sol-high";
      const controller = new AbortController(); f.controllers.push(controller);
      const result = f.engine["turns"].parallel(f.scope, "code-reviewer", profile, copies[seat]!,
        () => f.engine["context"].sectionsFor(f.scope, "code-reviewer", member), ReviewResult, controller.signal,
        { key: String(seat), member, reviewerKey: String(seat), seat: profile, reviewContext: true,
          ...(resume ? { resume } : {}), completed: note => { if (!seat) saved = structuredClone(note); } });
      f.pending.push(result); result.catch(() => {});
      return result;
    };
    const text = "Keep the original artifact-integrity requirement.";
    const id = f.engine.sendMessage(f.task.id, text, "now")!;
    routeMessages(f.task, peerWaiting ? ["review-0", "review-1"] : ["review-0"]);
    const message = f.task.queued[0]!;
    // These are provider acknowledgements without confirmed consumption, as after a lost turn.
    message.deliveries = Object.fromEntries(Object.keys(message.recipients!).map(member => [member, { state: "accepted" as const, via: "live" as const, toolId: "grok", sessionId: `old-${member}` }]));
    if (attempts) f.scope.work.stepAttempts = attempts;
    const reviewing = run(0);
    const decision = await waitFor(() => f.engine.s.inbox.find(item => item.taskId === f.task.id && item.kind === "question"), "the reviewer's delivery-recovery decision", undefined, { during: reviewing });
    expect(f.fakes.received("code reviewer")).toEqual([]);
    expect(message.deliveries["review-0"]?.state).toBe("accepted");
    f.engine.answer(decision.id, MESSAGE_RECOVERY_OPTIONS[0]);
    await reviewing;
    const opening = f.fakes.received("code reviewer")[0]!;
    expect(opening.text.split(text)).toHaveLength(2);
    expect(opening.text).toContain("## The coordinator's notes on this task");
    expect(opening.text).not.toContain("## Messages from the coordinator, in order");
    expect(opening.text).not.toContain(EARLIER_ATTEMPT);
    const input = f.task.journey!.at(-1)!.agentInputs!.at(-1)!;
    expect(input.mode).toBe("fresh");
    expect(input.sections.find(section => section.title.startsWith("The coordinator's notes"))?.body).toContain(text);
    expect(readFileSync(input.exact!.file, "utf8")).toBe(opening.text);
    expect(readFileSync(saved!.context!.file, "utf8")).toContain(text);
    expect(message.deliveries["review-0"]).toEqual(expect.objectContaining({ state: "skipped", via: "live", toolId: "grok", sessionId: "old-review-0", decisionId: decision.id }));
    expect(message.recipients?.["review-0"]).toBe(true);
    expect(f.task.session.some(line => line.coordinatorMessageId === id)).toBe(false);
    expect(f.task.queued).toHaveLength(peerWaiting ? 1 : 0);
    // A warm return keeps the guidance in its packet without another prompt copy.
    await run(0, saved);
    expect(f.fakes.received("code reviewer")).toHaveLength(2);
    expect(f.fakes.received("code reviewer")[1]!.session).toBe(opening.session);
    expect(f.fakes.received("code reviewer")[1]!.text).not.toContain(text);
    expect(message.deliveries["review-0"]?.state).toBe("skipped");
    if (peerWaiting) {
      expect(message.recipients?.["review-1"]).toBe(false);
      expect(message.deliveries["review-1"]?.state).toBe("accepted");
      const peer = run(1);
      const peerDecision = await waitFor(() => f.engine.s.inbox.find(item => item.taskId === f.task.id && item.kind === "question"), "the peer's independent delivery-recovery decision", undefined, { during: peer });
      f.engine.answer(peerDecision.id, MESSAGE_RECOVERY_OPTIONS[1]);
      await peer;
      expect(f.fakes.received("code reviewer")[2]!.text.split(text)).toHaveLength(2);
      expect(message.deliveries["review-1"]?.state).toBe("applied");
      expect(message.deliveries["review-0"]?.state).toBe("skipped");
      expect(f.task.queued).toEqual([]);
    }
  } finally { await f.dispose(); }

  }));
});
