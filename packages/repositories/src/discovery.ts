import { lstat, readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, sep } from "node:path";
import type { Clone } from "@petrina/core";
import { githubRepo } from "./identity.js";
import { originUrl } from "./discovery-values.js";
import { expandPastedPath } from "./pasted-path.js";

// ── Clones on this machine ──────────────────────────────────────────────

/** Where people usually keep their code, below their home folder. */
export const CODE_FOLDERS: readonly string[] = [
  "code",
  "Code",
  "dev",
  "Developer",
  "src",
  "projects",
  "Projects",
  "repos",
  "git",
  "GitHub",
  "workspace",
  "work",
  "Sites",
  join("Documents", "GitHub"),
  join("source", "repos"),
];

/**
 * On a Mac, reading these folders makes the system ask the coordinator for permission in a window
 * of its own, so the scan leaves them out. A clone in one can still be pasted.
 */
const MAC_PROTECTED: readonly string[] = ["Desktop", "Documents", "Downloads"];

/** The code folders the scan reads on this operating system. */
export function codeFolders(platform: NodeJS.Platform = process.platform): string[] {
  return CODE_FOLDERS.filter((folder) => platform !== "darwin" || !MAC_PROTECTED.includes(folder.split(sep)[0]!));
}

/** At most this many entries are read from one folder. */
const MAX_ENTRIES = 400;

/**
 * GitHub clones in the usual code folders, two levels deep at most, most recently changed first.
 * Only reads files: nothing runs inside these folders, and links are never followed. Stops after
 * `budgetMs` with what it found so far.
 */
export async function findClones(options: {
  home?: string;
  folders?: readonly string[];
  platform?: NodeJS.Platform;
  skip?: (path: string) => boolean;
  limit?: number;
  budgetMs?: number
} = {}): Promise<Clone[]> {
  const home = options.home ?? homedir();
  const deadline = Date.now() + (options.budgetMs ?? 2_000);
  const seen = new Set<string>();
  const found: Clone[] = [];

  const visit = async (dir: string, depth: number): Promise<void> => {
    if (Date.now() > deadline) return;
    // lstat: a link is never a folder here, so nothing outside is followed.
    const info = await lstat(dir).catch(() => undefined);
    if (!info?.isDirectory()) return;
    // The same folder by two names (code and Code on a Mac) is read once.
    const key = `${info.dev}:${info.ino}`;
    if (seen.has(key)) return;
    seen.add(key);
    const clone = await readClone(dir);
    if (clone) {
      found.push(clone);
      return;
    }
    if (depth >= 2) return;
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries.slice(0, MAX_ENTRIES)) {
      if (!entry.isDirectory() || entry.name.startsWith(".") || entry.name === "node_modules") continue;
      await visit(join(dir, entry.name), depth + 1);
    }
  };

  for (const folder of options.folders ?? codeFolders(options.platform)) if (await linkFree(home, folder)) await visit(join(home, folder), 0);
  return found
    .filter((clone) => !options.skip?.(clone.path))
    .sort((a, b) => b.changedAt - a.changedAt)
    .slice(0, options.limit ?? 6);
}

/**
 * A code folder below the home folder with no link anywhere on the way (Documents in Documents/GitHub
 * as well as GitHub itself), so a shortcut never leads the scan out of the folders it means to read.
 */
async function linkFree(home: string, folder: string): Promise<boolean> {
  let path = home;
  for (const part of folder.split(sep)) {
    path = join(path, part);
    const info = await lstat(path).catch(() => undefined);
    if (!info?.isDirectory()) return false;
  }
  return true;
}

/** A folder whose own .git folder has a GitHub "origin". A .git file (a worktree or submodule) is not a clone. */
async function readClone(dir: string): Promise<Clone | undefined> {
  const gitDir = join(dir, ".git");
  const info = await lstat(gitDir).catch(() => undefined);
  if (!info?.isDirectory()) return undefined;
  const config = join(gitDir, "config");
  const file = await lstat(config).catch(() => undefined);
  if (!file?.isFile() || file.size > 64 * 1024) return undefined;
  const repo = githubRepo(originUrl(await readFile(config, "utf8").catch(() => "")) ?? "");
  if (!repo) return undefined;
  let changedAt = info.mtimeMs;
  // Each step is stated on its own. Stating "logs/HEAD" in one go would follow a shortcut logs,
  // and a newer file outside the code folders would change which clone is suggested first.
  for (const parts of [["index"], ["HEAD"], ["FETCH_HEAD"], ["logs", "HEAD"]] as const) {
    const stamp = await fileStamp(gitDir, parts);
    if (stamp !== undefined) changedAt = Math.max(changedAt, stamp);
  }
  return { path: dir, repo, changedAt };
}

/**
 * The date of a file under `dir`, or nothing when any step is missing or a shortcut. `lstat` of a
 * whole path still follows every shortcut but the last, so each step is checked on its own.
 */
async function fileStamp(dir: string, parts: readonly string[]): Promise<number | undefined> {
  let path = dir;
  for (let index = 0; index < parts.length; index += 1) {
    path = join(path, parts[index]!);
    const stamp = await lstat(path).catch(() => undefined);
    if (!stamp || stamp.isSymbolicLink()) return undefined;
    if (index === parts.length - 1) return stamp.isFile() ? stamp.mtimeMs : undefined;
    if (!stamp.isDirectory()) return undefined;
  }
  return undefined;
}

// ── Paths and links ─────────────────────────────────────────────────────

/** A pasted folder path, using this process's home and platform when the caller supplies neither. */
export function expandPath(input: string, home = homedir(), platform: NodeJS.Platform = process.platform): string {
  return expandPastedPath(input, home, platform);
}
