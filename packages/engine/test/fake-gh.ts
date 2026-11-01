#!/usr/bin/env bun
// A stand-in for `gh`, for tests: pull requests and releases kept in a JSON file, branches and tags
// read from a folder standing in for GitHub's copy of the repository. No network; `gh auth status` says
// it is logged in, unless the state says otherwise.
// bun fake-gh.ts <state.json> <remote folder> <gh arguments…>
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { deflateSync, inflateSync } from "node:zlib";
import { writeFixtureJson } from "@petrina/test-support/fixture-json";
import { removeTreeWithRetries } from "@petrina/test-support/fixture-roots";
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

export function extractFakeGhRepo(args: readonly string[]): string | undefined {
  if (args[0] === "repo" && args[1] === "view" && args[2] && !args[2].startsWith("-")) return args[2];
  if (args[0] === "api" && args[1] === "graphql") {
    let owner: string | undefined;
    let name: string | undefined;
    for (let i = 2; i < args.length; i++) {
      const flag = args[i];
      const value =
        flag === "-F" || flag === "-f" || flag === "--field" || flag === "--raw-field" ? args[++i] : undefined;
      if (!value) continue;
      if (value.startsWith("owner=")) owner = value.slice("owner=".length);
      else if (value.startsWith("name=")) name = value.slice("name=".length);
    }
    return owner && name ? `${owner}/${name}` : undefined;
  }
  if (args[0] === "api") return /^repos\/([^/]+\/[^/]+)\//.exec(args[1] ?? "")?.[1];
  const inline = args.find((arg) => arg.startsWith("--repo="));
  if (inline) return inline.slice("--repo=".length);
  const at = args.indexOf("--repo");
  return at >= 0 ? args[at + 1] : undefined;
}

export function readGitHub(path: string): FakeGitHub {
  return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as FakeGitHub) : { repo: "acme/demo", prs: [], releases: [], calls: [] };
}

function fastReadRefSync(gitDir: string, name: string): string | undefined {
  const direct = join(gitDir, ...name.split("/"));
  if (existsSync(direct)) {
    const text = readFileSync(direct, "utf8").trim();
    if (/^[0-9a-f]{40}$/.test(text)) return text;
  }
  const packed = join(gitDir, "packed-refs");
  if (existsSync(packed)) {
    for (const line of readFileSync(packed, "utf8").split("\n")) {
      if (line.endsWith(` ${name}`)) {
        const sha = line.slice(0, line.indexOf(" ")).trim();
        if (/^[0-9a-f]{40}$/.test(sha)) return sha;
      }
    }
  }
  return undefined;
}

function writeAtomicRefSync(gitDir: string, ref: string, sha: string): void {
  const file = join(gitDir, ...ref.split("/"));
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp.${process.pid}.${Math.random().toString(36).slice(2)}`;
  writeFileSync(tmp, `${sha}\n`);
  renameSync(tmp, file);
}

function hasPackFiles(objectsDir: string): boolean {
  const packDir = join(objectsDir, "pack");
  if (!existsSync(packDir)) return false;
  try {
    return readdirSync(packDir).some((name) => name.endsWith(".pack"));
  } catch {
    return true;
  }
}

function isPlainSha1BareDir(gitDir: string): boolean {
  if (!existsSync(join(gitDir, "HEAD")) || !existsSync(join(gitDir, "objects"))) return false;
  if (hasPackFiles(join(gitDir, "objects"))) return false;
  const cfgPath = join(gitDir, "config");
  if (existsSync(cfgPath)) {
    const cfg = readFileSync(cfgPath, "utf8");
    if (/objectformat\s*=\s*sha256/i.test(cfg)) return false;
  }
  return true;
}

function tryFastMeanwhileMove(remote: string, releaseTag?: string): boolean {
  try {
    if (!isPlainSha1BareDir(remote)) return false;
    const mainSha = fastReadRefSync(remote, "refs/heads/main");
    if (!mainSha) return false;
    const commitPath = join(remote, "objects", mainSha.slice(0, 2), mainSha.slice(2));
    if (!existsSync(commitPath)) return false;
    const raw = inflateSync(readFileSync(commitPath));
    const nul = raw.indexOf(0);
    if (nul <= 0 || !raw.subarray(0, nul).toString("utf8").startsWith("commit ")) return false;
    const treeSha = /^tree ([0-9a-f]{40})$/m.exec(raw.subarray(nul + 1).toString("utf8"))?.[1];
    if (!treeSha) return false;
    const ts = Math.floor(Date.now() / 1000);
    const body = Buffer.from(
      `tree ${treeSha}\nparent ${mainSha}\nauthor Teammate <t@example.com> ${ts} +0000\ncommitter Teammate <t@example.com> ${ts} +0000\n\nA teammate's change\n`,
      "utf8",
    );
    const full = Buffer.concat([Buffer.from(`commit ${body.length}\0`, "utf8"), body]);
    const moved = createHash("sha1").update(full).digest("hex");
    const movedPath = join(remote, "objects", moved.slice(0, 2), moved.slice(2));
    if (!existsSync(movedPath)) {
      mkdirSync(dirname(movedPath), { recursive: true });
      writeFileSync(movedPath, deflateSync(full));
    }
    writeAtomicRefSync(remote, "refs/heads/main", moved);
    if (releaseTag) writeAtomicRefSync(remote, `refs/tags/${releaseTag}`, moved);
    return true;
  } catch {
    return false;
  }
}

