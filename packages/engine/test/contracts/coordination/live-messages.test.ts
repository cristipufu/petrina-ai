import { ENGINE_TEST_ROOT } from "../../fixtures/runtime-paths.js";
import { nativeCoordinatorTask } from "../../fixtures/coordinator-native.js";
import { expect, it } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Engine } from "../../engine.js";
import { BuildResult } from "../../../src/roles.js";
import { executionFor } from "@petrina/orchestrator";
import { waitFor } from "../../fixtures.js";
import type { Scenario } from "../../fake-agent.js";
import { holdUnconfirmed, MESSAGE_RECOVERY_OPTIONS } from "../../../src/messages.js";

const rows = (path: string): Record<string, any>[] => existsSync(path) ? readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)) : [];

async function fixture(live: Scenario["live"], toolId = "codex", ackHeld = false, extra: Partial<Scenario> = {}, startingMessage?: string) {
  const { root, fakes, engine, task, scope, dispose: close } = await nativeCoordinatorTask("petrina-live-messages-", "Add a greeting", { builder: "plain", controlled: true, live, liveAckHeld: ackHeld, ...extra });
  const controller = new AbortController();
  let pending: Promise<unknown> | undefined;
  try {
    const profile = engine.s.profiles.find(profile => profile.toolId === toolId)!;
    task.plan = { rationale: "Build only", plannerProfileId: profile.id, stages: [{ id: "build", kind: "do", title: "Build", roleId: "builder", profileIds: [profile.id] }] };
    task.stageIndex = 0; task.state = "running"; task.holdsSlot = true;
    task.agent = { roleId: "builder", profileId: profile.id, since: Date.now(), step: 0 };
    const start = (signal = controller.signal, profileId = profile.id) => engine["turns"].turn(scope, "builder", profileId, () => [], BuildResult, signal, { ...(startingMessage ? { started: () => { engine.sendMessage(task.id, startingMessage); } } : {}) });
    const running = start(); pending = running; running.catch(() => {});
    await waitFor(() => fakes.received("builder")[0], "the focused Builder prompt to start", undefined, { during: running });
    const session = fakes.received("builder")[0]!.session;
    const release = () => writeFileSync(join(fakes.dir, "release-" + session), "go");
    const acknowledge = () => writeFileSync(join(fakes.dir, "ack-" + session), "go");
    const liveRows = () => rows(join(fakes.dir, "live.jsonl"));
    const dispose = async () => { controller.abort(); release(); acknowledge(); await running.catch(() => {}); await close(); };
    return { engine, task, scope, fakes, pending: running, release, acknowledge, liveRows, controller, dispose, start, root, session };
  } catch (error) {
    controller.abort(); await pending?.catch(() => {}); await close(); throw error;
  }
}

for (const tool of ["codex", "claude-code"]) it(`delivers ordered guidance inside the ${tool} prompt without another turn or Builder return`, async () => {
  const f = await fixture("injected", tool);
  try {
    const step = f.task.journey!.at(-1)!.id;
    const first = f.engine.sendMessage(f.task.id, "Keep the guest view");
    f.engine.sendMessage(f.task.id, "Then check the signed-in view");
    await waitFor(() => f.liveRows().length === 2 && f.task.queued.every(message => message.deliveries?.main?.state === "accepted"), "two live acknowledgements", undefined, { during: f.pending });
    expect(f.liveRows().map(row => row.text)).toEqual(["Keep the guest view", "Then check the signed-in view"]);
    expect(f.task.journey!.at(-1)!.id).toBe(step);
    expect(f.fakes.received("builder")).toHaveLength(1);
    f.engine.removeQueued(f.task.id, first!);
    expect(f.task.queued).toHaveLength(2);
    expect(f.liveRows()[0]!._meta).toEqual(tool === "claude-code" ? { steering: { idleBehavior: "promptRequired" } } : undefined);
    f.release(); await f.pending;
    expect(f.task.queued).toEqual([]);
    expect(f.fakes.received("builder")).toHaveLength(1);
    expect(f.scope.work.stepAttempts).toBe(1);
    expect(f.task.journey!.at(-1)!.agentInputs![0]!.updates!.map(update => update.delivery)).toEqual(["applied", "applied"]);
    expect(f.task.timeline.some(line => line.text.includes("Keep the guest view"))).toBe(false);
  } finally { await f.dispose(); }
});

