import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { currentSlow } from "./slow.js";

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

export async function waitFor<T>(check: () => T | undefined | false | Promise<T | undefined | false>, what: string, ms = 30_000): Promise<T> {
  const started = Date.now();
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() - started > ms * currentSlow()) throw new Error(`Timed out waiting for ${what}`);
    await Bun.sleep(50);
  }
}

/** A fixture's progress must arrive before its owning operation finishes; completion is not progress. */
export async function waitForFile(path: string, { timeoutMs = 60_000, during }: { timeoutMs?: number; during?: PromiseLike<unknown> } = {}): Promise<void> {
  let completed: { error?: unknown } | undefined;
  if (during) void Promise.resolve(during).then(() => { completed = {}; }, error => { completed = { error }; });
  const started = Date.now();
  while (!existsSync(path)) {
    if (completed) {
      if ("error" in completed) throw completed.error;
      throw new Error(`The operation completed before its progress file appeared: ${path}`);
    }
    if (Date.now() - started > timeoutMs * currentSlow()) throw new Error(`Timed out waiting for ${path}`);
    await Bun.sleep(30);
  }
}
