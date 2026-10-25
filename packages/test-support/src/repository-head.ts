import { existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

/**
 * The commit a working copy's HEAD names at this moment, read from Git's own files without starting a program:
 * for callbacks the engine calls synchronously, such as its announcements, where a Git command cannot be awaited.
 * Reads linked worktrees, detached heads and packed refs; anything else fails rather than guess.
 */
export function headNow(worktree: string): string {
  let gitDir = join(worktree, ".git");
  if (statSync(gitDir).isFile()) gitDir = resolve(worktree, /^gitdir: (.+)$/m.exec(readFileSync(gitDir, "utf8"))?.[1]?.trim() ?? "");
  const common = existsSync(join(gitDir, "commondir")) ? resolve(gitDir, readFileSync(join(gitDir, "commondir"), "utf8").trim()) : gitDir;
  const head = readFileSync(join(gitDir, "HEAD"), "utf8").trim();
  const ref = /^ref: (refs\/.+)$/.exec(head)?.[1];
  // A loose ref wins over packed-refs; one packed away between the two reads is found there.
  const read = (path: string) => { try { return readFileSync(path, "utf8"); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; } };
  const sha = !ref ? head : read(join(common, ref))?.trim() ?? read(join(common, "packed-refs"))?.split("\n").find((line) => line.endsWith(` ${ref}`))?.split(" ")[0] ?? "";
  if (!/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(sha)) throw new Error(`Could not read the HEAD of ${worktree} from Git's files (${head})`);
  return sha;
}