for (const result of ["refused", "failed", "null", "promptRequired"] as const) it(`keeps ${result} live input waiting, then sends it through one tracked prompt`, async () => {
  const f = await fixture(result, result === "promptRequired" ? "claude-code" : "codex", result === "promptRequired");
  try {
    f.engine.sendMessage(f.task.id, "Check the guest view too");
    await waitFor(() => f.liveRows().length === 1, "the live attempt", undefined, { during: f.pending });
    if (result === "promptRequired") { f.release(); f.acknowledge(); }
    else {
      await waitFor(() => f.task.queued[0]?.deliveries?.main?.state === "waiting", "a rejected acknowledgement to leave the message waiting", undefined, { during: f.pending });
      expect(f.fakes.received("builder")).toHaveLength(1);
      expect(rows(join(f.fakes.dir, "cancelled.jsonl"))).toEqual([]);
      f.release();
    }
    await f.pending;
    const heard = f.fakes.received("builder").filter(row => row.text.includes("Check the guest view too"));
    expect(heard).toHaveLength(1);
    expect(heard[0]!.session).toBe(f.session);
    expect(f.task.queued).toEqual([]);
    expect(f.task.journey!.at(-1)!.agentInputs![0]!.updates!.find(update => update.messageId)?.delivery).toBe("applied");
    expect(f.scope.work.stepAttempts).toBe(1);
  } finally { await f.dispose(); }
});

for (const tool of ["codex", "grok"]) it(`offers recovery for ${tool} acceptance without resending or accepting the original result`, async () => {
  const f = await fixture(tool === "grok" ? "queued" : "startedNewTurn", tool, tool === "codex");
  try {
    const messageId = f.engine.sendMessage(f.task.id, "Check the guest view too")!;
    await waitFor(() => f.liveRows().length === 1, "a live attempt", undefined, { during: f.pending });
    f.release(); f.acknowledge();
    const decision = await waitFor(() => f.engine.s.inbox.find(item => item.taskId === f.task.id && item.kind === "question"), "an actionable delivery decision", undefined, { during: f.pending });
    expect(decision.options).toEqual([...MESSAGE_RECOVERY_OPTIONS]);
    expect(f.task.queued[0]?.deliveries?.main?.state).toBe("accepted");
    expect(f.task.journey!.at(-1)!.agentResults).toBeUndefined();
    expect(f.fakes.received("builder")).toHaveLength(1);
    f.engine.removeQueued(f.task.id, messageId);
    expect(f.task.queued).toHaveLength(1);
    if (tool === "grok") expect(f.liveRows()[0]!.interjectionId).toBe(messageId);
    // A saved receipt blocks a replacement before it opens or receives the same notes.
    f.controller.abort(); await f.pending.catch(() => {});
    f.engine.commitNow(f.scope);
    await f.engine.shutdown();
    const replacement = new Engine(join(f.root, "data"), { agentCommand: () => [process.execPath, join(ENGINE_TEST_ROOT, "fake-agent.ts"), f.fakes.dir], usageCommands: { codex: null, grok: null, antigravity: null } });
    replacement.setPoolPaused(true);
    try {
      const saved = replacement.task(f.task.id)!;
      expect(saved.queued[0]?.deliveries?.main?.state).toBe("accepted");
      expect(saved.queued[0]?.deliveries?.main?.sessionId).toBe(f.session);
      expect(f.liveRows()).toHaveLength(1);
      expect(f.fakes.received("builder")).toHaveLength(1);
      expect(replacement.s.inbox.find(item => item.id === decision.id)?.options).toEqual([...MESSAGE_RECOVERY_OPTIONS]);
      replacement.answer(decision.id, MESSAGE_RECOVERY_OPTIONS[0]);
      await holdUnconfirmed(replacement, executionFor(saved), undefined, new AbortController().signal);
      expect(saved.queued).toEqual([]);
      expect(f.liveRows()).toHaveLength(1);
    } finally { await replacement.shutdown(); }
  } finally { await f.dispose(); }
});

it("keeps an explicit wait ahead of later live guidance and allows removal before acceptance", async () => {
  const f = await fixture("injected");
  try {
    const removed = f.engine.sendMessage(f.task.id, "Take this back", "queue")!;
    f.engine.removeQueued(f.task.id, removed);
    f.engine.sendMessage(f.task.id, "First wait", "queue");
    f.engine.sendMessage(f.task.id, "Second guidance", "now");
    expect(f.liveRows()).toEqual([]);
    f.release(); await f.pending;
    const text = f.fakes.received("builder")[1]!.text;
    expect(text.indexOf("First wait")).toBeLessThan(text.indexOf("Second guidance"));
    expect(text).not.toContain("Take this back");
    const update = f.task.journey!.at(-1)!.agentInputs![0]!.updates!.find(update => update.reason === "message")!;
    expect(readFileSync(update.exact!.file, "utf8")).toBe(text);
    expect(f.task.queued).toEqual([]);
  } finally { await f.dispose(); }
});