function tryFastRefreshPrRef(remote: string, folder: string, pullRef: string, sha: string): boolean {
  try {
    if (!/^[0-9a-f]{40}$/.test(sha) || !isPlainSha1BareDir(remote)) return false;
    if (folder !== remote) {
      const srcObjects = existsSync(join(folder, "objects"))
        ? join(folder, "objects")
        : existsSync(join(folder, ".git", "objects"))
          ? join(folder, ".git", "objects")
          : undefined;
      if (!srcObjects || hasPackFiles(srcObjects) || !existsSync(join(srcObjects, sha.slice(0, 2), sha.slice(2)))) {
        return false;
      }
      const dstObjects = join(remote, "objects");
      for (const fan of readdirSync(srcObjects)) {
        if (!/^[0-9a-f]{2}$/.test(fan)) continue;
        const srcSub = join(srcObjects, fan);
        const dstSub = join(dstObjects, fan);
        mkdirSync(dstSub, { recursive: true });
        for (const obj of readdirSync(srcSub)) {
          const dstObj = join(dstSub, obj);
          if (!existsSync(dstObj)) cpSync(join(srcSub, obj), dstObj);
        }
      }
    }
    if (!existsSync(join(remote, "objects", sha.slice(0, 2), sha.slice(2)))) return false;
    writeAtomicRefSync(remote, pullRef, sha);
    return true;
  } catch {
    return false;
  }
}

