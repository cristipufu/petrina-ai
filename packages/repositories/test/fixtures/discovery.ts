import { mkdirSync, writeFileSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { git } from "@petrina/test-support/commands";

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
  await git(path, "init", "-q", "-b", "main");
  await git(path, "config", "user.email", "test@example.com");
  await git(path, "config", "user.name", "Test");
  writeFileSync(join(path, "README.md"), "# Shop\n");
  await git(path, "add", ".");
  await git(path, "commit", "-q", "-m", "init");
  await git(path, "remote", "add", "origin", "https://github.com/acme/shop.git");
  mkdirSync(join(path, "src", "checkout"), { recursive: true });
  return path;
}
