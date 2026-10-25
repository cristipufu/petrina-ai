import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { shortTempParent, TEST_BROWSERS } from "./temp-parent.js";
import { currentSlow } from "./slow.js";
import { completionOf, completedBeforeProgress, waitForProgress, type ProgressClock } from "./progress-wait.js";

/** Private writable state under the current runner's owned temporary parent. */
export function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** Windows can retain handles briefly after exit; the outer runner also owns final reclamation. */
export function removeDir(path: string): void {
  try {
    rmSync(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch {
    // Left for the system's temp cleanup.
  }
}

const progressClock: ProgressClock = {
  now: () => Date.now(),
  slow: currentSlow,
  arm(expired, ms) { const timer = setTimeout(expired, ms); return () => clearTimeout(timer); },
  sleep: ms => Bun.sleep(ms),
};

export function waitFor<T>(check: () => T | undefined | false | Promise<T | undefined | false>, what: string, ms = 30_000, options: { during?: PromiseLike<unknown> } = {}): Promise<T> {
  return waitForProgress(check, what, ms, options, progressClock);
}

/** A fixture's progress must arrive before its owning operation finishes; completion is not progress. */
export async function waitForFile(path: string, { timeoutMs = 60_000, during }: { timeoutMs?: number; during?: PromiseLike<unknown> } = {}): Promise<void> {
  const owner = completionOf(during);
  const started = Date.now();
  while (!existsSync(path)) {
    const completed = owner?.current();
    if (completed) completedBeforeProgress(completed, "The operation completed before its progress file appeared: " + path);
    if (Date.now() - started > timeoutMs * currentSlow()) throw new Error("Timed out waiting for " + path);
    await Bun.sleep(30);
  }
}

/** Read the first reported readiness line. */
export async function firstLine(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = "";
  while (!text.includes("\n")) {
    const { value, done } = await reader.read();
    if (done) break;
    text += decoder.decode(value);
  }
  reader.releaseLock();
  return text.split("\n")[0]!;
}

/**
 * A fixture's own parent for temporary browser folders, instead of the user's standard one. Run
 * folders can be too long for macOS browser sockets, so the runner owns a short folder for these and
 * reclaims it even after an interrupted run; a standalone script gets one in the system's short
 * temporary folder. Pass it to every engine, browser and recovery of the fixture, and remove it once
 * they have stopped. It is spelled as browser sessions and recovery canonicalize their folders: on
 * Windows only native resolution expands a short name such as RUNNER~1 to the full one.
 */
export function testBrowserRoot(): string {
  const owned = process.env[TEST_BROWSERS];
  return realpathSync.native(mkdtempSync(owned ? `${owned}${sep}` : join(shortTempParent(), "pb-")));
}
