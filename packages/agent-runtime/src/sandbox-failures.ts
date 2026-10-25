/**
 * Claude Code's own words when a required sandbox is not available on this system: an unsupported system,
 * Windows without it switched on, or missing programs. Broken sandbox settings (a product's own Claude Code
 * settings, say) are not this: Claude Code keeps the conversation sandboxed and refuses its commands with its
 * own message ("failed to initialize"), and Petrina keeps the sandbox on for everyone else.
 */
const CANNOT_START = /Sandbox required but unavailable(?::\s*)?([^]*)/i;

/** Claude Code could not start its sandbox, so the conversation did not open. The reason is plain words. */
export class SandboxUnavailable extends Error {
  constructor(readonly reason: string) {
    super(`Claude Code's sandbox could not start: ${reason}`);
  }
}

/**
 * The plain reason when an error from opening a conversation is Claude Code refusing to start without
 * its sandbox. The connector reports it as an internal error with Claude Code's message in its details,
 * for a new conversation and a reopened one alike.
 */
export function sandboxFailure(error: unknown): string | undefined {
  const parts: string[] = [];
  if (error instanceof Error) parts.push(error.message);
  const data = (error as { data?: unknown } | undefined)?.data;
  if (typeof data === "string") parts.push(data);
  else if (data && typeof data === "object") parts.push(...Object.values(data).filter((value): value is string => typeof value === "string"));
  const match = CANNOT_START.exec(parts.join("\n"));
  return match ? plainReason(match[1] ?? "") : undefined;
}

function plainReason(said: string): string {
  const text = said.replace(/\.?\s*Set sandbox\.failIfUnavailable=false[^]*$/i, "").trim();
  const missing = /dependencies are missing: ([^·\n]+)/i.exec(text)?.[1]?.trim();
  if (missing) return `this computer lacks what it needs (${missing})`;
  if (/windows sandbox is not active/i.test(text)) return "it is not switched on for Windows on this computer";
  if (/is not supported/i.test(text)) return "it does not run on this system";
  const short = text.length > 160 ? `${text.slice(0, 159).trimEnd()}…` : text;
  return short ? `Claude Code could not start it (${short})` : "Claude Code could not start it";
}
