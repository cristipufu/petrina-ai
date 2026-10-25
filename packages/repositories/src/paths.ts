import { realpathSync } from "node:fs";

export function realPath(path: string): string {
  try {
    // Git reports expanded Windows paths. Bun's non-native resolver can retain an 8.3
    // spelling, making the main copy appear to be a different checked-out worktree.
    return realpathSync.native(path);
  } catch {
    return path;
  }
}
