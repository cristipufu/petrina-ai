import { runCommand, startCommand, type CommandOptions, type CommandResult, type Started } from "./commands.js";

/** One suite execution's outer bound; individual test limits and caller-supplied focused limits stay unchanged. */
export const SUITE_RUN_TIMEOUT_MS = 35 * 60_000;
export const INTERRUPT_GRACE_MS = 5_000;
type InterruptSignal = "SIGINT" | "SIGTERM";
export type ProcessOutcome = { kind: "exited"; result: CommandResult }
  | { kind: "interrupted"; signal: InterruptSignal; result: CommandResult };
export interface ProcessRunOptions extends Omit<CommandOptions, "signal"> {
  /** Forward SIGINT/SIGTERM, then force bounded cleanup if the process does not settle. */
  signal?: AbortSignal;
  interruptGraceMs?: number;
}

/** Own the command to settlement, preserving a graceful interrupt without trusting an unbounded exit promise. */
export async function runProcess(argv: readonly string[], options: ProcessRunOptions): Promise<ProcessOutcome> {
  const { signal, interruptGraceMs, ...command } = options;
  const graceMs = interruptGraceMs ?? INTERRUPT_GRACE_MS;
  if (!(graceMs >= 0 && graceMs <= 2_147_483_647 && Number.isFinite(graceMs))) throw new RangeError("The interrupt grace must be between 0 and 2147483647 ms");
  const forced = new AbortController();
  let child: Started | undefined;
  let requested: InterruptSignal | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const interrupt = () => {
    requested = signal?.reason === "SIGINT" ? "SIGINT" : "SIGTERM";
    if (!child?.interrupt || child.exitCode != null || child.signalCode != null) {
      forced.abort();
      return;
    }
    try { child.interrupt(requested); } catch { /* Force cleanup after the grace when a signal is unavailable. */ }
    timer ??= setTimeout(() => forced.abort(), graceMs);
  };
  signal?.addEventListener("abort", interrupt, { once: true });
  if (signal?.aborted) interrupt();
  try {
    const result = await runCommand(
      argv,
      {
      ...command,
      signal: forced.signal,
      start: (
      args,
      settings
    ) => child = (command.start ?? startCommand)(
      args,
      settings
    )
    }
    );
    return requested ? { kind: "interrupted", signal: requested, result } : { kind: "exited", result };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", interrupt);
  }
}
