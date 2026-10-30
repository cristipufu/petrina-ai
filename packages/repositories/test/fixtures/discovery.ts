import { cpSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ADDRESS, repositorySeed } from "@petrina/test-support/repositories";

/** A folder that looks like a clone: a .git folder with an origin, and its last change. */
export function clone(path: string, url: string, changedAt: number, extra = ""): void {
  mkdirSync(join(path, ".git"), { recursive: true });
  writeFileSync(join(path, ".git", "config"), `[core]\n\tbare = false\n${extra}[remote "origin"]\n\turl = ${url}\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n`);
  writeFileSync(join(path, ".git", "HEAD"), "ref: refs/heads/main\n");
  const when = new Date(changedAt);
  utimesSync(join(path, ".git", "HEAD"), when, when);
  utimesSync(join(path, ".git"), when, when);
}


/** A real clone whose origin says github.com. */
export async function makeGitHubClone(path: string): Promise<string> {
  mkdirSync(path, { recursive: true });
  const seed = await repositorySeed(undefined, true);
  cpSync(seed.clone, path, { recursive: true });
  const configPath = join(path, ".git", "config");
  writeFileSync(
    configPath,
    readFileSync(configPath, "utf8").replaceAll(ADDRESS, "https://github.com/acme/shop.git"),
  );
  mkdirSync(join(path, "src", "checkout"), { recursive: true });
  return path;
}
