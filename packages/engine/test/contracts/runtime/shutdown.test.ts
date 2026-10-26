import type { AgentSession } from "@petrina/orchestrator";
import { setupWithCleanup } from "@petrina/test-support/setup-with-cleanup";
import { ScriptedAgents } from "../../scripted-agents.js";
import { directDrivers, removeFixtureRoot } from "../../fixtures/direct-drivers.js";
import { afterAll, afterEach, expect, it, spyOn } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import { Engine } from "../../engine.js";
import { removeDir, tempDir } from "../../fixtures.js";
import { SLOW } from "@petrina/test-support/slow";

const roots: string[] = [];
afterAll(() => roots.forEach(removeDir));
const gate = () => {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
};

for (const kind of ["background", "copy", "nested"] as const) it(`shutdown waits for owned ${kind} file handling before its caller removes the fixture`, async () => {
  const root = tempDir("shutdown-ownership-"); roots.push(root);
  const engine = new Engine(join(root, "data"));
  const first = gate(), next = gate(), enteredNext = gate();
  let stopping: Promise<void> | undefined, settled = false;
  try {
    await engine.waitUntilReady();
    await Promise.all([...engine.backgroundWork]);
    const file = join(root, "finished.txt");
    const work = first.promise.then(async () => {
      if (kind === "nested") {
        engine.trackWork(next.promise.then(() => { writeFileSync(file, "finished"); }));
        enteredNext.release();
      } else writeFileSync(file, "finished");
    });
    if (kind === "copy") {
      const owned = work.finally(() => engine.copyCleanups.delete("owned"));
      engine.copyCleanups.set("owned", owned);
    } else engine.trackWork(work);
    const stop = engine.shutdown(), repeated = engine.shutdown();
    stopping = stop.then(() => { settled = true; });
    // Deliver the native event-loop boundary; the held work, not a duration, controls completion.
    await setImmediate();
    expect(settled).toBe(false);
    first.release();
    if (kind === "nested") {
      await enteredNext.promise;
      await setImmediate();
      expect(settled).toBe(false);
      next.release();
    }
    await Promise.all([stop, repeated]); await stopping;
    expect(repeated).toBe(stop);
    expect(readFileSync(file, "utf8")).toBe("finished");
    expect(engine.backgroundWork.size).toBe(0);
    expect(engine.copyCleanups.size).toBe(0);
  } finally { first.release(); next.release(); await stopping; await engine.shutdown(); }
}, 30_000 * SLOW);

it("keeps a background failure available to its caller and still waits for a separate cleanup owner", async () => {
  const root = tempDir("shutdown-failed-owner-"); roots.push(root);
  const engine = new Engine(join(root, "data")), failed = gate(), held = gate();
  let stopping: Promise<void> | undefined, settled = false;
  try {
    await engine.waitUntilReady(); await Promise.all([...engine.backgroundWork]);
    const failure = new Error("The owned cleanup failed");
    const result = engine.trackWork(failed.promise.then(() => { throw failure; })).catch(error => error);
    engine.trackWork(held.promise.then(() => { writeFileSync(join(root, "finished.txt"), "finished"); }));
    stopping = engine.shutdown().then(() => { settled = true; });
    failed.release(); expect(await result).toBe(failure);
    await setImmediate(); expect(settled).toBe(false);
    held.release(); await stopping;
    expect(readFileSync(join(root, "finished.txt"), "utf8")).toBe("finished");
    expect(engine.backgroundWork.size).toBe(0);
  } finally { failed.release(); held.release(); await stopping; await engine.shutdown(); }
}, 30_000 * SLOW);

// These sessions have no native actor. Their controlled stop replies exercise the actual Engine consumer;
// the original ScriptedSession stops remain independent cleanup authority after every subject assertion.
const controlledClosers = new Set<() => Promise<void>>();
afterEach(async () => {
  const settled = await Promise.allSettled([...controlledClosers].map(close => close()));
  const failures = settled.flatMap(result => result.status === "rejected" ? [result.reason] : []);
  if (failures.length) throw new AggregateError(failures, "Controlled shutdown fixtures could not confirm cleanup");
});

