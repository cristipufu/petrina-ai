import { CLEANUP_MS, CommandFailure, type CommandResult } from "./commands.js";
import { currentSlow } from "./slow.js";

export type CommandSettlement = { kind: "completed"; result: CommandResult }
  | { kind: "stopped"; failure: CommandFailure };
export interface StoppingCommand {
  /** Only the canonical runner's fully drained result, never a raw child exit notification. */
  result: Promise<CommandResult>;
  /** Request the canonical runner's existing bounded cleanup while it still owns the command. */
  abort(): void;
}

/** After a separately owned stop request, allow actual completion before forcing the command's existing cleanup. */
export async function settleCommandAfterStop(command: StoppingCommand, allowanceMs = CLEANUP_MS * currentSlow()): Promise<CommandSettlement> {
  const result = Promise.resolve(command.result);
  // Invalid input or a thrown abort must not leave a later native rejection unobserved.
  void result.catch(() => undefined);
  if (!(Number.isFinite(allowanceMs) && allowanceMs >= 0 && allowanceMs <= 2_147_483_647))
    throw new RangeError("Command settlement needs a finite allowance between zero and 2147483647 milliseconds");
  const settlement: Promise<CommandSettlement> = result.then(
    completed => {
      if (!Number.isSafeInteger(completed?.code) || completed.code < 0)
        throw new TypeError("The canonical command did not report a valid completed exit code");
      return { kind: "completed", result: completed };
    },
    error => {
      if (error instanceof CommandFailure && error.cleanup === "confirmed") return { kind: "stopped", failure: error };
      throw error;
    },
  );
  const expired = Symbol("command settlement allowance ended");
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const outcome = await Promise.race([settlement, new Promise<typeof expired>(resolve => { timer = setTimeout(() => resolve(expired), allowanceMs); })]);
    if (outcome !== expired) return outcome;
    command.abort();
    return await settlement;
  } finally { clearTimeout(timer); }
}