function fastCommitAt(folder: string, name: string): Promise<string | undefined> {
  const gitDir = existsSync(join(folder, "HEAD")) && existsSync(join(folder, "objects")) ? folder
    : existsSync(join(folder, ".git", "HEAD")) && existsSync(join(folder, ".git", "objects")) ? join(folder, ".git")
    : undefined;
  if (gitDir && (name.startsWith("refs/heads/") || name.startsWith("refs/tags/")) && !name.includes("..")) {
    return Promise.resolve(fastReadRefSync(gitDir, name));
  }
  return commitAt(folder, name);
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
      return () => removeTreeWithRetries(lock, 5, 10);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      const contended = code === "EEXIST" || (process.platform === "win32" && (code === "EACCES" || code === "EPERM"));
      if (!contended || Date.now() >= deadline) throw error;
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

export interface FakeGitHubReply { code: number; stdout: string; stderr: string }
interface GitHubStateAccess {
  read(): FakeGitHub;
  change(update: (state: FakeGitHub) => void): void;
  input(): string;
  cwd: string;
  mutateRemote?<T>(operation: () => Promise<T>): Promise<T>;
  release?(): void;
  acquire?(): void;
}
class Reply {
  constructor(readonly value: FakeGitHubReply) {}
}

/** The script owns service behavior; both native CLI and in-process fixtures use these exact answers. */
async function dispatchGitHub(remote: string, args: readonly string[], access: GitHubStateAccess): Promise<FakeGitHubReply> {
  let state = access.read();
  const change = (update: (state: FakeGitHub) => void) => { access.change(update); state = access.read(); };
  const exit = (code: number, stdout: string, stderr = ""): never => { throw new Reply({ code, stdout, stderr }); };
  const fail = (message: string): never => exit(1, "", message);
  const mutateRemote = access.mutateRemote ?? (<T>(operation: () => Promise<T>) => operation());
  try {
  if (args[0] === "auth" && args[1] === "status") {
    change(state => { state.logins = (state.logins ?? 0) + 1; });
    if (state.offline) {
      fail("error connecting to api.github.com");
    }
    if (state.loggedOut) {
      fail("You are not logged into any GitHub hosts. To log in, run: gh auth login");
    }
    exit(0, "github.com\n  ✓ Logged in to github.com account octocat (keyring)");
  }
  change(state => {
    state.calls.push([...args]);
    state.cwds = [...(state.cwds ?? []), access.cwd];
  });
  const flag = (name: string): string | undefined => {
    const inline = args.find((arg) => arg.startsWith(`${name}=`));
    if (inline) return inline.slice(name.length + 1);
    const at = args.indexOf(name);
    return at >= 0 ? args[at + 1] : undefined;
  };
  // Absent only when Git confirms it; any other failure fails this call, and the test with it.
  const ref = (name: string): Promise<string | undefined> => fastCommitAt(remote!, name);
  const pick = (entry: object) => Object.fromEntries((flag("--json") ?? "").split(",").map((field) => [field, (entry as Record<string, unknown>)[field]]));
  const [noun, verb] = args;
  const command = `${noun} ${verb}`;
  const count = (table: "fail" | "lose" | "stale"): boolean => {
    let consumed = false;
    change(state => {
      if (!state[table]?.[command]) return;
      state[table]![command] -= 1;
      consumed = true;
    });
    return consumed;
  };
  /** Wait while a hold for this call is on. */
  const held = async (): Promise<void> => {
    const hold = [state.hold, ...(state.holds ?? [])].find(
      (entry) =>
        entry?.command === command
        && (!entry.match || args.some((arg) => arg === entry.match || (command === "api graphql" && arg.includes(entry.match!))))
        && existsSync(entry.file),
    );
    if (!hold) return;
    access.release?.();
    writeFileSync(`${hold.file}.reached`, "");
    while (existsSync(hold.file)) await Bun.sleep(20);
    // The test may have changed GitHub meanwhile: answer from what it is now.
    access.acquire?.();
    state = access.read();
  };
  /** The work is done and saved; now answer, maybe after waiting, maybe losing the answer. */
  const answer = async (out: string): Promise<never> => {
    await held();
    if (count("lose")) fail("error connecting to api.github.com");
    return exit(0, out);
  };

  if (state.offline) fail("error connecting to api.github.com");
  const meanwhile = state.meanwhile;
  if (meanwhile?.times && meanwhile.command === command && (!meanwhile.withTag || (args[2] && !args[2].startsWith("-")))) {
    // Reserve this scripted change before native work; a concurrent request cannot consume it again.
    let reserved: typeof meanwhile | undefined;
    change(state => {
      if (state.meanwhile?.times && state.meanwhile.command === command && (!state.meanwhile.withTag || (args[2] && !args[2].startsWith("-")))) {
        reserved = { ...state.meanwhile };
        state.meanwhile.times -= 1;
        delete state.meanwhile.release;
      }
    });
    if (reserved) {
    const reservation = reserved;
    await mutateRemote(async () => {
    if (!tryFastMeanwhileMove(remote!, reservation.release)) {
      const env = testGitEnv({ ...process.env, GIT_AUTHOR_NAME: "Teammate", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "Teammate", GIT_COMMITTER_EMAIL: "t@example.com" });
      const moved = await gitWith({ env }, "--git-dir", remote!, "commit-tree", "main^{tree}", "-p", "main", "-m", "A teammate's change");
      await gitWith({}, "--git-dir", remote!, "update-ref", "refs/heads/main", moved);
      if (reservation.release) {
        await gitWith({}, "--git-dir", remote!, "update-ref", `refs/tags/${reservation.release}`, moved);
      }
    }
    if (reservation.release) {
      change(state => state.releases.push({ tagName: reservation.release!, url: `https://github.com/${state.repo}/releases/tag/${reservation.release}`, publishedAt: new Date().toISOString(), isDraft: false, name: reservation.release!, body: "A teammate's release." }));
    }
    });
    }
  }
  const positional = args[2] && !args[2].startsWith("-") ? args[2] : undefined;
  // `gh repo view` and `gh api` carry the repository in their arguments; everything else is pinned with --repo.
  const repo = command === "repo view" ? positional ?? flag("--repo") : extractFakeGhRepo(args);
  if (repo !== state.repo) fail(`fake gh only knows ${state.repo}, not ${repo}`);
  if (count("fail")) fail("HTTP 502: Bad Gateway (https://api.github.com/graphql)");
  if (state.hidden) {
    // What gh says when the login cannot see a repository: a missing release looks the same.
    if (command === "release view") fail("release not found");
    if (command === "release create") fail("HTTP 404: Not Found (https://api.github.com/repos/acme/demo/releases)");
    fail(`GraphQL: Could not resolve to a Repository with the name '${state.repo}'. (repository)`);
  }

  const refreshPr = (pr: FakePr): Promise<void> => mutateRemote(async () => {
    if (pr.state !== "OPEN") return;
    const folder = pr.isCrossRepository ? state.forks?.[pr.headRepository?.nameWithOwner ?? ""] : remote;
    if (!folder) return;
    // A deleted branch remains visible as a PR with its former head. Every other failure fails the call.
    const sha = await fastCommitAt(folder, `refs/heads/${pr.headRefName}`);
    if (!sha) return;
    const pullRef = `refs/pull/${pr.number}/head`;
    const pullRefFile = join(remote!, pullRef);
    const currentPullSha = existsSync(pullRefFile) ? readFileSync(pullRefFile, "utf8").trim() : undefined;
    if (currentPullSha !== sha && !tryFastRefreshPrRef(remote!, folder, pullRef, sha)) {
      if (folder !== remote) await gitWith({}, "--git-dir", remote!, "fetch", "-q", folder, sha);
      await gitWith({}, "--git-dir", remote!, "update-ref", pullRef, sha);
    }
    change(state => {
      const current = state.prs.find(entry => entry.number === pr.number);
      if (current?.state === "OPEN") current.headRefOid = sha;
    });
    pr.headRefOid = sha;
  });
  if (command === "api graphql") {
    await held();
    if (count("lose")) fail("error connecting to api.github.com");
    const queryArg = args.find(
      (arg, index) =>
        index > 1
        && (args[index - 1] === "-f"
          || args[index - 1] === "-F"
          || args[index - 1] === "--field"
          || args[index - 1] === "--raw-field")
        && arg.startsWith("query="),
    );
    const query = queryArg ? queryArg.slice("query=".length) : "";
    const repository: Record<string, { state: string } | null> = {};
    const errors: { type: string; message: string }[] = [];
    for (const match of query.matchAll(/(pr_\d+)\s*:\s*pullRequest\(\s*number\s*:\s*(\d+)\s*\)/g)) {
      const alias = match[1]!;
      const number = Number(match[2]!);
      const pr = state.prs.find((entry) => entry.number === number);
      if (pr) {
        await refreshPr(pr);
        repository[alias] = { state: pr.state };
      } else {
        repository[alias] = null;
        errors.push({ type: "NOT_FOUND", message: `Could not resolve to a PullRequest with the number of ${number}.` });
      }
    }
    const payload = errors.length
      ? JSON.stringify({ data: { repository }, errors })
      : JSON.stringify({ data: { repository } });
    return exit(errors.length ? 1 : 0, payload, errors.length ? `gh: ${errors[0]!.message}` : "");
  }
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
    if (count("stale")) await answer("[]");
    const head = flag("--head");
    // GitHub moves an open pull request's head along with its branch.
    for (const pr of state.prs) {
      const sha = pr.state === "OPEN" ? await ref(`refs/heads/${pr.headRefName}`) : undefined;
      if (sha) change(state => {
        const current = state.prs.find(entry => entry.number === pr.number);
        if (current?.state === "OPEN") current.headRefOid = sha;
      });
    }
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
    const body = access.input();
    change(state => {
    const current = state.prs.find(entry => entry.number === pr!.number);
    if (!current) fail("Pull request not found");
    if (command === "pr edit") current!.body = body;
    else {
      const endpoint = `issues/${pr!.number}/comments?per_page=100`;
      state.pages ??= {};
      const comments = state.pages[endpoint]?.flat() ?? [];
      state.pages[endpoint] = [[...comments, { body }]];
    }
    });
    await answer(pr!.url);
  }
  if (command === "pr create") {
    const head = flag("--head")!;
    const base = flag("--base")!;
    const oid = await ref(`refs/heads/${head}`);
    if (!oid) fail(`pull request create failed: GraphQL: Head sha can't be blank, Head ref must be a branch`);
    let url = "";
    change(state => {
      const open = state.prs.find(pr => pr.headRefName === head && pr.baseRefName === base && pr.state === "OPEN");
      if (open) fail(`a pull request for branch "${head}" into branch "${base}" already exists:\n${open.url}`);
      const number = state.prs.length + 1;
      const pr: FakePr = { number, url: `https://github.com/${state.repo}/pull/${number}`, headRefName: head, baseRefName: base, headRefOid: oid!, state: "OPEN", isCrossRepository: false, title: flag("--title") ?? "", body: access.input() };
      state.prs.push(pr);
      url = pr.url;
    });
    await answer(url);
  }
  if (command === "release view") {
    if (count("stale")) fail("release not found");
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
    const release: FakeRelease = { tagName: tag, url: `https://github.com/${state.repo}/releases/tag/${tag}`, publishedAt: new Date().toISOString(), isDraft: false, name: flag("--title") ?? tag, body: access.input() };
    change(state => {
      if (state.releases.some(entry => entry.tagName === tag)) fail("HTTP 422: Validation Failed: tag_name already exists");
      state.releases.push(release);
    });
    await answer(release.url);
  }
  return fail(`fake gh does not know: ${args.join(" ")}`);
  } catch (error) {
    if (error instanceof Reply) return error.value;
    throw error;
  }
}

