import { spyOn } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentSession, AgentSessionOptions } from "@petrina/orchestrator";
import { executionFor } from "@petrina/orchestrator";
import { setupWithCleanup } from "@petrina/test-support/setup-with-cleanup";
import { Engine } from "../engine.js";
import { createProductRepository, tempDir } from "../fixtures.js";
import { ScriptedAgents, scriptedResult } from "../scripted-agents.js";
import { scriptedToolProbe } from "../scripted-probes.js";
import { changesOf, versionsOf } from "../../src/repositories.js";
import { directDrivers, removeFixtureRoot } from "./direct-drivers.js";

export type StopReply = "confirmed" | "false" | "reject-error" | "reject-undefined";
export type Observed<T> = { kind: "value"; value: T } | { kind: "error"; error: unknown };
const observed = <T>(work: Promise<T>): Promise<Observed<T>> => work.then(value => ({ kind: "value", value }), error => ({ kind: "error", error }));

/** Actor-free provider sessions; only the main read-only restoration cases need real private Git. */
export function turnCleanupFixtures() {
  const closers = new Set<() => Promise<void>>();
  async function fixture(input: { stop?: StopReply; bodyFailure?: { error: unknown }; nativeOpening?: true; reply?: ConstructorParameters<typeof ScriptedAgents>[0] } = {}) {
    const root = tempDir("petrina-turn-cleanup-"), owner = directDrivers(root), abort = new AbortController();
    const restores: (() => void)[] = [], originalStops: (() => Promise<boolean>)[] = [], operations: Promise<unknown>[] = [];
    const cleanupFailure = new Error("The actual scripted session's stop rejected");
    let engine: Engine | undefined, setup: Promise<unknown> | undefined, closing: Promise<void> | undefined;
    let expectedOwnerFailure: { error: unknown } | undefined, storeClosed = false, closeStore: (() => void) | undefined;
    let admissionClosed = false, prompts = 0, stopCalls = 0;
    const restore = (undo: () => void) => restores.push(undo);
    const finish = (): Promise<void> => {
      admissionClosed = true; abort.abort();
      if (closing) return closing;
      const done = Promise.withResolvers<void>(); closing = done.promise;
      void (async () => {
        const failures: unknown[] = [];
        // Setup and every late session are owned before their awaits. Original bound stops are
        // independent of the deliberately false/rejected subject stop and name no native process.
        await Promise.allSettled([setup]);
        const sessions = await Promise.allSettled(originalStops.map(stop => stop()));
        for (const result of sessions) {
          if (result.status === "rejected") failures.push(result.reason);
          else if (result.value !== true) failures.push(new Error("Original scripted-session cleanup was not confirmed"));
        }
        await Promise.allSettled(operations);
        const owned = await observed(owner.close());
        if (owned.kind === "error" && (!expectedOwnerFailure || !Object.is(owned.error, expectedOwnerFailure.error))) failures.push(owned.error);
        // A negative subject shutdown must already have closed its real databases. On an earlier
        // assertion/setup failure independently close them, but do not accept an unknown owner result.
        if (engine && !storeClosed) {
          try { engine.tracking.close(); } catch (error) { failures.push(error); }
          try { closeStore!(); storeClosed = true; } catch (error) { failures.push(error); }
        }
        for (const undo of restores) try { undo(); } catch (error) { failures.push(error); }
        if (engine && !storeClosed) failures.push(new Error("Actual Store remains open; root retained"));
        if (failures.length) throw new AggregateError(failures, "Turn-cleanup fixture could not confirm independent cleanup; root retained");
        // Only an asserted canonical owner failure, plus stopped original actor-free sessions and
        // the actual closed Store, permits independent disposal of a deliberately retained root.
        removeFixtureRoot(root);
      })().then(done.resolve, done.reject);
      void closing.then(() => closers.delete(finish), () => undefined);
      return closing;
    };
    closers.add(finish);
    return setupWithCleanup(async () => {
      const starting = owner.prepare(async () => {
        const agents = new ScriptedAgents((prompt, signal, callbacks) => {
          prompts++;
          if (input.reply) return input.reply(prompt, signal, callbacks);
          writeFileSync(join(prompt.cwd, "README.md"), "Changed by the read-only Tester\n");
          if (input.bodyFailure) throw input.bodyFailure.error;
          return scriptedResult({ summary: "The controlled acceptance hand-back is complete", checks: [], learnings: [] });
        });
        const start = async (options: AgentSessionOptions, role: Parameters<typeof agents.start>[1]): Promise<AgentSession> => {
          const session = await agents.start(options, role), stop = session.stop.bind(session);
          originalStops.push(stop);
          if (admissionClosed) { await stop(); throw new Error("Scripted session completed after fixture admission closed"); }
          const observer = spyOn(session, "stop"); restore(() => observer.mockRestore());
          observer.mockImplementation(function (this: AgentSession) {
            if (this !== session) throw new Error("The actual session stop lost its receiver");
            stopCalls++;
            if (input.stop === "false") return Promise.resolve(false);
            if (input.stop === "reject-error") return Promise.reject(cleanupFailure);
            if (input.stop === "reject-undefined") return Promise.reject(undefined);
            return stop();
          });
          return session;
        };
        const current = engine = owner.open(join(root, "data"), {
          agentCommand: () => [join(root, "unconfigured-agent-must-never-launch")],
          ...(input.nativeOpening ? {} : { startAgentSession: start }),
          toolProbe: scriptedToolProbe({ gh: { status: "ready" }, git: { status: "ready" },
            codex: { status: "ready" }, "claude-code": { status: "ready" }, grok: { status: "ready" }, antigravity: { status: "not-installed" }, opencode: { status: "not-installed" }, pi: { status: "not-installed" } }),
        });
        current.schedule = () => {};
        closeStore = current.store.close.bind(current.store);
        const storeObserver = spyOn(current.store, "close"); restore(() => storeObserver.mockRestore());
        storeObserver.mockImplementation(() => { closeStore!(); storeClosed = true; });
        await current.waitUntilReady(); await Promise.all([...current.backgroundWork]); await current.checkTools();
        if (admissionClosed) throw new Error("Fixture closed during Engine setup");
        const repository = input.nativeOpening ? undefined : await createProductRepository(root, { origin: "none" });
        const repo = repository?.path;
        if (admissionClosed) throw new Error("Fixture closed during repository setup");
        current.s.products.push({ id: "p", name: "Product", repo: "local/product", path: repo, defaultBranch: "main", tone: "blue", checks: [], checksBy: "coordinator" });
        const task = current.task(current.addTask({ productId: "p", title: "Check the read-only product", backlog: true }))!, scope = executionFor(task);
        task.plan = { rationale: "Direct actual acceptance turn", plannerProfileId: "opus-high", stages: [{ id: "acceptance", kind: "do", title: "Acceptance", roleId: "tester", profileIds: ["opus-high"] }] };
        task.stageIndex = 0; task.state = "running"; task.retest = true;
        if (repository) {
          Object.assign(scope.work, { worktree: repo, branch: "main", base: "main", baseSha: repository.initialSha });
          task.acceptanceRun = { versions: await versionsOf(task), changes: await changesOf(task), requestIds: [] };
        }
        current.s.pool.paused = false;
        const observe = <T>(start: () => Promise<T>): Promise<Observed<T>> => {
          const work = owner.run(current, () => observed(start())); operations.push(work); return work;
        };
        return { root, owner, engine: current, task, scope, repo, agents, start, abort, cleanupFailure, restore, observe,
          get prompts() { return prompts; }, get stopCalls() { return stopCalls; }, get storeClosed() { return storeClosed; },
          closeSubject: () => observed(owner.close()),
          acknowledgeRetained(result: Observed<void>, expected: unknown) {
            if (result.kind !== "error") throw new Error("Expected the canonical owner to retain the subject failure");
            // Canonical owner layers may wrap their single failing stop. Additional failures,
            // changed raw errors and undefined-vs-absence must never authorize disposal.
            let failure = result.error;
            while (!Object.is(failure, expected) && failure instanceof AggregateError && failure.errors.length === 1) failure = failure.errors[0];
            if (!Object.is(failure, expected)) throw new Error("Unexpected owner cleanup failure; root retained", { cause: result.error });
            expectedOwnerFailure = { error: result.error };
          }, finish };
      });
      setup = starting;
      return await starting;
    }, finish);
  }
  return { fixture, close: async () => {
    const results = await Promise.allSettled([...closers].map(close => close()));
    const failures = results.flatMap(result => result.status === "rejected" ? [result.reason] : []);
    if (failures.length) throw new AggregateError(failures, "Turn-cleanup fixtures remain uncertain");
  } };
}
