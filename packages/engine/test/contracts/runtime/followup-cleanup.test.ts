import { afterEach, expect, it, spyOn } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { AgentRun } from "@petrina/agent-runtime/acp-run";
import { SLOW } from "@petrina/test-support/slow";
import { waitFor } from "../../fixtures.js";
import { scriptedResult } from "../../scripted-agents.js";
import { turnCleanupFixtures } from "../../fixtures/turn-cleanup.js";

const fixtures = turnCleanupFixtures();
afterEach(() => fixtures.close());
type Fixture = Awaited<ReturnType<typeof fixtures.fixture>>;
const job = (f: Fixture) => f.engine.s.backgroundAgents!.find(agent => agent.label === "Matching older bugs")!.id;

function ambiguous(f: Fixture) {
  const target = f.engine.addTask({ productId: "p", title: "Older welcome problem", description: "Investigate the welcome page", kind: "bug", backlog: true });
  f.task.findings = [{ id: "older", text: "The welcome page loses saved preferences.", severity: "pre-existing", status: "open", raisedBy: "opus-high", confirmedBy: [],
    steps: "Open the welcome page after saving a preference.", evidence: "The same behavior occurs on the previous version." }];
  f.task.state = "done"; f.task.finishedAt = Date.now(); f.task.column = "done";
  return { target, key: `${f.task.id}::older`, source: () => f.engine.task(f.task.id)! };
}

async function retained(f: Fixture, errors: unknown[]) {
  const shutdown = await f.observe(() => f.engine.shutdown());
  expect(shutdown.kind).toBe("error");
  if (shutdown.kind !== "error") throw new Error("Native matcher uncertainty became successful shutdown");
  if (errors.length === 1) expect(shutdown.error).toBe(errors[0]);
  else {
    expect(shutdown.error).toBeInstanceOf(AggregateError);
    const actual = (shutdown.error as AggregateError).errors;
    expect(actual).toHaveLength(errors.length);
    for (let index = 0; index < errors.length; index++) expect(actual[index]).toBe(errors[index]);
  }
  expect(f.storeClosed).toBe(true);
  const owned = await f.closeSubject(); expect(owned.kind).toBe("error"); expect(existsSync(f.root)).toBe(true);
  f.acknowledgeRetained(owned, shutdown.error);
}

for (const stop of ["confirmed", "false", "reject-error", "reject-undefined"] as const) it(`keeps matcher cleanup independent of its optional answer and background seat: ${stop}`, async () => {
  let key = "", target = "";
  const f = await fixtures.fixture({ nativeOpening: true, stop, reply: () => scriptedResult({ groups: [{ keys: [key], cardId: target }] }) });
  const calls: { cwd: string; id: string }[] = [];
  try {
    const input = ambiguous(f); key = input.key; target = input.target;
    const start = spyOn(AgentRun, "start"); f.restore(() => start.mockRestore());
    start.mockImplementation(async options => {
      calls.push({ cwd: options.cwd, id: job(f) });
      expect(options.browser).toBe(false); expect(options.command).toEqual([join(f.root, "unconfigured-agent-must-never-launch")]);
      expect(options.onGone).toBeFunction(); expect(options.callbacks.onCleanupIncomplete).toBeFunction();
      return await f.start(options, f.engine.role("verifier")!) as unknown as AgentRun;
    });
    await f.observe(() => f.engine["followUps"].noteDone(f.task));
    expect(calls).toHaveLength(1); expect(f.stopCalls).toBe(1);
    expect(f.engine.s.backgroundAgents).toEqual([]);
    if (stop === "confirmed") {
      expect(existsSync(calls[0]!.cwd)).toBe(false);
      expect(input.source().findings[0]!.tracking).toEqual({ taskId: target });
      expect(f.engine.agentCleanup.has(calls[0]!.id)).toBe(false);
      const shutdown = await f.observe(() => f.engine.shutdown()); expect(shutdown.kind).toBe("value"); expect(f.storeClosed).toBe(true);
      const owned = await f.closeSubject(); expect(owned.kind).toBe("value"); expect(existsSync(f.root)).toBe(false);
    } else {
      expect(input.source().findings[0]!.tracking).toMatchObject({ reason: "unavailable", retry: true });
      expect(existsSync(calls[0]!.cwd)).toBe(true); expect(f.engine.agentCleanup.has(calls[0]!.id)).toBe(true);
      const first = await f.observe(() => f.engine.agentCleanup.wait(calls[0]!.id, calls[0]!.cwd));
      expect(first.kind).toBe("error");
      if (first.kind !== "error") throw new Error("The first matcher lost its failed cleanup receipt");
      if (stop === "false") expect((first.error as Error).message).toBe("Agent cleanup was not confirmed");
      else expect(first.error).toBe(stop === "reject-undefined" ? undefined : f.cleanupFailure);
      // Repeated optional comparisons cannot bypass this producer's uncertain worker by
      // choosing a fresh random job or directory. Other task producers remain independent.
      await f.observe(() => f.engine["followUps"].catchUp());
      expect(calls).toHaveLength(1); expect(f.stopCalls).toBe(1);
      expect(existsSync(calls[0]!.cwd)).toBe(true); expect(f.engine.agentCleanup.has(calls[0]!.id)).toBe(true);
      expect(input.source().findings[0]!.tracking).toMatchObject({ reason: "unavailable", retry: true });
      expect(f.engine.s.backgroundAgents).toEqual([]);
      await retained(f, [first.error]);
    }
  } finally { await f.finish(); }
}, 30_000 * SLOW);

