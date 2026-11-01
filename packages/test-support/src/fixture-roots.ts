import { lstatSync, rmSync } from "node:fs";

const RETRYABLE_RM_CODES = new Set(["EBUSY", "EMFILE", "ENFILE", "ENOTEMPTY", "EPERM"]);

/** Bun's Windows rmSync does not honor maxRetries/retryDelay; retry transient kernel handle-rundown codes explicitly. */
export function removeTreeWithRetries(path: string, maxRetries = 5, retryDelayMs = 200): void {
  for (let attempt = 0; ; attempt++) {
    try {
      rmSync(path, { recursive: true, force: true, maxRetries, retryDelay: retryDelayMs });
      return;
    } catch (cause) {
      const code = (cause as NodeJS.ErrnoException | undefined)?.code;
      if (attempt >= maxRetries || !code || !RETRYABLE_RM_CODES.has(code)) throw cause;
      Bun.sleepSync(retryDelayMs);
    }
  }
}

/** Remove a settled fixture's private root; only confirmed absence completes disposal. */
export function removeFixtureRoot(root: string): void {
  try { removeTreeWithRetries(root); }
  catch (cause) { throw new Error(`Fixture could not remove ${root}`, { cause }); }
  try { lstatSync(root); }
  catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") return;
    throw error;
  }
  throw new Error(`Fixture root remains after removal: ${root}`);
}
