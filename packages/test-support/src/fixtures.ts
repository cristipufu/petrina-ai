import { mkdtempSync, rmSync } from "node:fs";
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
