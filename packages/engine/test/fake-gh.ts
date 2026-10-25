#!/usr/bin/env bun
// A stand-in for `gh`, for tests: pull requests and releases kept in a JSON file, branches and tags
// read from a folder standing in for GitHub's copy of the repository. No network; `gh auth status` says
// it is logged in, unless the state says otherwise.
// bun fake-gh.ts <state.json> <remote folder> <gh arguments…>
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { writeFixtureJson } from "@petrina/test-support/fixture-json";
import { commitAt, gitWith } from "@petrina/test-support/commands";
import { testGitEnv } from "@petrina/test-support/test-git-env";

export interface FakePr {
  number: number;
  url: string;
  headRefName: string;
  baseRefName: string;
  headRefOid: string;
  state: "OPEN" | "MERGED" | "CLOSED";
  isCrossRepository: boolean;
  title: string;
  body: string;
  headRepository?: { nameWithOwner: string };
  headRepositoryOwner?: { login: string };
}

export interface FakeRelease {
  tagName: string;
  url: string;
  publishedAt: string;
  isDraft: boolean;
  name: string;
  body: string;
}

export interface FakeGitHub {
  /** The only repository it answers for: every call must be pinned to it with --repo. */
  repo: string;
  /** Every call fails like GitHub being unreachable. */
  offline?: boolean;
  /** The GitHub CLI is installed but not logged in. */
  loggedOut?: boolean;
  /** How many times Petrina checked the login (gh auth status). Those calls are about the coordinator, not the repository, so they are not in `calls`. */
  logins?: number;
  /** Local repositories standing in for forks, keyed by owner/name. */
  forks?: Record<string, string>;
  /** Full paginated API answers keyed by the endpoint after repos/owner/name/. */
  pages?: Record<string, unknown[]>;
  /** The login cannot see the repository: GitHub answers "not found" for everything in it. */
  hidden?: boolean;
  /** Commands ("pr list", "release create", …) that fail the next N times. */
  fail?: Record<string, number>;
  /** Commands that do their work, then fail the next N times, as if the answer was lost on the way back. */
  lose?: Record<string, number>;
  /** Commands whose listing comes back empty the next N times, as if GitHub lagged behind. */
  stale?: Record<string, number>;
  /** While `file` exists, `command` waits after doing its work. `file`.reached is written when it starts waiting. */
  hold?: Hold;
  /** More holds, each only for calls whose arguments include `match` (a branch or tag). */
  holds?: Hold[];
  /** While `times` lasts, each `command` call first has a teammate change GitHub: main moves, and with `release`, that release comes out on it. */
  meanwhile?: { command: string; withTag?: boolean; times: number; release?: string };
  prs: FakePr[];
  releases: FakeRelease[];
  /** Every call's arguments, in order. */
  calls: string[][];
  /** The folder each call ran in. */
  cwds?: string[];
}

export interface Hold {
  command: string;
  file: string;
  match?: string;
}

export function readGitHub(path: string): FakeGitHub {
  return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as FakeGitHub) : { repo: "acme/demo", prs: [], releases: [], calls: [] };
}

export function writeGitHub(path: string, state: FakeGitHub): void {
  writeFixtureJson(path, state, 2);
}

