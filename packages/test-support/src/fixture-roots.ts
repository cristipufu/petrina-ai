import { existsSync, lstatSync, readdirSync, readlinkSync, realpathSync, rmSync } from "node:fs";
import { join, resolve, sep } from "node:path";

const RETRYABLE_RM_CODES = new Set(["EBUSY", "EMFILE", "ENFILE", "ENOTEMPTY", "EPERM"]);

/**
 * Inspect the current worker's open descriptor links (such as Linux /proc/self/fd) for live handles
 * pointing inside `root`, catching Windows-style EBUSY handle leaks before POSIX unlinking hides them.
 */
export function findOpenPathsInRoot(root: string, fdDir = "/proc/self/fd"): string[] {
  if (!existsSync(fdDir)) return [];
  const candidates = new Set<string>([resolve(root)]);
  try {
    candidates.add(realpathSync.native(root));
  } catch {
    /* Absent roots have no canonical on-disk spelling. */
  }
  const insideRoot = (target: string): boolean => {
    for (const base of candidates) {
      if (target === base || target.startsWith(`${base}${sep}`)) return true;
    }
    return false;
  };
  let entries: string[];
  try {
    entries = readdirSync(fdDir);
  } catch {
    return [];
  }
  const leaked = new Set<string>();
  for (const entry of entries) {
    let target: string;
    try {
      target = readlinkSync(join(fdDir, entry));
    } catch {
      continue;
    }
    if (!target || target.endsWith(" (deleted)")) continue;
    if (insideRoot(target)) leaked.add(target);
  }
  return [...leaked].sort();
}

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

export function assertNoOpenPathsInRoot(root: string, fdDir = "/proc/self/fd"): void {
  const leaked = findOpenPathsInRoot(root, fdDir);
  if (leaked.length) {
    throw new Error(`Fixture root has open file descriptor(s) before removal: ${leaked.join(", ")}`);
  }
}

/** Remove a settled fixture's private root; only confirmed absence completes disposal. */
export function removeFixtureRoot(root: string): void {
  assertNoOpenPathsInRoot(root);
  try {
    removeTreeWithRetries(root);
  } catch (cause) {
    throw new Error(`Fixture could not remove ${root}`, { cause });
  }
  try {
    lstatSync(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") return;
    throw error;
  }
  throw new Error(`Fixture root remains after removal: ${root}`);
}
