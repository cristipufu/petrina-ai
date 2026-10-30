import type { Figure } from "./numbers.js";
import type { Tally } from "./worklog.js";

/** New input, reused, written and output. Missing: not reported. */
export interface Detail {
  input?: number;
  cacheRead?: number;
  cacheWrite?: number;
  output?: number;
}

/**
 * Tokens and time for a tally. "At least" only when whole turns are known to be missing. When
 * nothing known adds up to more than zero and work is missing, there is no number at all: it
 * reads "not reported" when a tool sent no figure, and "not known" when the work wasn't
 * recorded (cut off, or from before Petrina kept track). Unknown is never zero.
 */
export function figures(tally: Tally, beforeTracking = false): { tokens: Figure; time: Figure } {
  const tokens: Figure = { atLeast: tally.noTokens > 0 || tally.lost > 0 || beforeTracking };
  if (!tokens.atLeast) tokens.value = tally.tokens;
  else if (tally.reported > 0 && tally.tokens > 0) tokens.value = tally.tokens;
  else if (tally.noTokens === 0) tokens.unknown = true;
  const time: Figure = { atLeast: tally.lost > 0 || beforeTracking };
  if (!time.atLeast) time.value = tally.workMs;
  else if (tally.timed > 0 && tally.workMs > 0) time.value = tally.workMs;
  else time.unknown = true;
  return { tokens, time };
}