for (const tool of ["codex", "antigravity", "grok"]) it(`waits when ${tool} cannot take live guidance`, async () => {
  const f = await fixture(tool === "antigravity" ? "injected" : undefined, tool, false, tool === "grok" ? { liveProbe: "null" } : {});
  try {
    f.engine.sendMessage(f.task.id, "Check the guest view too");
    await waitFor(() => f.task.queued[0]?.deliveries?.main?.reason === "unsupported", "the capability fallback", undefined, { during: f.pending });
    expect(f.liveRows()).toEqual([]);
    f.release(); await f.pending;
    expect(f.fakes.received("builder").filter(row => row.text.includes("Check the guest view too"))).toHaveLength(1);
  } finally { await f.dispose(); }
});

it("retains possibly accepted input when a different tool takes over", async () => {
  const f = await fixture("startedNewTurn");
  const replacement = new AbortController();
  try {
    f.engine.sendMessage(f.task.id, "Check the guest view too");
    await waitFor(() => f.task.queued[0]?.deliveries?.main?.state === "accepted", "acceptance before failover", undefined, { during: f.pending });
    f.controller.abort(); f.release(); await f.pending.catch(() => {});
    const opens = f.fakes.opens().length;
    const profile = f.engine.s.profiles.find(profile => profile.toolId === "claude-code")!;
    const next = f.start(replacement.signal, profile.id); next.catch(() => {});
    const decision = await waitFor(() => f.engine.s.inbox.find(item => item.taskId === f.task.id && item.kind === "question"), "failover to offer a delivery decision", undefined, { during: next });
    expect(decision.options).toEqual([...MESSAGE_RECOVERY_OPTIONS]);
    expect(f.fakes.opens()).toHaveLength(opens);
    expect(f.fakes.received("builder")).toHaveLength(1);
    expect(f.task.queued[0]?.deliveries?.main?.toolId).toBe("codex");
    replacement.abort(); await next.catch(() => {});
  } finally { replacement.abort(); await f.dispose(); }
});

it("includes guidance arriving during startup in the exact opening before applying its receipt", async () => {
  const f = await fixture("injected", "codex", false, {}, "Keep the starting guidance");
  try {
    expect(f.task.queued[0]?.deliveries?.main?.state).toBe("applied");
    expect(f.liveRows()).toEqual([]);
    const opening = f.fakes.received("builder")[0]!.text;
    expect(opening.split("Keep the starting guidance")).toHaveLength(2);
    expect(readFileSync(f.task.journey!.at(-1)!.agentInputs![0]!.exact!.file, "utf8")).toBe(opening);
    f.release(); await f.pending;
    expect(f.fakes.received("builder")).toHaveLength(1);
    expect(f.task.queued).toEqual([]);
  } finally { await f.dispose(); }
});

it("delivers during a permission wait without cancelling or replacing the request", async () => {
  const f = await fixture("injected", "claude-code", false, { livePermission: true });
  try {
    f.release();
    const permission = await waitFor(() => f.engine.s.inbox.find(item => item.taskId === f.task.id && item.kind === "permission"), "the live permission request", undefined, { during: f.pending });
    f.engine.sendMessage(f.task.id, "Keep the guest view");
    await waitFor(() => f.task.queued[0]?.deliveries?.main?.state === "accepted", "guidance accepted beside the permission", undefined, { during: f.pending });
    expect(f.engine.s.inbox.some(item => item.id === permission.id)).toBe(true);
    expect(rows(join(f.fakes.dir, "cancelled.jsonl"))).toEqual([]);
    f.engine.allow(permission.id, "once"); await f.pending;
    expect(f.task.queued).toEqual([]);
    expect(f.fakes.received("builder")).toHaveLength(1);
  } finally { await f.dispose(); }
});