/** Fake gh processes and the test change the same file. A read followed by a write must be one operation. */
function lockGitHub(path: string, onWait?: () => void): () => void {
  const lock = `${path}.lock`;
  const deadline = Date.now() + 30_000;
  let reportedWait = false;
  for (;;) {
    try {
      mkdirSync(lock);
      return () => rmSync(lock, { recursive: true, force: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST" || Date.now() >= deadline) throw error;
      if (!reportedWait) { onWait?.(); reportedWait = true; }
      Bun.sleepSync(10);
    }
  }
}

export function updateGitHub(path: string, change: (state: FakeGitHub) => void): void {
  const unlock = lockGitHub(path);
  try {
    const state = readGitHub(path);
    change(state);
    writeGitHub(path, state);
  } finally {
    unlock();
  }
}

export async function runFakeGitHub(input: readonly string[], onLockWait?: () => void): Promise<void> {
  const [statePath, remote, ...args] = input;
  let unlock = lockGitHub(statePath!, onLockWait);
  // Unexpected exits also release this process's lock. Waiting calls release it first below.
  process.on("exit", () => unlock());
  const state = readGitHub(statePath!);
  if (args[0] === "auth" && args[1] === "status") {
    state.logins = (state.logins ?? 0) + 1;
    writeGitHub(statePath!, state);
    if (state.offline) {
      process.stderr.write("error connecting to api.github.com\n");
      process.exit(1);
    }
    if (state.loggedOut) {
      process.stderr.write("You are not logged into any GitHub hosts. To log in, run: gh auth login\n");
      process.exit(1);
    }
    process.stdout.write("github.com\n  ✓ Logged in to github.com account octocat (keyring)\n");
    process.exit(0);
  }
  state.calls.push(args);
  state.cwds = [...(state.cwds ?? []), process.cwd()];
  const save = () => writeGitHub(statePath!, state);
  save();
  const flag = (name: string): string | undefined => {
    const inline = args.find((arg) => arg.startsWith(`${name}=`));
    if (inline) return inline.slice(name.length + 1);
    const at = args.indexOf(name);
    return at >= 0 ? args[at + 1] : undefined;
  };
  const exit = (code: number, out: string, err = ""): never => {
    if (out) process.stdout.write(`${out}\n`);
    if (err) process.stderr.write(`${err}\n`);
    process.exit(code);
  };
  const fail = (message: string): never => exit(1, "", message);
  // Absent only when Git confirms it; any other failure fails this call, and the test with it.
  const ref = (name: string): Promise<string | undefined> => commitAt(remote!, name);
  const pick = (entry: object) => Object.fromEntries((flag("--json") ?? "").split(",").map((field) => [field, (entry as Record<string, unknown>)[field]]));
  const [noun, verb] = args;
  const command = `${noun} ${verb}`;
  const count = (table: Record<string, number> | undefined): boolean => {
    if (!table?.[command]) return false;
    table[command] -= 1;
    save();
    return true;
  };
  /** Wait while a hold for this call is on. */
  const held = async (): Promise<void> => {
    const hold = [state.hold, ...(state.holds ?? [])].find((entry) => entry?.command === command && (!entry.match || args.includes(entry.match)) && existsSync(entry.file));
    if (!hold) return;
    unlock();
    unlock = () => {};
    writeFileSync(`${hold.file}.reached`, "");
    while (existsSync(hold.file)) await Bun.sleep(20);
    // The test may have changed GitHub meanwhile: answer from what it is now.
    unlock = lockGitHub(statePath!);
    Object.assign(state, readGitHub(statePath!));
  };
  /** The work is done and saved; now answer, maybe after waiting, maybe losing the answer. */
  const answer = async (out: string): Promise<never> => {
    await held();
    if (count(state.lose)) fail("error connecting to api.github.com");
    return exit(0, out);
  };

  if (state.offline) fail("error connecting to api.github.com");
  const meanwhile = state.meanwhile;
  if (meanwhile?.times && meanwhile.command === command && (!meanwhile.withTag || (args[2] && !args[2].startsWith("-")))) {
    meanwhile.times -= 1;
    const env = testGitEnv({ ...process.env, GIT_AUTHOR_NAME: "Teammate", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "Teammate", GIT_COMMITTER_EMAIL: "t@example.com" });
    const moved = await gitWith({ env }, "--git-dir", remote!, "commit-tree", "main^{tree}", "-p", "main", "-m", "A teammate's change");
    await gitWith({}, "--git-dir", remote!, "update-ref", "refs/heads/main", moved);
    if (meanwhile.release) {
      await gitWith({}, "--git-dir", remote!, "update-ref", `refs/tags/${meanwhile.release}`, moved);
      state.releases.push({ tagName: meanwhile.release, url: `https://github.com/${state.repo}/releases/tag/${meanwhile.release}`, publishedAt: new Date().toISOString(), isDraft: false, name: meanwhile.release, body: "A teammate's release." });
      delete meanwhile.release;
    }
    save();
  }
  const positional = args[2] && !args[2].startsWith("-") ? args[2] : undefined;
  // `gh repo view` names the repository itself; everything else is pinned with --repo.
  const repo = noun === "api" ? (verb?.startsWith(`repos/${state.repo}/`) ? state.repo : undefined) : command === "repo view" ? positional ?? flag("--repo") : flag("--repo");
  if (repo !== state.repo) fail(`fake gh only knows ${state.repo}, not ${repo}`);
  if (count(state.fail)) fail("HTTP 502: Bad Gateway (https://api.github.com/graphql)");
  if (state.hidden) {
    // What gh says when the login cannot see a repository: a missing release looks the same.
    if (command === "release view") fail("release not found");
    if (command === "release create") fail("HTTP 404: Not Found (https://api.github.com/repos/acme/demo/releases)");
    fail(`GraphQL: Could not resolve to a Repository with the name '${state.repo}'. (repository)`);
  }

  const refreshPr = async (pr: FakePr): Promise<void> => {
    if (pr.state !== "OPEN") return;
    const folder = pr.isCrossRepository ? state.forks?.[pr.headRepository?.nameWithOwner ?? ""] : remote;
    if (!folder) return;
    // A deleted branch remains visible as a PR with its former head. Every other failure fails the call.
    const sha = await commitAt(folder, `refs/heads/${pr.headRefName}`);
    if (!sha) return;
    if (folder !== remote) await gitWith({}, "--git-dir", remote!, "fetch", "-q", folder, sha);
    await gitWith({}, "--git-dir", remote!, "update-ref", `refs/pull/${pr.number}/head`, sha);
    pr.headRefOid = sha;
    save();
  };
  if (noun === "api") {
    const endpoint = verb!.slice(`repos/${state.repo}/`.length);
    if (!args.includes("--paginate") || !args.includes("--slurp")) fail("API lists must read every page");
    const pages = state.pages?.[endpoint];
    if (pages) await answer(JSON.stringify(pages));
    if (endpoint.startsWith("branches/")) {
      const sha = await ref(`refs/heads/${decodeURIComponent(endpoint.slice(9))}`);
      if (!sha) fail("HTTP 404: branch not found");
      await answer(JSON.stringify([{ commit: { sha } }]));
    }
    if (endpoint.includes("/check-runs")) await answer(JSON.stringify([{ check_runs: [] }]));
    if (endpoint.includes("/status?")) await answer(JSON.stringify([{ statuses: [] }]));
    if (/^(pulls|issues)\/\d+\/(reviews|comments)/.test(endpoint)) await answer("[[]]");
    fail("Unknown API endpoint");
  }
  if (command === "repo view") await answer(flag("--jq") === ".nameWithOwner" ? state.repo : JSON.stringify({ nameWithOwner: state.repo, defaultBranchRef: { name: "main" } }));

  if (command === "pr list") {
    if (count(state.stale)) await answer("[]");
    const head = flag("--head");
    // GitHub moves an open pull request's head along with its branch.
    for (const pr of state.prs) {
      const sha = pr.state === "OPEN" ? await ref(`refs/heads/${pr.headRefName}`) : undefined;
      if (sha) pr.headRefOid = sha;
    }
    save();
    const limit = Number(flag("--limit") ?? 30);
    await answer(JSON.stringify(state.prs.filter((pr) => pr.headRefName === head && (flag("--state") === "all" || pr.state === "OPEN")).slice(0, limit).map(pick)));
  }
  if (command === "pr view") {
    const pr = state.prs.find((entry) => String(entry.number) === positional || entry.headRefName === positional);
    if (!pr) fail(`no pull requests found for branch "${positional}"`);
    await refreshPr(pr!);
    await answer(flag("--jq") === ".state" ? pr!.state : JSON.stringify(pick(pr!)));
  }
  if (command === "pr edit" || command === "pr comment") {
    const pr = state.prs.find((entry) => String(entry.number) === positional);
    if (!pr) fail("Pull request not found");
    const body = readFileSync(0, "utf8");
    if (command === "pr edit") pr!.body = body;
    else {
      const endpoint = `issues/${pr!.number}/comments?per_page=100`;
      state.pages ??= {};
      const comments = state.pages[endpoint]?.flat() ?? [];
      state.pages[endpoint] = [[...comments, { body }]];
    }
    save(); await answer(pr!.url);
  }
  if (command === "pr create") {
    const head = flag("--head")!;
    const base = flag("--base")!;
    const oid = await ref(`refs/heads/${head}`);
    if (!oid) fail(`pull request create failed: GraphQL: Head sha can't be blank, Head ref must be a branch`);
    const open = state.prs.find((pr) => pr.headRefName === head && pr.baseRefName === base && pr.state === "OPEN");
    if (open) fail(`a pull request for branch "${head}" into branch "${base}" already exists:\n${open.url}`);
    const number = state.prs.length + 1;
    const pr: FakePr = { number, url: `https://github.com/${state.repo}/pull/${number}`, headRefName: head, baseRefName: base, headRefOid: oid!, state: "OPEN", isCrossRepository: false, title: flag("--title") ?? "", body: readFileSync(0, "utf8") };
    state.prs.push(pr);
    save();
    await answer(pr.url);
  }
  if (command === "release view") {
    if (count(state.stale)) fail("release not found");
    const published = state.releases.filter((entry) => !entry.isDraft).sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt));
    const release = positional ? state.releases.find((entry) => entry.tagName === positional) : published[0];
    if (!release) {
      await held();
      fail("release not found");
    }
    await answer(JSON.stringify(pick(release!)));
  }
  if (command === "release create") {
    const tag = positional!;
    if (state.releases.some((entry) => entry.tagName === tag)) fail("HTTP 422: Validation Failed: tag_name already exists");
    if (args.includes("--verify-tag") && !(await ref(`refs/tags/${tag}`))) fail(`tag ${tag} doesn't exist in the repo ${state.repo}, aborting due to --verify-tag flag`);
    if (!args.includes("--verify-tag")) fail("fake gh: Petrina always passes --verify-tag");
    const release: FakeRelease = { tagName: tag, url: `https://github.com/${state.repo}/releases/tag/${tag}`, publishedAt: new Date().toISOString(), isDraft: false, name: flag("--title") ?? tag, body: readFileSync(0, "utf8") };
    state.releases.push(release);
    save();
    await answer(release.url);
  }
  fail(`fake gh does not know: ${args.join(" ")}`);
}

// A failed Git lookup fails the call with Git's own words, never as a confirmed "not found".
if (import.meta.main) await runFakeGitHub(process.argv.slice(2)).catch((error: unknown) => {
  process.stderr.write(`fake gh could not answer: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