for (const kind of ["reject-error", "reject-undefined", "incomplete"] as const) it(`retains failed-opening cleanup even without a returned matcher session: ${kind}`, async () => {
  const failure = kind === "reject-error" ? new Error("Opening cleanup could not be confirmed") : undefined;
  const f = await fixtures.fixture({ nativeOpening: true });
  const gone = Promise.withResolvers<void>(), openingFailure = new Error("The native matcher did not open");
  let cwd = "", id = "";
  try {
    const input = ambiguous(f);
    const start = spyOn(AgentRun, "start"); f.restore(() => start.mockRestore());
    start.mockImplementation(async options => {
      cwd = options.cwd; id = job(f);
      expect(options.onGone).toBeFunction();
      if (kind === "incomplete") { expect(options.callbacks.onCleanupIncomplete).toBeFunction(); options.callbacks.onCleanupIncomplete!(); }
      else options.onGone!(gone.promise);
      // This controlled SDK failure has no child. Its rejected observation claims uncertainty,
      // never a fabricated native exit or cleanup success.
      throw openingFailure;
    });
    const matching = f.observe(() => f.engine["followUps"].noteDone(f.task));
    await waitFor(() => cwd !== "", "the entered native matcher opening", undefined, { during: matching });
    if (kind !== "incomplete") gone.reject(failure);
    await matching;
    expect(start).toHaveBeenCalledTimes(1); expect(f.stopCalls).toBe(0);
    expect(input.source().findings[0]!.tracking).toMatchObject({ reason: "unavailable", retry: true });
    expect(existsSync(cwd)).toBe(true); expect(f.engine.agentCleanup.has(id)).toBe(true);
    expect(f.engine.s.backgroundAgents).toEqual([]);
    const failed = await f.observe(() => f.engine.agentCleanup.wait(id, cwd));
    expect(failed.kind).toBe("error");
    if (failed.kind !== "error") throw new Error("A failed opening lost native ownership");
    if (kind === "incomplete") expect((failed.error as Error).message).toBe("Agent cleanup was not confirmed");
    else expect(failed.error).toBe(failure);
    await retained(f, [failed.error]);
  } finally { gone.resolve(); await f.finish(); }
}, 30_000 * SLOW);

it("keeps a queued comparison behind pending native cleanup, then permits its next confirmed job", async () => {
  let key = "", target = "", cleanupReached = false, firstSettled = false;
  const f = await fixtures.fixture({ nativeOpening: true, reply: () => scriptedResult({ groups: [{ keys: [key], cardId: target }] }) });
  const gone = Promise.withResolvers<void>(), calls: { cwd: string; id: string }[] = [];
  try {
    const input = ambiguous(f); key = input.key; target = input.target;
    const wait = f.engine.agentCleanup.wait.bind(f.engine.agentCleanup), waiting = spyOn(f.engine.agentCleanup, "wait"); f.restore(() => waiting.mockRestore());
    waiting.mockImplementation((id, cwd) => {
      const result = wait(id, cwd);
      if (id === calls[0]?.id && cwd === calls[0]?.cwd) cleanupReached = true;
      return result;
    });
    const start = spyOn(AgentRun, "start"); f.restore(() => start.mockRestore());
    start.mockImplementation(async options => {
      calls.push({ cwd: options.cwd, id: job(f) });
      if (calls.length === 1) {
        // No child exists in this SDK stub. The held observation controls settlement only;
        // this test makes no claim of actual OS termination or a native exit notification.
        options.onGone!(gone.promise);
        throw new Error("The first matcher did not open");
      }
      return await f.start(options, f.engine.role("verifier")!) as unknown as AgentRun;
    });
    const first = f.observe(() => f.engine["followUps"].noteDone(f.task));
    const observedFirst = first.then(result => { firstSettled = true; return result; });
    await waitFor(() => cleanupReached, "the actual matcher cleanup barrier", undefined, { during: first });
    const next = f.observe(() => f.engine["followUps"].catchUp());
    expect(calls).toHaveLength(1); expect(existsSync(calls[0]!.cwd)).toBe(true);
    const completedAtRelease = firstSettled;
    gone.resolve(); await observedFirst; await next;
    expect(completedAtRelease).toBe(false);
    expect(calls).toHaveLength(2); expect(calls[1]!.cwd).not.toBe(calls[0]!.cwd); expect(calls[1]!.id).not.toBe(calls[0]!.id);
    expect(calls.every(call => !existsSync(call.cwd) && !f.engine.agentCleanup.has(call.id))).toBe(true);
    expect(f.stopCalls).toBe(1); expect(f.engine.s.backgroundAgents).toEqual([]);
    expect(input.source().findings[0]!.tracking).toEqual({ taskId: target });
    const shutdown = await f.observe(() => f.engine.shutdown()); expect(shutdown.kind).toBe("value"); expect(f.storeClosed).toBe(true);
    const owned = await f.closeSubject(); expect(owned.kind).toBe("value"); expect(existsSync(f.root)).toBe(false);
  } finally { gone.resolve(); await f.finish(); }
}, 30_000 * SLOW);

