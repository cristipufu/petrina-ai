import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { Engine } from "../engine.js";
import { Fakes, coordinator, git, gitWith, itemOf, makeWorld, REPO, removeDir, taskOf, until, type World } from "../support.js";
import type { Scenario } from "../fake-agent.js";

export function sourceWorlds() {
const worlds: World[] = [];
async function setup(name: string, scenario: Scenario = {}, forks: Record<string, string> = {}) {
  const w = await makeWorld(`source-${name}`);
  worlds.push(w);
  const fakes = new Fakes(join(w.dir, "fake"));
  fakes.scenario({ planner: "short", builder: "plain", reopen: "resume", ...scenario });
  const services = scenario.builder === "work" ? {} : sourceAgents(w, fakes);
  const start = () => new Engine(w.data, { ...services, agentCommand: () => [process.execPath, join(import.meta.dir, "../fake-agent.ts"), fakes.dir, `--script=${join(w.dir, "agents.json")}`], gh: [process.execPath, join(import.meta.dir, "../fake-gh.ts"), join(w.dir, "github.json"), w.remote], remote: w.remote, sourceRemotes: forks });
  return { w, fakes, start };
}
return { setup, close: () => worlds.forEach(w => removeDir(w.dir)) };
}

export async function branch(w: World, name = "release-2.x", remote = w.remote): Promise<string> {
  await git(w.clone, "switch", "-q", "-c", name);
  writeFileSync(join(w.clone, "source.txt"), "Existing source work\n");
  await git(w.clone, "add", "."); await git(w.clone, "commit", "-qm", "Existing source work");
  const sha = await git(w.clone, "rev-parse", "HEAD");
  await git(w.clone, "push", "-q", remote, name);
  await git(w.clone, "switch", "-q", "main");
  return sha;
}
export async function pull(w: World, fork = false): Promise<{ sha: string; remote: string }> {
  const remote = fork ? join(w.dir, "fork.git") : w.remote;
  if (fork) await gitWith({}, "clone", "-q", "--bare", w.remote, remote);
  const sha = await branch(w, "review-work", remote);
  if (fork) await git(w.clone, "push", "-q", w.remote, `${sha}:refs/pull/7/head`);
  else await git(w.clone, "push", "-q", w.remote, "review-work:refs/pull/7/head");
  w.setGitHub((state) => {
    state.forks = fork ? { "contributor/demo": remote } : {};
    state.prs.push({ number: 7, url: `https://github.com/${REPO}/pull/7`, state: "OPEN", title: "Original PR title", body: "Original description", headRefName: "review-work", baseRefName: "main", headRefOid: sha, headRepository: { nameWithOwner: fork ? "contributor/demo" : REPO }, isCrossRepository: fork });
  });
  return { sha, remote };
}
export async function planGate(engine: Engine, id: string) {
  return until(engine, (state) => !!itemOf(state, id, "plan") || taskOf(state, id).state === "failed", coordinator([]));
}
export async function deliveryGate(engine: Engine, id: string) {
  return until(engine, (state) => !!itemOf(state, id, "delivery") || taskOf(state, id).state === "failed", coordinator(["plan", "design"]));
}
/** The task's commit on the product copy. A finished local delivery may already have removed the working copy. */
export function taskCommit(w: World, task: { branch?: string }): Promise<string> {
  return git(w.clone, "rev-parse", task.branch!);
}
export async function advance(w: World, remote: string, name: string, file = "NEWS.md", content = "New source work\n"): Promise<string> {
  const copy = join(w.dir, `move-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await git(w.dir, "clone", "-q", remote, copy);
  await git(copy, "config", "user.name", "Someone else"); await git(copy, "config", "user.email", "other@example.com");
  await git(copy, "switch", "-q", name);
  writeFileSync(join(copy, file), content);
  await git(copy, "add", "."); await git(copy, "commit", "-qm", "New source work");
  await git(copy, "push", "-q", remote, name);
  return git(copy, "rev-parse", "HEAD");
}

import { sourceAgents } from "./source-agents.js";
