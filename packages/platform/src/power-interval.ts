export interface MachineInterruption { source: "macOS power log"; at: number; event: string }

/** Match recorded sleep intervals, never a timeout, idle gap or a Builder explanation. */
export function powerInterruption(startedAt: number | undefined, endedAt: number | undefined, records: string): MachineInterruption | undefined {
  if (startedAt === undefined || endedAt === undefined || endedAt < startedAt) return undefined;
  const events = records.split(/\r?\n/).flatMap((line) => {
    const match = line.match(/^(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d [+-]\d{4})\s+(Sleep|Wake|DarkWake)\s+(.+)$/);
    if (!match) return [];
    const at = Date.parse(match[1]!);
    return Number.isFinite(at) ? [{ at, kind: match[2]!, text: match[3]!.trim() }] : [];
  }).sort((a, b) => a.at - b.at);
  for (const [index, event] of events.entries()) {
    if (event.kind !== "Sleep" || !event.text.startsWith("Entering Sleep state")) continue;
    const seconds = event.text.match(/\b(\d+) secs\b/);
    const wake = events.slice(index + 1).find((entry) => entry.kind === "Wake" || entry.kind === "DarkWake");
    const end = seconds ? event.at + Number(seconds[1]) * 1000 : wake?.at;
    if (end !== undefined && end > event.at && event.at < endedAt && end > startedAt) return {
      source: "macOS power log",
      at: event.at,
      event: event.text.slice(
      0,
      400
    )
    };
  }
  return undefined;
}
