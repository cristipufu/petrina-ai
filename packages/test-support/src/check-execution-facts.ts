/** Explicit scenario data for a completed native command, never inferred from a saved report. */
export function completeCheckExecution(code: number) {
  return {
    started: true,
    exit: { status: "reported" as const, code },
    stdout: "eof" as const,
    stderr: "eof" as const,
    timedOut: false,
    cancelled: false,
    cleanup: "not-requested" as const,
    outputCleanup: "not-requested" as const,
  };
}
