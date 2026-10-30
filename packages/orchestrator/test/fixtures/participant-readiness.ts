import { changeRuntimeWait, checkOf, runtimeWaitHolds, runtimeWaitWords, runtimeWaitView, type CheckId, type ToolCheck } from "@petrina/core";
import { SavedParticipantReadiness } from "../../src/saved-participant-readiness.js";
import { ToolCheckCoordinator } from "../../src/tool-checks.js";
import { executionFor } from "../../src/repository-context.js";
import type { RuntimeTask } from "../../src/model.js";
import type { ToolProbeRequest, ToolProbeResult } from "../../src/ports/tool-checks.js";
import { admissionFixture } from "./agent-workflow.js";
import { deferred } from "./tool-checks.js";
import { waitDuring } from "./clock.js";
import type { ScriptedAgents } from "./scripted-agents.js";

/** One state, scheduler and actual readiness/check owners; probes are explicit supplied observations. */
export function participantReadinessFixture(limit = 2, agents?: ScriptedAgents) {
  const f = admissionFixture(limit, limit, 3, agents), current = f.task(f.ids[0]!)!, scope = executionFor(current);
  const prerequisite = f.task(f.ids[1]!)!, queued = f.task(f.ids[2]!)!;
  for (const task of f.state.tasks) { task.state = "backlog"; task.held = true; }
  f.state.pool.paused = false;
  f.state.setup!.checks = f.state.tools.map(tool => ({ id: tool.id as CheckId, status: "ready", at: f.clock.now() }));
  const stop = new AbortController(), scripts = new Map<CheckId, (request: ToolProbeRequest) => Promise<ToolProbeResult>>();
  const unexpected: Error[] = [];
  const probes: { id: CheckId; request: ToolProbeRequest }[] = [], published: ToolCheck[] = [], notes: string[] = [];
  const bound = (task: RuntimeTask) => { if (f.task(task.id) !== task) throw new Error("Readiness received a noncanonical task"); };
  const checks = new ToolCheckCoordinator({
    stopped: () => stop.signal.aborted,
    current: id => checkOf(f.state.setup!.checks, id),
    publish(check) {
      const next = { ...check }; if (!next.checking) delete next.checking;
      f.state.setup!.checks = [...f.state.setup!.checks.filter(item => item.id !== check.id), next];
      const tool = f.state.tools.find(tool => tool.id === check.id);
      if (tool && ["ready", "logged-out", "not-installed"].includes(next.status)) tool.status = next.status as "ready" | "logged-out" | "not-installed";
      published.push(structuredClone(next)); f.host.changed();
    },
  }, {
    absent: () => false,
    async run(id, request) {
      probes.push({ id, request });
      const run = scripts.get(id); if (!run) { const error = new Error(`Unexpected readiness probe ${id}`); unexpected.push(error); throw error; }
      scripts.delete(id); return run(request);
    },
  }, f.clock);
  f.host.admissionsClosed = task => stop.signal.aborted || f.state.pool.paused || runtimeWaitHolds(task);
  f.host.admissionWait = task => runtimeWaitHolds(task) ? runtimeWaitWords(runtimeWaitView(task, id => f.host.taskDetails(id))!) : "Waiting for the pool to resume";
  f.groupHost.admissionsClosed = f.host.admissionsClosed;
  f.groupHost.admissionWait = f.host.admissionWait;
  const readiness = new SavedParticipantReadiness({
    state: () => f.state, activeState: f.snapshot, stopped: () => stop.signal.aborted, stopSignal: stop.signal,
    limitMs: () => 11_000, profile: f.catalog.profile, role: f.catalog.role, admissionsClosed: f.host.admissionsClosed,
    column: f.host.column, note(value, _kind, text) { bound(value.task); if (executionFor(value.task).work !== value.work) throw new Error("Readiness received a noncanonical execution"); notes.push(text); },
    checkpoint(subject) { bound("task" in subject ? subject.task : subject); f.host.changed(); }, schedule: () => f.host.schedule(),
  }, checks, { now: f.clock.now, after: (ms, done) => f.clock.after(ms, () => { done(); return undefined; }) });
  for (const method of ["hold", "open", "resolve", "resolveHeld", "yieldHeld", "charge"] as const) Object.assign(f.readiness, { [method]: readiness[method].bind(readiness) });
  const operations = new Set<Promise<unknown>>();
  const own = <T>(body: () => Promise<T>): Promise<T> => {
    const work = Promise.resolve().then(body); operations.add(work);
    void work.then(() => operations.delete(work), () => operations.delete(work)); return work;
  };
  const errors = () => { if (f.failures.length || f.driverErrors.length) throw new AggregateError([...f.failures, ...f.driverErrors.map(entry => entry.error)], "Readiness composition failed"); };
  return { ...f, current, scope, prerequisite, queued, stop, checks, readinessController: readiness, probes, published, notes, own,
    check: (id: CheckId) => checkOf(f.state.setup!.checks, id),
    uncertain(id: CheckId) { const check = checkOf(f.state.setup!.checks, id); check.status = "unknown"; check.at = f.clock.now() - 600_000; },
    holdProbe(id: CheckId) {
      if (scripts.has(id)) throw new Error("A readiness probe recipe is already pending");
      const result = deferred<ToolProbeResult>();
      scripts.set(id, async request => {
        const abort = () => result.resolve({ status: "unknown", detail: "Supplied probe stopped" });
        request.signal.addEventListener("abort", abort, { once: true }); if (request.signal.aborted) abort();
        try { return await result.promise; } finally { request.signal.removeEventListener("abort", abort); }
      });
      return { entered: (during: PromiseLike<unknown>) => waitDuring(() => probes.some(probe => probe.id === id), during, `the supplied ${id} probe`),
        answer: (status: ToolProbeResult["status"] = "ready") => result.resolve({ status }) };
    },
    hold(after = [prerequisite.id]) { changeRuntimeWait(current, { after, reason: "Finish the required source" }, f.clock.now()); f.workflow.syncRuntimeWaits(); },
    clear() { changeRuntimeWait(current, { after: [], reason: "Continue the review" }, f.clock.now()); f.workflow.syncRuntimeWaits(); },
    waitFor<T>(check: () => T | undefined | false, during: PromiseLike<unknown>, what: string) { return waitDuring(() => { errors(); return check(); }, during, what); },
    async close() {
      stop.abort(); readiness.stop();
      // Stop check observations and all drivers before awaiting their bodies; no test can leave a held probe or member behind.
      const results = await Promise.allSettled([checks.shutdown(), f.close(), ...operations]);
      const failed = results.flatMap(result => result.status === "rejected" && f.errors.classify(result.reason).kind !== "abort" ? [result.reason] : []);
      if (failed.length || unexpected.length) throw new AggregateError([...failed, ...unexpected], "Readiness fixture ownership failed to settle");
      if (checks.pending().checking.length || f.clock.pending.size) throw new Error("Readiness fixture retained a check or deadline");
    },
  };
}
