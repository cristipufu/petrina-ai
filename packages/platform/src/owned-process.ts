import type { ProcessDeadline } from "./process-capabilities.js";

/** A process handle whose owner retains the native end record; no PID signalling is needed. */
export interface OwnedProcess {
  readonly exited: Promise<number>;
  readonly exitCode?: number | null;
  readonly signalCode?: string | null;
  kill(signal: "SIGTERM" | "SIGKILL"): unknown;
}

export type OwnedProcessCleanup = "confirmed" | "unconfirmed";

/** Stop only this owned handle, with independent bounds for graceful and forced completion. */
export async function stopOwnedProcess(child: OwnedProcess, budgets: { graceMs: number; forceMs: number }, arm: ProcessDeadline): Promise<OwnedProcessCleanup> {
  const { graceMs, forceMs } = budgets;
  for (const ms of [graceMs, forceMs]) {
    if (!(ms > 0 && ms <= 2_147_483_647)) throw new RangeError("Owned-process cleanup needs bounded positive deadlines.");
  }
  let reported = false;
  // A rejected/lost completion is unavailable evidence; a native end record can still confirm it.
  const unavailable = () => new Promise<void>(() => {});
  const exited = child.exited.then(code => {
    if (Number.isInteger(code)) reported = true;
    else return unavailable();
  }, unavailable);
  const ended = () => {
    const code = child.exitCode, signal = child.signalCode;
    return reported || Number.isInteger(code) || (typeof signal === "string" && signal.length > 0);
  };
  const wait = async (ms: number): Promise<boolean> => {
    if (ended()) return true;
    let cancel = () => {};
    try { await Promise.race([exited, new Promise<void>(resolve => { cancel = arm(resolve, ms); })]); }
    finally { cancel(); }
    return ended();
  };
  if (ended()) return "confirmed";
  try { child.kill("SIGTERM"); } catch { /* A signal is not completion evidence. */ }
  if (await wait(graceMs)) return "confirmed";
  // The native end record is read again immediately before signalling through the owned handle.
  if (!ended()) try { child.kill("SIGKILL"); } catch { /* Confirmation still needs an end record. */ }
  return await wait(forceMs) ? "confirmed" : "unconfirmed";
}
