import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { writeFixtureJson } from "@petrina/test-support/fixture-json";

/** A scripted native GH auth command. No GitHub account, Engine or remote response fixture. */
export function githubReadiness(dir: string) {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "login.json");
  writeFixtureJson(file, { loggedOut: false, offline: false });
  const script = `const args = process.argv.slice(1);
    if (JSON.stringify(args) !== JSON.stringify(["auth", "status", "--hostname", "github.com"])) throw new Error("Unexpected GH auth request");
    const state = await Bun.file(${JSON.stringify(file)}).json();
    if (state.offline) { process.stderr.write("error connecting to api.github.com\\n"); process.exit(1); }
    if (state.loggedOut) { process.stderr.write("You are not logged into any GitHub hosts. To log in, run: gh auth login\\n"); process.exit(1); }
    process.stdout.write("github.com\\n  ✓ Logged in to github.com account octocat (keyring)\\n");`;

  return { dir, command: [process.execPath, "-e", script, "--"], github(update: (value: { loggedOut: boolean; offline: boolean }) => void) {
    const value = JSON.parse(readFileSync(file, "utf8")) as { loggedOut: boolean; offline: boolean };
    update(value); writeFixtureJson(file, value);
  } };
}