for (const failure of [new Error("The comparison could not answer"), undefined]) it(`keeps an ordinary matcher failure unavailable while confirmed cleanup permits shutdown: ${failure === undefined ? "undefined" : "Error"}`, async () => {
  const f = await fixtures.fixture({ nativeOpening: true, reply: () => { throw failure; } });
  let cwd = "";
  try {
    const input = ambiguous(f), start = spyOn(AgentRun, "start"); f.restore(() => start.mockRestore());
    start.mockImplementation(async options => { cwd = options.cwd; return await f.start(options, f.engine.role("verifier")!) as unknown as AgentRun; });
    await f.observe(() => f.engine["followUps"].noteDone(f.task));
    expect(start).toHaveBeenCalledTimes(1); expect(f.stopCalls).toBe(1);
    expect(input.source().findings[0]!.tracking).toMatchObject({ reason: "unavailable", retry: true });
    expect(existsSync(cwd)).toBe(false); expect(f.engine.agentCleanup.size).toBe(0); expect(f.engine.s.backgroundAgents).toEqual([]);
    const shutdown = await f.observe(() => f.engine.shutdown()); expect(shutdown.kind).toBe("value"); expect(f.storeClosed).toBe(true);
    const owned = await f.closeSubject(); expect(owned.kind).toBe("value"); expect(existsSync(f.root)).toBe(false);
  } finally { await f.finish(); }
}, 30_000 * SLOW);

it("attempts schedule after a recording failure without skipping confirmed matcher cleanup", async () => {
  const f = await fixtures.fixture({ nativeOpening: true, reply: () => scriptedResult({ groups: [] }) });
  let cwd = "", recorded = 0, scheduled = 0;
  try {
    ambiguous(f);
    const start = spyOn(AgentRun, "start"); f.restore(() => start.mockRestore());
    start.mockImplementation(async options => { cwd = options.cwd; return await f.start(options, f.engine.role("verifier")!) as unknown as AgentRun; });
    const commit = f.engine.commit.bind(f.engine), observer = spyOn(f.engine, "commit"); f.restore(() => observer.mockRestore());
    observer.mockImplementation(target => { if (cwd && !f.engine.s.backgroundAgents?.length) { recorded++; throw new Error("Could not record the released matcher seat"); } commit(target); });
    const schedule = spyOn(f.engine, "schedule"); f.restore(() => schedule.mockRestore());
    schedule.mockImplementation(() => { scheduled++; throw undefined; });
    await f.observe(() => f.engine["followUps"].noteDone(f.task));
    expect(start).toHaveBeenCalledTimes(1); expect(f.stopCalls).toBe(1);
    expect(recorded).toBeGreaterThan(0); expect(scheduled).toBeGreaterThan(0);
    expect(existsSync(cwd)).toBe(false); expect(f.engine.agentCleanup.size).toBe(0); expect(f.engine.s.backgroundAgents).toEqual([]);
    const shutdown = await f.observe(() => f.engine.shutdown()); expect(shutdown.kind).toBe("value"); expect(f.storeClosed).toBe(true);
    const owned = await f.closeSubject(); expect(owned.kind).toBe("value"); expect(existsSync(f.root)).toBe(false);
  } finally { await f.finish(); }
}, 30_000 * SLOW);