it("keeps screen-wait guidance for one ordinary continuation of the saved conversation", async () => {
  const f = await fixture("injected", "codex", false, { screen: "ask", reopen: "resume" });
  try {
    f.release(); await f.pending.catch(() => {});
    expect(f.task.screen?.granted).not.toBe(true);
    const step = f.task.journey!.at(-1)!.id;
    f.engine.sendMessage(f.task.id, "Check the dark theme too");
    expect(f.liveRows()).toEqual([]);
    expect(f.task.queued).toHaveLength(1);
    // Screen access is a stand-in: the scripted agent never opens an app or window.
    f.task.screen!.granted = true;
    f.task.state = "running"; f.task.holdsSlot = true;
    f.task.agent = { roleId: "builder", profileId: f.scope.work.conversation!.profileId, since: Date.now(), step: 0 };
    await f.start();
    const continuation = f.fakes.received("builder")[1]!;
    expect(continuation.session).toBe(f.session);
    expect(continuation.text).toContain("Check the dark theme too");
    expect(f.fakes.received("builder").filter(row => row.text.includes("Check the dark theme too"))).toHaveLength(1);
    expect(f.task.journey!.at(-1)!.id).toBe(step);
    expect(f.task.queued).toEqual([]);
  } finally { await f.dispose(); }
});

it("preserves a screen request even when Grok has not confirmed hearing live guidance", async () => {
  const f = await fixture("queued", "grok", false, { screen: "ask" });
  try {
    f.engine.sendMessage(f.task.id, "Keep the guest view");
    await waitFor(() => f.task.queued[0]?.deliveries?.main?.state === "accepted", "Grok to accept guidance", undefined, { during: f.pending });
    f.release(); await f.pending.catch(() => {});
    expect(f.task.screen).toBeDefined();
    expect(f.task.queued[0]?.deliveries?.main?.state).toBe("accepted");
    expect(f.fakes.received("builder")).toHaveLength(1);
    expect(f.task.journey!.at(-1)!.agentResults).toBeUndefined();
  } finally { await f.dispose(); }
});

it("hears a message that joined the turn when that turn is stopped, and still delivers later notes", async () => {
  const f = await fixture("injected", "codex", false, { cancelHeld: true });
  try {
    f.engine.sendMessage(f.task.id, "Keep the guest view");
    await waitFor(() => f.task.queued[0]?.deliveries?.main?.state === "accepted", "the live message to join the turn", undefined, { during: f.pending });
    f.engine.sendMessage(f.task.id, "Mention the signed-in view", "queue");
    f.engine.sendMessage(f.task.id, "Use the shorter greeting", "interrupt");
    const result = await f.pending;
    expect(result.summary).toBe("Added a greeting.");
    expect(f.task.statusLine ?? "").not.toContain("Waiting for the tool to confirm");
    expect(f.task.queued.find(message => message.text === "Keep the guest view")).toBeUndefined();
    expect(f.task.journey!.at(-1)!.agentInputs![0]!.updates!.find(update => update.text === "Keep the guest view")?.delivery).toBe("applied");
    const follow = f.fakes.received("builder").map(row => row.text).find(text => text.includes("Use the shorter greeting"));
    expect(follow).toContain("Mention the signed-in view");
    expect(follow!.indexOf("Use the shorter greeting")).toBeLessThan(follow!.indexOf("Mention the signed-in view"));
  } finally { await f.dispose(); }
});

it("hears a joined message when the turn is paused before it reports back", async () => {
  const f = await fixture("injected");
  try {
    f.engine.sendMessage(f.task.id, "Keep the guest view");
    await waitFor(() => f.task.queued[0]?.deliveries?.main?.state === "accepted", "the tool to accept it", undefined, { during: f.pending });
    f.engine.messageTurns.get(f.task.id)!.get("main")!.dispose();
    expect(f.task.queued).toEqual([]);
    expect(f.task.journey!.at(-1)!.agentInputs![0]!.updates![0]!.delivery).toBe("applied");
    f.release();
    const result = await f.pending;
    expect(result.summary).toBe("Added a greeting.");
    expect(f.task.statusLine ?? "").not.toContain("Waiting for the tool to confirm");
  } finally { await f.dispose(); }
});

it("does not send a live message taken back while an earlier one is still being acknowledged", async () => {
  const f = await fixture("injected", "codex", true);
  try {
    f.engine.sendMessage(f.task.id, "First guidance");
    await waitFor(() => f.liveRows().length === 1, "the first acknowledgement to be in flight", undefined, { during: f.pending });
    const second = f.engine.sendMessage(f.task.id, "Second guidance")!;
    f.engine.removeQueued(f.task.id, second);
    f.engine.sendMessage(f.task.id, "Third guidance");
    f.acknowledge();
    await waitFor(() => f.task.queued.find(message => message.text === "Third guidance")?.deliveries?.main?.state === "accepted", "the later message to be accepted", undefined, { during: f.pending });
    expect(f.liveRows().map(row => row.text)).toEqual(["First guidance", "Third guidance"]);
    expect(f.task.session.some(line => line.text === "Second guidance")).toBe(false);
    expect(f.task.queued.some(message => message.text === "Second guidance")).toBe(false);
    expect(f.task.queued.find(message => message.text === "Third guidance")?.deliveries?.main?.state).toBe("accepted");
    f.release();
    await f.pending;
  } finally { await f.dispose(); }
});