for (const released of [false, true]) for (const mode of ["false", "reject-error", "reject-undefined", "throw-error", "throw-undefined", "both", "owner-reject", "owner-throw", "confirmed"] as const) it(`joins every actual stop and late file owner before reporting agent cleanup${released ? " after the seats were released" : ""}: ${mode}`, async () => {
  const root = tempDir("shutdown-stop-authority-"), owner = directDrivers(root);
  const peer = gate(), handoff = gate(), tail = gate();
  const originals: (() => Promise<boolean>)[] = [], ownerStops: (() => Promise<void>)[] = [], restores: (() => void)[] = [], work: Promise<unknown>[] = [];
  const failure = new Error("The entered agent stop rejected");
  let engine: Engine | undefined, setup: Promise<void> | undefined, stopping: Promise<void> | undefined;
  let expectedOwnerFailure: { error: unknown } | undefined, finishing: Promise<void> | undefined;
  let closing = false, storeClosed = false, saved = false, peerCompleted = false, tailCompleted = false;
  let reentrant: Promise<void> | undefined, aborted: Promise<void> | undefined;
  const calls: string[] = [];
  let ownerCalls = 0;
  const finish = (): Promise<void> => {
    closing = true; peer.release(); handoff.release(); tail.release();
    if (finishing) return finishing;
    const completed = Promise.withResolvers<void>(); finishing = completed.promise;
    void (async () => {
      // A late scripted-session construction is observed before snapshotting its bound cleanup.
      await Promise.allSettled([setup]);
      const errors: unknown[] = [];
      for (const restore of restores) try { restore(); } catch (error) { errors.push(error); }
      const sessions = await Promise.allSettled(originals.map(stop => stop()));
      for (const result of sessions) {
        if (result.status === "rejected") errors.push(result.reason);
        else if (!result.value) errors.push(new Error("The original controlled session did not confirm cleanup"));
      }
      const nativeOwners = await Promise.allSettled(ownerStops.map(stop => stop()));
      for (const result of nativeOwners) if (result.status === "rejected") errors.push(result.reason);
      const operations = await Promise.allSettled([...work, stopping]);
      for (let i = 0; i < operations.length - 1; i++) if (operations[i]!.status === "rejected") errors.push((operations[i] as PromiseRejectedResult).reason);
      // On the old synchronous-throw implementation the ordinary close was skipped. Independently close
      // these real databases before canonical owner.close can dispose the actor-free red-test root.
      if (engine && !storeClosed) {
        try { engine.tracking.close(); } catch (error) { errors.push(error); }
        try { engine.store.close(); storeClosed = true; } catch (error) { errors.push(error); }
      }
      const owned = await owner.close().then(() => ({ kind: "value" as const }), error => ({ kind: "error" as const, error }));
      if (owned.kind === "error" && (!expectedOwnerFailure || owned.error !== expectedOwnerFailure.error)) errors.push(owned.error);
      if (engine && !storeClosed) errors.push(new Error("The actual Store did not close; root retained"));
      if (errors.length) throw new AggregateError(errors, "Controlled sessions or file operations remain uncertain; root retained");
      // A deliberately false/rejected subject result was asserted before this independent, known-actor-free disposal.
      removeFixtureRoot(root);
    })().then(completed.resolve, completed.reject);
    void finishing.then(() => controlledClosers.delete(finish), () => undefined);
    return finishing;
  };
  controlledClosers.add(finish);
  await setupWithCleanup(async () => {
    setup = owner.prepare(async () => {
      const current = engine = owner.open(join(root, "data"), { agentCommand: () => undefined });
      await current.waitUntilReady(); await Promise.all([...current.backgroundWork]);
      const agents = new ScriptedAgents(() => { throw new Error("Shutdown controls must not prompt an agent"); });
      current.stopRequested.signal.addEventListener("abort", () => { void (aborted = current.shutdown()).catch(() => undefined); }, { once: true });
      const role = current.s.roles[0]!, profile = current.s.profiles[0]!;
      for (const name of ["main", "helper"] as const) {
        const session = await agents.start({ profile, cwd: root, signal: new AbortController().signal,
          callbacks: { onActivity() {}, onPlanStep() {}, async onPermission() { return "deny"; } } }, role);
        const original = session.stop.bind(session); originals.push(original);
        if (closing) { await original(); throw new Error("Controlled session completed after fixture cleanup began"); }
        const observed = spyOn(session, "stop"); restores.push(() => observed.mockRestore());
        observed.mockImplementation(function (this: AgentSession) {
          calls.push(name);
          if (this !== session) throw new Error("Agent stop lost its receiver");
          if (name === "helper") return peer.promise.then(async () => {
            const confirmed = await original(); peerCompleted = true;
            if (mode === "both") throw undefined;
            return confirmed;
          });
          void (reentrant = current.shutdown()).catch(() => undefined);
          if (mode === "throw-error") throw failure;
          if (mode === "throw-undefined") throw undefined;
          if (mode === "reject-error") return Promise.reject(failure);
          if (mode === "reject-undefined") return Promise.reject(undefined);
          return mode === "confirmed" || mode.startsWith("owner-") ? original() : Promise.resolve(false);
        });
        if (name === "main") current.runs.set("shutdown-main", session);
        else current.helperRuns.set("shutdown-helper", new Set([session]));
      }
      if (mode.startsWith("owner-")) {
        const reader = current["profileReader"];
        ownerStops.push(reader.stop.bind(reader));
        const observer = spyOn(reader, "stop"); restores.push(() => observer.mockRestore());
        observer.mockImplementation(function (this: typeof reader) {
          ownerCalls++;
          if (this !== reader) throw new Error("Profile reader stop lost its receiver");
          if (mode === "owner-throw") throw failure;
          return Promise.reject(failure);
        });
      }
      const save = current.save.bind(current), saveObserver = spyOn(current, "save");
      restores.push(() => saveObserver.mockRestore());
      saveObserver.mockImplementation(() => { save(); saved = true; });
      const closeStore = current.store.close.bind(current.store), closeObserver = spyOn(current.store, "close");
      restores.push(() => closeObserver.mockRestore());
      closeObserver.mockImplementation(() => { closeStore(); storeClosed = true; });
      const handed = handoff.promise.then(() => {
        const late = owner.run(current, () => tail.promise.then(() => { writeFileSync(join(root, "late-file.txt"), "finished"); tailCompleted = true; }));
        work.push(late); current.trackWork(late);
      }).finally(() => current.settling.delete("shutdown-handoff"));
      work.push(handed); current.settling.set("shutdown-handoff", handed);
    });
    await setup;
    const current = engine!;
    await owner.run(current, async () => {
      if (released) {
        const sessions = [...current.runs.entries(), ...[...current.helperRuns.entries()].flatMap(([id, runs]) => [...runs].map(run => [id, run] as const))];
        current.runs.clear(); current.helperRuns.clear();
        // The first stop reenters shutdown with both scheduling maps already empty;
        // the helper receipt is registered after that shutdown's initial snapshot.
        for (const [id, session] of sessions) void current.stopAgent(id, session).catch(() => undefined);
        expect(current.runs.size).toBe(0);
        expect(current.helperRuns.size).toBe(0);
      }
      stopping = current.shutdown();
      const repeated = current.shutdown();
      const outcome = stopping.then(() => ({ kind: "value" as const, peerCompleted, tailCompleted }), error => ({ kind: "error" as const, error, peerCompleted, tailCompleted }));
      expect(calls).toEqual(["main", "helper"]);
      expect(ownerCalls).toBe(mode.startsWith("owner-") ? 1 : 0);
      expect(saved).toBe(true);
      expect(storeClosed).toBe(true);
      expect(() => current.store.database.query("SELECT 1").get()).toThrow();
      handoff.release(); await work[0];
      peer.release(); tail.release();
      const observed = await outcome;
      await Promise.allSettled([stopping, repeated, reentrant, aborted]);
      expect(repeated).toBe(stopping);
      expect(reentrant).toBe(stopping);
      expect(aborted).toBe(stopping);
      expect(observed.peerCompleted).toBe(true);
      expect(observed.tailCompleted).toBe(true);
      expect(readFileSync(join(root, "late-file.txt"), "utf8")).toBe("finished");
      expect(current.backgroundWork.size).toBe(0);
      expect(current.copyCleanups.size).toBe(0);
      if (mode === "confirmed") expect(observed.kind).toBe("value");
      else {
        expect(observed.kind).toBe("error");
        if (observed.kind !== "error") throw new Error("Unconfirmed agent cleanup became a successful shutdown");
        if (mode === "false") expect((observed.error as Error).message).toBe("Agent cleanup was not confirmed");
        else if (mode === "both") {
          expect(observed.error).toBeInstanceOf(AggregateError);
          expect((observed.error as AggregateError).errors).toHaveLength(2);
          expect(((observed.error as AggregateError).errors[0] as Error).message).toBe("Agent cleanup was not confirmed");
          expect((observed.error as AggregateError).errors[1]).toBeUndefined();
        } else expect(observed.error).toBe(mode.endsWith("undefined") ? undefined : failure);
      }
    });
    const owned = await owner.close().then(() => ({ kind: "value" as const }), error => ({ kind: "error" as const, error }));
    if (mode === "confirmed") {
      expect(owned.kind).toBe("value");
      expect(existsSync(root)).toBe(false);
    } else {
      expect(owned.kind).toBe("error");
      if (owned.kind !== "error") throw new Error("The canonical owner disposed an unconfirmed Engine root");
      expectedOwnerFailure = { error: owned.error };
      expect(existsSync(root)).toBe(true);
    }
  }, finish);
  await finish();
}, 30_000 * SLOW);
