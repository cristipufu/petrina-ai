import { SavedParticipantReadiness } from "@petrina/orchestrator";
import type { Kernel } from "./kernel.js";
import { readinessLimitMs, type ToolChecks } from "./tool-checks.js";

export type { SelectionReadiness as ReadinessNeed } from "@petrina/orchestrator";

/** Engine composition of saved-participant decisions, native tool checks and the live clock. */
export class Readiness extends SavedParticipantReadiness {
  constructor(k: Kernel, tools: ToolChecks) {
    super({
      state: () => k.s, activeState: () => k.activeState(), stopped: () => k.stopped, stopSignal: k.stopRequested.signal,
      limitMs: () => readinessLimitMs(k.options.toolCheckTimeoutMs), profile: id => k.profile(id), role: (id, task) => k.role(id, task),
      admissionsClosed: task => k.taskAdmissionsClosed(task), column: task => k.columnFor(task),
      note: (scope, kind, text) => k.log(scope, kind, text), checkpoint: subject => k.commitNow(subject), schedule: () => k.schedule(),
    }, tools, {
      now: () => Date.now(),
      after: (ms, done) => { const timer = setTimeout(done, ms); return () => { clearTimeout(timer); }; },
    });
  }
}