it("recovers a lost acknowledgement as unconfirmed instead of sending it again", async () => {
  const f = await fixture("injected", "codex", true);
  try {
    f.engine.sendMessage(f.task.id, "Keep the guest view");
    await waitFor(() => f.liveRows().length === 1, "the in-flight request before the connection is lost", undefined, { during: f.pending });
    expect(f.task.queued[0]?.deliveries?.main?.state).toBe("sending");
    f.controller.abort(); f.release(); await f.pending.catch(() => {});
    f.engine.commitNow(f.scope); await f.engine.shutdown();
    const recovered = new Engine(join(f.root, "data"), { agentCommand: () => [process.execPath, join(ENGINE_TEST_ROOT, "fake-agent.ts"), f.fakes.dir], usageCommands: { codex: null, grok: null, antigravity: null } });
    recovered.setPoolPaused(true);
    try {
      const message = recovered.task(f.task.id)!.queued[0]!;
      expect(message.deliveries?.main?.state).toBe("unconfirmed");
      expect(message.deliveries?.main?.sessionId).toBe(f.session);
      recovered.removeQueued(f.task.id, message.id);
      expect(recovered.task(f.task.id)!.queued).toHaveLength(1);
      expect(f.liveRows()).toHaveLength(1);
    } finally { await recovered.shutdown(); }
  } finally { await f.dispose(); }
});

for (const choice of MESSAGE_RECOVERY_OPTIONS) it(`recovers Grok's accepted message with ${choice}`, async () => {
  const f = await fixture("queued", "grok");
  try {
    f.engine.sendMessage(f.task.id, "Keep the guest view");
    await waitFor(() => f.task.queued[0]?.deliveries?.main?.state === "accepted", "Grok acceptance", undefined, { during: f.pending });
    f.release();
    const decision = await waitFor(() => f.engine.s.inbox.find(item => item.taskId === f.task.id && item.kind === "question"), "delivery recovery", undefined, { during: f.pending });
    expect(f.task.journey!.at(-1)!.agentResults).toBeUndefined();
    f.engine.answer(decision.id, choice);
    const result = await f.pending;
    expect(result.summary).toBe("Added a greeting.");
    expect(f.task.queued).toEqual([]);
    expect(f.task.stepNotes?.some(note => note.kind === "answer" && note.text === choice)).not.toBe(true);
    expect(f.liveRows()).toHaveLength(1);
    expect(f.fakes.received("builder")).toHaveLength(choice === MESSAGE_RECOVERY_OPTIONS[1] ? 2 : 1);
    const update = f.task.journey!.at(-1)!.agentInputs![0]!.updates!.find(update => update.messageId);
    expect(update?.delivery).toBe(choice === MESSAGE_RECOVERY_OPTIONS[1] ? "applied" : "skipped");
  } finally { await f.dispose(); }
});

it("requires an explicit resend choice and keeps later messages ordered", async () => {
  const f = await fixture("queued", "grok");
  try {
    f.engine.sendMessage(f.task.id, "First guidance");
    await waitFor(() => f.task.queued[0]?.deliveries?.main?.state === "accepted", "acceptance", undefined, { during: f.pending });
    f.engine.sendMessage(f.task.id, "Later guidance", "queue");
    f.release();
    const first = await waitFor(() => f.engine.s.inbox.find(item => item.taskId === f.task.id && item.kind === "question"), "recovery", undefined, { during: f.pending });
    f.engine.answer(first.id, "I am unsure");
    const second = await waitFor(() => f.engine.s.inbox.find(item => item.taskId === f.task.id && item.kind === "question" && item.id !== first.id), "explicit choices again", undefined, { during: f.pending });
    expect(f.fakes.received("builder")).toHaveLength(1);
    f.engine.answer(second.id, MESSAGE_RECOVERY_OPTIONS[1]);
    await f.pending;
    const follow = f.fakes.received("builder")[1]!.text;
    expect(follow.indexOf("First guidance")).toBeLessThan(follow.indexOf("Later guidance"));
    expect(f.task.queued).toEqual([]);
  } finally { await f.dispose(); }
});
