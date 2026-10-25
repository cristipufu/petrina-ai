import type { CheckExecution, CheckRun } from "./model.js";

/** Success needs complete native observations; absent or contradictory facts establish no pass. */
export function checkExecutionPassed(execution: CheckExecution | undefined): boolean {
  return execution !== undefined && execution.started === true && execution.exit?.status === "reported" && execution.exit.code === 0
    && execution.exit.signal === undefined && execution.stdout === "eof" && execution.stderr === "eof"
    && execution.timedOut === false && execution.cancelled === false && execution.failure === undefined
    && (execution.cleanup === "not-requested" || execution.cleanup === "confirmed")
    && (execution.outputCleanup === "not-requested" || execution.outputCleanup === "confirmed");
}

type ReportedCheck = { readonly reportedOk?: boolean };
export type CheckIncompleteReason = "stopped" | "cancelled" | "timed-out" | "machine-interruption" | "read-failed" | "output-incomplete" | "exit-unreported" | "exit-rejected" | "invalid-exit" | "signalled" | "cleanup-unconfirmed" | "observation-failed" | "native-evidence-missing" | "native-evidence-invalid" | "contradictory-result";
export type CheckOutcome = ReportedCheck & (
  | { readonly kind: "passed"; readonly reason: "complete"; readonly code: 0 }
  | { readonly kind: "failed"; readonly reason: "command-failed"; readonly code: number }
  | { readonly kind: "unavailable"; readonly reason: "not-recorded" | "start-failed" }
  | { readonly kind: "incomplete"; readonly reason: CheckIncompleteReason }
);

function recordedExecution(execution: CheckExecution): boolean {
  return typeof execution.started === "boolean" && typeof execution.timedOut === "boolean" && typeof execution.cancelled === "boolean"
    && ["incomplete", "eof", "read-error"].includes(execution.stdout) && ["incomplete", "eof", "read-error"].includes(execution.stderr)
    && ["not-requested", "confirmed", "unconfirmed"].includes(execution.cleanup) && ["not-requested", "confirmed", "unconfirmed"].includes(execution.outputCleanup)
    && !!execution.exit && ["unreported", "reported", "rejected", "invalid"].includes(execution.exit.status)
    && (execution.exit.status === "reported" ? Number.isSafeInteger(execution.exit.code) && execution.exit.code! >= 0 : execution.exit.code === undefined)
    && (execution.exit.signal === undefined || typeof execution.exit.signal === "string" && execution.exit.signal.length > 0)
    && (execution.failure === undefined || execution.failure !== null && typeof execution.failure === "object" && ["start", "observer", "read", "output", "exit"].includes(execution.failure.kind) && typeof execution.failure.message === "string");
}

/** One execution meaning for routing and reads. Historical reports remain facts, never invented proof. */
export function checkOutcome(run?: CheckRun): CheckOutcome {
  const reported = run && typeof run.ok === "boolean" ? { reportedOk: run.ok } : {};
  const incomplete = (reason: CheckIncompleteReason): CheckOutcome => ({ ...reported, kind: "incomplete", reason });
  if (!run) return { kind: "unavailable", reason: "not-recorded" };
  if ([run.timedOut, run.interrupted, run.cleanupIncomplete].some(value => value !== undefined && typeof value !== "boolean")
    || run.exitSignal !== undefined && (typeof run.exitSignal !== "string" || !run.exitSignal.length)
    || run.interruption !== undefined && (run.interruption === null || typeof run.interruption !== "object"
      || typeof run.interruption.source !== "string" || !run.interruption.source.length || typeof run.interruption.event !== "string"
      || !Number.isFinite(run.interruption.at))) return incomplete("native-evidence-invalid");
  const execution = run.execution;
  if (run.interruption) return incomplete("machine-interruption");
  if (run.timedOut === true) return incomplete("timed-out");
  if (run.cleanupIncomplete === true) return incomplete("cleanup-unconfirmed");
  if (!execution) return incomplete(run.exitSignal ? "signalled" : run.interrupted ? "stopped" : "native-evidence-missing");
  if (!recordedExecution(execution)) return incomplete("native-evidence-invalid");
  if (execution.timedOut) return incomplete("timed-out");
  if (execution.cancelled) return incomplete("cancelled");
  if (run.cleanupIncomplete || execution.cleanup === "unconfirmed" || execution.outputCleanup === "unconfirmed") return incomplete("cleanup-unconfirmed");
  if (!execution.started) return execution.failure?.kind === "start" && execution.exit.status === "unreported"
    ? { ...reported, kind: "unavailable", reason: "start-failed" } : incomplete("native-evidence-invalid");
  if (execution.failure?.kind === "read" || execution.stdout === "read-error" || execution.stderr === "read-error") return incomplete("read-failed");
  if (execution.failure?.kind === "output") return incomplete("output-incomplete");
  if (execution.failure?.kind === "observer") return incomplete("observation-failed");
  if (execution.exit.status === "rejected") return incomplete("exit-rejected");
  if (execution.exit.status === "invalid") return incomplete("invalid-exit");
  if (execution.exit.status === "unreported" || execution.failure?.kind === "exit") return incomplete("exit-unreported");
  if (execution.exit.signal || run.exitSignal) return incomplete("signalled");
  if (run.interrupted) return incomplete("stopped");
  if (execution.stdout !== "eof" || execution.stderr !== "eof") return incomplete("output-incomplete");
  if (execution.failure) return incomplete("native-evidence-invalid");
  if (checkExecutionPassed(execution)) return run.ok === true
    ? { ...reported, kind: "passed", reason: "complete", code: 0 } : incomplete("contradictory-result");
  return execution.exit.code! > 0 && run.ok === false
    ? { ...reported, kind: "failed", reason: "command-failed", code: execution.exit.code! } : incomplete("contradictory-result");
}

/** Plain words describe the observed result without turning missing execution into a code failure. */
export function checkOutcomeLabel(outcome: CheckOutcome): string {
  if (outcome.kind === "passed") return "passed";
  if (outcome.kind === "failed") return "failed";
  if (outcome.kind === "unavailable") return outcome.reason === "not-recorded" ? "not recorded" : "could not start";
  const words: Record<CheckIncompleteReason, string> = {
    stopped: "stopped", cancelled: "stopped", "timed-out": "did not finish", "machine-interruption": "interrupted — verification incomplete",
    "read-failed": "output could not be read", "output-incomplete": "output did not finish", "exit-unreported": "exit was not reported",
    "exit-rejected": "exit could not be confirmed", "invalid-exit": "exit could not be confirmed", signalled: "ended by a signal",
    "cleanup-unconfirmed": "cleanup is unconfirmed", "observation-failed": "execution could not be recorded",
    "native-evidence-missing": "unverified — execution details were not recorded", "native-evidence-invalid": "unverified — execution details are incomplete",
    "contradictory-result": "unverified — recorded results disagree",
  };
  return words[outcome.reason];
}

export const CHECK_EXIT_UNREPORTED = "The check ended, but the system did not report its exit, so whether it passed is unknown.";

/** Diagnostic prose never supplies an execution fact, including on older saved reports. */
export function unreportedCheckExit(run: CheckRun): boolean {
  const outcome = checkOutcome(run);
  return outcome.kind === "incomplete" && outcome.reason === "exit-unreported";
}
export const checkCommandOutcome = (run?: CheckRun) => {
  const outcome = checkOutcome(run);
  return outcome.kind === "incomplete" ? outcome.reason === "exit-unreported" || outcome.reason === "native-evidence-missing" ? "unknown" : "unfinished" : outcome.kind;
};