// Git's ref locks still need one writer per private remote. Queue only native mutations, never held replies
// or state edits, and remove settled entries so completed fixture roots are not retained by the worker.
const remoteMutations = new Map<string, Promise<void>>();
function mutateRemote<T>(remote: string, operation: () => Promise<T>): Promise<T> {
  const pending = (remoteMutations.get(remote) ?? Promise.resolve()).then(operation);
  const settled = pending.then(() => {}, () => {});
  remoteMutations.set(remote, settled);
  void settled.then(() => { if (remoteMutations.get(remote) === settled) remoteMutations.delete(remote); });
  return pending;
}

/** Short atomic mutations only: a native Git await never blocks this worker's synchronous script edits. */
export function fakeGitHubRequest(statePath: string, remote: string, args: readonly string[], input = "", cwd = process.cwd()): Promise<FakeGitHubReply> {
  return dispatchGitHub(remote, args, {
    read: () => readGitHub(statePath),
    change: update => updateGitHub(statePath, update),
    input: () => input, cwd,
    mutateRemote: operation => mutateRemote(remote, operation),
  });
}

/** Native transport contracts retain the complete request lock and real stdin/stdout/process exit. */
export async function runFakeGitHub(input: readonly string[], onLockWait?: () => void): Promise<void> {
  const [statePath, remote, ...args] = input;
  const ignoreClosedPipe = (error: NodeJS.ErrnoException) => {
    if (error.code !== "EPIPE" && error.code !== "EOF") throw error;
  };
  process.stdout.on("error", ignoreClosedPipe);
  process.stderr.on("error", ignoreClosedPipe);
  const writeLine = (stream: NodeJS.WriteStream, text: string) => {
    try { stream.write(`${text}\n`); }
    catch (error) { ignoreClosedPipe(error as NodeJS.ErrnoException); }
  };
  let unlock = lockGitHub(statePath!, onLockWait);
  let state = readGitHub(statePath!);
  const release = () => { unlock(); unlock = () => {}; };
  process.on("exit", release);
  try {
    const result = await dispatchGitHub(remote!, args, {
      read: () => state,
      change: update => { update(state); writeGitHub(statePath!, state); },
      input: () => readFileSync(0, "utf8"), cwd: process.cwd(), release,
      acquire: () => { unlock = lockGitHub(statePath!); state = readGitHub(statePath!); },
    });
    if (result.stdout) writeLine(process.stdout, result.stdout);
    if (result.stderr) writeLine(process.stderr, result.stderr);
    process.exit(result.code);
  } finally {
    release();
    process.off("exit", release);
    process.stdout.off("error", ignoreClosedPipe);
    process.stderr.off("error", ignoreClosedPipe);
  }
}

// A failed Git lookup fails the call with Git's own words, never as a confirmed "not found".
if (import.meta.main) await runFakeGitHub(process.argv.slice(2)).catch((error: unknown) => {
  process.stderr.write(`fake gh could not answer: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
