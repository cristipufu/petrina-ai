import { expectRejection } from "./rejections.js";
import { executionFor } from "../src/repository-context.js";
import { afterAll, describe, expect, it, spyOn } from "bun:test";
import * as processes from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, sep } from "node:path";
import { checkOf, type AgentProfile, type CheckId, type State, type Task } from "@petrina/core";
import { Connections } from "../src/connection.js";
import { Engine, type EngineOptions } from "./engine.js";
import { AgentRun } from "../src/acp-run.js";
import { AGENT_CHECK_TIMEOUT_MS, CHECK_TIMEOUT_MS, checkAgentTool, checkGh, checkGit, codeFolders, expandPath, findClones, originUrl } from "../src/setup.js";
import { Store } from "../src/store.js";
import { ToolChecks } from "../src/tool-checks.js";
import { ADAPTERS, ENGINE_PROFILES, findProgram } from "../src/tools.js";
import { EngineProcess, FAKE_GH, Fakes, git, makeProduct, makeWorld, removeDir, SLOW, tempDir, testGitEnv, waitFor } from "./support.js";

const fake = join(import.meta.dir, "fake-agent.ts");
const fakeGh = join(import.meta.dir, "fake-gh.ts");
const temp = tempDir("petrina-setup-");
/** The worlds with a stand-in GitHub, each in a folder of its own. */
const worlds: string[] = [];
afterAll(() => {
  removeDir(temp);
  for (const dir of worlds) removeDir(dir);
});

let made = 0;
const fresh = (name: string) => join(temp, `${name}-${(made += 1)}`);

/**
 * Fake agents per tool: "ok", logged out (refusing conversations), not logged in (opening conversations
 * and asking for a login only at the first message, as Claude Code does), one that never says whether
 * it is logged in, one that exits as it starts, one that never opens a conversation, or one that never
 * opens one and ignores being told to stop.
 */
type Behaviour = "ok" | "logged-out" | "not-logged-in" | "silent-login" | "wont-start" | "hang" | "stubborn" | "silent-stubborn";
const agents = (tools: Partial<Record<CheckId, Behaviour>>, dir?: string): EngineOptions["agentCommand"] => (profile: AgentProfile) => {
  const behaviour = tools[profile.toolId as CheckId] ?? (["grok", "antigravity"].includes(profile.toolId) ? "logged-out" : "ok");
  const flags = behaviour === "ok" ? [] : behaviour === "stubborn" ? ["--hang", "--stubborn"] : behaviour === "silent-stubborn" ? ["--silent-login", "--stubborn"] : [`--${behaviour}`];
  // Like the real Grok, which sends no login report: it signs in as a conversation opens, and refuses it logged out.
  if (profile.toolId === "grok" && !flags.includes("--silent-login")) flags.push("--silent-login");
  return [process.execPath, fake, ...(dir ? [dir] : []), ...flags];
};

/** Wait for a condition, answering the inbox like a coordinator who approves everything. */
async function until(engine: Engine, done: (state: State) => boolean, ms = 60_000): Promise<State> {
  const started = Date.now();
  const seen = new Set<string>();
  for (;;) {
    const state = engine.getState();
    if (done(state)) return state;
    if (Date.now() - started > ms * SLOW) throw new Error(`Timed out. Tasks: ${JSON.stringify(state.tasks.map((task) => [task.state, task.statusLine, task.error]))}`);
    for (const item of state.inbox) {
      if (seen.has(item.id) || item.kind === "stuck") continue;
      seen.add(item.id);
      if (item.kind === "question") engine.answer(item.id, item.options?.[0] ?? "Yes");
      else if (item.kind === "permission") engine.allow(item.id, "once");
      else engine.approve(item.id);
    }
    await Bun.sleep(50);
  }
}

/**
 * A check's time limit where the test is not about the limit itself. It only catches a hang, and an answer
 * comes as soon as a stand-in gives it, so it is generous: other test runs on the same machine can make a
 * stand-in take seconds just to start.
 */
const LIMIT = 30_000 * SLOW;
/** This machine's programs without the GitHub CLI, whose real check can take long to answer without a network. */
const noGh = (name: string) => (name === "gh" ? null : findProgram(name));

/** Sentences in a text: ends of sentences, ignoring dots inside names like notes.txt. */
const sentences = (text: string) => text.split(/[.!?](?:\s|$)/).filter((part) => part.trim()).length;
/** Why a promise was refused. */
const refusal = (promise: Promise<unknown>) => promise.then(() => "", (error: Error) => error.message);

const status = (engine: Engine, id: CheckId) => checkOf(engine.getState().setup?.checks, id).status;
const taskOf = (state: State, id: string) => state.tasks.find((task) => task.id === id)!;
/** Every tool a task's plan and timeline used. */
const toolsUsed = (engine: Engine, task: Task) => {
  const toolOf = (profileId: string | undefined) => engine.getState().profiles.find((profile) => profile.id === profileId)?.toolId;
  const planned = (task.plan?.stages ?? []).flatMap((stage) => [...stage.profileIds, ...(stage.reviewerProfileIds ?? [])]);
  const worked = task.timeline.map((entry) => entry.profileId).filter(Boolean);
  return new Set([...planned, ...worked, task.plan?.plannerProfileId].map(toolOf).filter(Boolean));
};

describe("Tool status", () => {
  for (const timedOut of [false, true]) {
    it(`keeps the ${timedOut ? "deadline" : "startup error"} ahead of noisy connector logs`, async () => {
      let budget: number | undefined;
      const starting = spyOn(AgentRun, "start").mockImplementation(async (options) => {
        budget = options.startTimeoutMs;
        options.callbacks.onLog?.("earlier debug\n".repeat(200) + "last connector diagnostic");
        if (timedOut) await new Promise<void>((resolve) => options.signal.addEventListener("abort", () => resolve(), { once: true }));
        throw new Error("The connector could not open a session.");
      });
      try {
        const result = await checkAgentTool({
          adapter: ADAPTERS["claude-code"]!, profile: ENGINE_PROFILES[0]!, command: ["test-only"],
          cwd: temp, env: {}, which: () => null, ...(timedOut ? { timeoutMs: 500 } : {}),
        });
        expect(result.status).toBe("unknown");
        expect(result.detail?.startsWith(timedOut ? "Claude Code did not answer within " : "The connector could not open a session.")).toBe(true);
        expect(result.detail).toContain("last connector diagnostic");
        expect(result.detail!.length).toBeLessThan(802);
        expect(budget).toBe(timedOut ? 500 : AGENT_CHECK_TIMEOUT_MS);
        expect(AGENT_CHECK_TIMEOUT_MS).toBe(30_000);
        expect(CHECK_TIMEOUT_MS).toBe(8_000);
      } finally { starting.mockRestore(); }
    });
  }

  it("tells Ready, Not logged in and Couldn't check apart for agent tools, without sending the AI a message", async () => {
    const fakes = new Fakes(fresh("fakes"));
    const data = fresh("data");
    const engine = new Engine(data, { agentCommand: agents({ codex: "logged-out" }, fakes.dir), toolCheckTimeoutMs: LIMIT });
    try {
      await engine.checkTools();
      expect(status(engine, "claude-code")).toBe("ready");
      // A fake agent that asks for a login shows Not logged in.
      expect(status(engine, "codex")).toBe("logged-out");
      // Opened a conversation the way an agent does, in Petrina's own empty folder, and said nothing to it.
      expect(fakes.opens().length).toBeGreaterThan(0);
      expect(fakes.prompts()).toEqual([]);
      for (const opened of fakes.opens()) expect(fakes.settings(opened.session)).toEqual([]);
      const conversations = readdirSync(join(fakes.dir, "conversations")).map((file) => JSON.parse(readFileSync(join(fakes.dir, "conversations", file), "utf8")) as { cwd: string });
      for (const conversation of conversations) expect(conversation.cwd).toBe(join(data, "checks"));
    } finally {
      engine.shutdown();
    }
  });

  it("takes the tool's own word on its login: a conversation that opens is not enough for Ready", async () => {
    const fakes = new Fakes(fresh("fakes"));
    const cwd = fresh("checks"); mkdirSync(cwd);
    const deadline = new AbortController();
    let opened!: () => void;
    const codexOpened = new Promise<void>((resolve) => { opened = resolve; });
    const original = AgentRun.start.bind(AgentRun);
    const gone: Promise<void>[] = [];
    const starting = spyOn(AgentRun, "start").mockImplementation(async (options) => {
      const run = await original(options);
      if (options.profile.toolId === "codex") opened();
      return run;
    });
    const command = agents({ "claude-code": "not-logged-in", codex: "silent-login" }, fakes.dir)!;
    let checking: Promise<Awaited<ReturnType<typeof checkAgentTool>>[]> | undefined;
    try {
      checking = Promise.all(["claude-code", "codex"].map((id) => {
        const profile = ENGINE_PROFILES.find((profile) => profile.toolId === id)!;
        return checkAgentTool({ adapter: ADAPTERS[id]!, profile, command: command(profile), env: testGitEnv(), cwd, which: () => null, ...(id === "codex" ? { signal: deadline.signal } : {}), onGone: (done) => gone.push(done) });
      }));
      // The missing report, rather than real elapsed time, is what this test exercises.
      await Promise.race([codexOpened, checking.then(() => { throw new Error("The login probes ended before the silent conversation opened"); })]);
      deadline.abort();
      const [claude, codex] = await checking;
      expect(fakes.opens().length).toBe(2);
      expect(claude!.status).toBe("logged-out");
      // A tool that never says is Couldn't check, never Ready.
      expect(codex!.status).toBe("unknown");
      expect(codex!.detail).toContain("did not say whether it is logged in");
      expect(fakes.prompts()).toEqual([]);
    } finally {
      deadline.abort(); await checking?.catch(() => {}); await Promise.allSettled(gone); starting.mockRestore();
    }
  });

  it("shows Couldn't check for a tool that will not start, and Not installed when its program is missing", async () => {
    const engine = new Engine(fresh("data"), { agentCommand: agents({ "claude-code": "wont-start" }) });
    try {
      await engine.checkTools();
      expect(status(engine, "claude-code")).toBe("unknown");
      expect(checkOf(engine.getState().setup?.checks, "claude-code").detail).toBeTruthy();
    } finally {
      engine.shutdown();
    }
    const bare = new Engine(fresh("data"), { which: () => null });
    try {
      await bare.checkTools();
      for (const id of ["claude-code", "codex", "git", "node"] as const) expect(status(bare, id)).toBe("not-installed");
      // The Library reads the agent tools from here too.
      expect(bare.getState().tools.find((tool) => tool.id === "codex")?.status).toBe("not-installed");
    } finally {
      bare.shutdown();
    }
  });

  for (const behaviour of ["stubborn", "silent-stubborn"] as const) {
    it(`honors a short check deadline for a tool that ${behaviour === "stubborn" ? "never opens a conversation" : "never reports its login"} and ignores being stopped, stops it, and never piles up copies`, async () => {
      const timeoutMs = 2_000;
      const fakes = new Fakes(fresh("fakes"));
      const command = agents({ "claude-code": behaviour, codex: behaviour }, fakes.dir)!;
      const data = fresh("data");
      const cwd = join(data, "checks");
      mkdirSync(cwd, { recursive: true });
      // Follow the actual children: historical PIDs can name another process after an exit on Windows.
      const active = new Set<processes.ChildProcess>();
      const prepared: processes.ChildProcess[] = [];
      let most = 0;
      const spawn = processes.spawn;
      const watching = spyOn(processes, "spawn").mockImplementation(((...args: Parameters<typeof processes.spawn>) => {
        if (Array.isArray(args[1]) && args[1].includes("--stubborn")) {
          const child = prepared.shift();
          if (!child) throw new Error("A tool check started an unprepared replacement");
          return child;
        }
        return Reflect.apply(spawn, processes, args) as processes.ChildProcess;
      }) as typeof processes.spawn);
      // Count the engine's attempts separately from the prepared children, including an unwanted replacement.
      let starts = 0;
      let stopping = 0;
      const start = AgentRun.start.bind(AgentRun);
      const opening = spyOn(AgentRun, "start").mockImplementation((options) => start({
        ...options,
        onGone: (gone) => {
          stopping += 1;
          void gone.then(() => { stopping -= 1; });
          options.onGone?.(gone);
        },
      }));
      const engine = new Engine(data, {
        toolCheckTimeoutMs: timeoutMs,
        agentCommand: (profile) => {
          if (profile.toolId === "claude-code" || profile.toolId === "codex") starts += 1;
          return command(profile);
        },
      });
      const prepare = async () => {
        expect(active.size).toBe(0);
        expect(stopping).toBe(0);
        writeFileSync(join(fakes.dir, "pids"), "");
        // Cold process startup is unrelated to the check's deadline. Start the same real stand-ins
        // first, and hand them to AgentRun only once their SIGTERM handlers are installed. The engine
        // still owns the real handshake, deadline, forced stop and confirmed cleanup of every copy.
        for (const id of ["claude-code", "codex"] as const) {
          const profile = ENGINE_PROFILES.find((entry) => entry.toolId === id)!;
          const [program, ...args] = command(profile)!;
          const child = spawn(program!, args, { cwd, env: testGitEnv(), stdio: ["pipe", "pipe", "pipe"], detached: process.platform !== "win32", windowsHide: true });
          prepared.push(child);
          active.add(child);
          most = Math.max(most, active.size);
          child.once("exit", () => active.delete(child));
          child.once("error", () => { if (child.pid === undefined) active.delete(child); });
        }
        await waitFor(() => {
          const path = join(fakes.dir, "pids");
          const ready = new Set(existsSync(path) ? readFileSync(path, "utf8").trim().split("\n").map(Number) : []);
          return prepared.every((child) => child.pid !== undefined && ready.has(child.pid));
        }, "both stop-resistant tools to start", 20_000);
        expect(active.size).toBe(2);
      };
      try {
        await prepare();
        const from = Date.now();
        await engine.checkTools();
        const took = Date.now() - from;
        // The check's own limit, not the minute a step gets to start: Continue is never held for long.
        expect(took).toBeGreaterThanOrEqual(timeoutMs - 100);
        expect(took).toBeLessThan((timeoutMs + 2_000) * SLOW);
        for (const id of ["claude-code", "codex"] as const) {
          expect(status(engine, id)).toBe("unknown");
          expect(checkOf(engine.getState().setup?.checks, id).detail).toContain(behaviour === "stubborn" ? "did not answer within 2 seconds" : "did not say whether it is logged in within 2 seconds");
        }
        expect(starts).toBe(2);
        expect(prepared).toHaveLength(0);
        expect(fakes.opens()).toHaveLength(behaviour === "stubborn" ? 0 : 2);

        // Cleanup may outlast a recheck's bounded wait on a busy machine. Wait for
        // its completion here; controlled cases below cover rechecks while it is pending.
        await waitFor(() => active.size === 0 && stopping === 0, "the first hung tools and their cleanup to finish", 6_000);
        await prepare();
        // Concurrent rechecks join one new check per tool once the old one is gone.
        await Promise.all([engine.checkTools(), engine.checkTools(), engine.checkTools()]);
        expect(most).toBe(2);
        expect(starts).toBe(4);
        expect(prepared).toHaveLength(0);
        expect(fakes.opens()).toHaveLength(behaviour === "stubborn" ? 0 : 4);
        for (const id of ["claude-code", "codex"] as const) expect(status(engine, id)).toBe("unknown");
        // Every copy is stopped, though each ignored being asked.
        await waitFor(() => active.size === 0 && stopping === 0, "the hung tools and their cleanup to finish", 6_000);
      } finally {
        const shutdown = engine.shutdown();
        for (const child of active) child.kill("SIGKILL");
        try {
          await shutdown;
          await waitFor(() => active.size === 0 && stopping === 0, "all tool-check children to exit after shutdown", 6_000);
        } finally {
          opening.mockRestore();
          watching.mockRestore();
        }
      }
    }, 60_000 * SLOW);
  }

  for (const releaseDuringCheck of [true, false]) {
    it(`joins rechecks during cleanup and ${releaseDuringCheck ? "starts once cleanup finishes" : "reports still stopping, then recovers after cleanup"}`, async () => {
      let release!: () => void;
      const gone = new Promise<void>((done) => { release = done; });
      const starting = spyOn(AgentRun, "start");
      starting.mockImplementationOnce(async (options) => {
        options.onGone?.(gone);
        throw new Error("The tool could not open a conversation.");
      });
      starting.mockImplementationOnce(async (options) => {
        options.onGone?.(Promise.resolve());
        options.callbacks.onAuthStatus?.("account");
        return { stop: async () => true } as unknown as AgentRun;
      });
      const engine = new Engine(fresh("data"), { agentCommand: agents({}) });
      const tools = new ToolChecks(engine);
      try {
        await tools.check("codex");
        expect(status(engine, "codex")).toBe("unknown");
        const next = tools.check("codex");
        expect(tools.check("codex")).toBe(next);
        expect(tools.check("codex")).toBe(next);
        await new Promise((done) => setImmediate(done));
        expect(starting).toHaveBeenCalledTimes(1);
        if (releaseDuringCheck) release();
        await next;
        if (!releaseDuringCheck) {
          expect(starting).toHaveBeenCalledTimes(1);
          expect(status(engine, "codex")).toBe("unknown");
          expect(checkOf(engine.getState().setup?.checks, "codex").detail).toContain("still stopping after its last check");
          release();
          await gone;
          await tools.check("codex");
        }
        expect(starting).toHaveBeenCalledTimes(2);
        expect(status(engine, "codex")).toBe("ready");
      } finally {
        release();
        await tools.shutdown();
        await engine.shutdown();
        starting.mockRestore();
      }
    });
  }

  it.skipIf(process.platform === "win32")("looks tools up on the PATH as it is now, as the Library does, so a Petrina opened from the Dock finds them", async () => {
    const bin = fresh("bin");
    mkdirSync(bin, { recursive: true });
    symlinkSync(Bun.which("git")!, join(bin, "git"));
    const node = Bun.which("node");
    if (node) symlinkSync(node, join(bin, "node"));
    // A GitHub CLI that only fails: no real one ever answers Couldn't check here.
    symlinkSync(Bun.which("false")!, join(bin, "gh"));
    const path = process.env.PATH;
    const engine = new Engine(fresh("data"));
    try {
      // App mode merges the login shell's PATH in after Petrina started.
      process.env.PATH = bin;
      expect(findProgram("gh")).toBe(join(bin, "gh"));
      const checking = engine.checkTools();
      // Grok isn't on this PATH: Not installed at once, never a Checking row that goes away again.
      expect(checkOf(engine.getState().setup?.checks, "grok")).toMatchObject({ id: "grok", status: "not-installed" });
      expect(checkOf(engine.getState().setup?.checks, "grok").checking).toBeUndefined();
      await checking;
      expect(status(engine, "gh")).toBe("unknown");
      expect(status(engine, "git")).toBe("ready");
      if (node) expect(status(engine, "node")).toBe("ready");
      // Not on this PATH, though they may be on the one Petrina started with.
      expect(status(engine, "claude-code")).toBe("not-installed");
      expect(status(engine, "codex")).toBe("not-installed");
    } finally {
      process.env.PATH = path;
      engine.shutdown();
    }
  });

  it("checks Git and Node.js, and on a Mac never runs Git without Apple's developer tools", async () => {
    const which = () => process.execPath;
    expect((await checkGit(which, "linux")).status).toBe("ready");
    expect((await checkGit(() => null, "linux")).status).toBe("not-installed");
    // /usr/bin/git without the developer tools is a stand-in that would open Apple's installer.
    const noTools = await checkGit(() => "/usr/bin/git", "darwin", { developerTools: async () => ({ kind: "missing" }) });
    expect(noTools.status).toBe("not-installed");
    const emptyTools = await checkGit(() => "/usr/bin/git", "darwin", { developerTools: async () => ({ kind: "found", path: fresh("no-git-here") }) });
    expect(emptyTools.status).toBe("not-installed");
    const fakes = new Fakes(fresh("git-node-gh"));
    const engine = new Engine(fresh("data"), {
      which: (name) => name === "node" ? null : process.execPath,
      gh: [process.execPath, fakeGh, join(fakes.dir, "github.json"), join(fakes.dir, "github.git")],
      agentCommand: agents({}), toolCheckTimeoutMs: LIMIT,
    });
    try {
      await engine.checkTools();
      expect(status(engine, "git")).toBe("ready");
      expect(status(engine, "node")).toBe("not-installed");
    } finally {
      engine.shutdown();
    }
  });

  it("reads the GitHub CLI's login and account", async () => {
    const fakes = new Fakes(fresh("gh"));
    const gh = [process.execPath, fakeGh, join(fakes.dir, "github.json"), join(fakes.dir, "github.git")];
    expect(await checkGh(gh, LIMIT)).toEqual({ status: "ready", account: "octocat" });
    fakes.github((state) => (state.loggedOut = true));
    expect((await checkGh(gh, LIMIT)).status).toBe("logged-out");
    fakes.github((state) => {
      state.loggedOut = false;
      state.offline = true;
    });
    expect((await checkGh(gh, LIMIT)).status).toBe("unknown");
    expect((await checkGh([join(temp, "no-such-gh")])).status).toBe("not-installed");
  });
});

/** A folder that looks like a clone: a .git folder with an origin, and its last change. */
function clone(path: string, url: string, changedAt: number, extra = ""): void {
  mkdirSync(join(path, ".git"), { recursive: true });
  writeFileSync(join(path, ".git", "config"), `[core]\n\tbare = false\n${extra}[remote "origin"]\n\turl = ${url}\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n`);
  writeFileSync(join(path, ".git", "HEAD"), "ref: refs/heads/main\n");
  const when = new Date(changedAt);
  utimesSync(join(path, ".git", "HEAD"), when, when);
  utimesSync(join(path, ".git"), when, when);
}

describe("The clone finder", () => {
  it("finds only GitHub clones, two levels deep, newest first, reading files and running nothing", async () => {
    const home = fresh("home");
    const marker = join(temp, "ran-something");
    const now = Date.now();
    clone(join(home, "code", "shop"), "git@github.com:acme/shop.git", now - 1000, `\tfsmonitor = touch ${marker}\n`);
    clone(join(home, "code", "acme", "blog"), "https://github.com/acme/blog.git", now);
    clone(join(home, "Projects", "old"), "https://github.com/acme/old", now - 100_000);
    clone(join(home, "code", "elsewhere"), "https://gitlab.com/acme/elsewhere.git", now);
    clone(join(home, "code", "a", "b", "too-deep"), "https://github.com/acme/deep.git", now);
    // A worktree has a .git file, not a folder: not a clone of its own.
    mkdirSync(join(home, "code", "worktree"), { recursive: true });
    writeFileSync(join(home, "code", "worktree", ".git"), "gitdir: /somewhere/else\n");
    // A link out of the code folders is never followed.
    const outside = fresh("outside");
    clone(join(outside, "secret"), "https://github.com/acme/secret.git", now);
    symlinkSync(join(outside, "secret"), join(home, "code", "linked"));
    symlinkSync(outside, join(home, "code", "linked-folder"));

    const found = await findClones({ home });
    expect(found.map((entry) => entry.repo)).toEqual(["acme/blog", "acme/shop", "acme/old"]);
    expect(found[1]!.path).toBe(join(home, "code", "shop"));
    // Nothing ran inside the clones: git would have run the fsmonitor setting.
    expect(existsSync(marker)).toBe(false);

    // Nor a link on the way to a code folder: Documents in Documents/GitHub, source in source/repos.
    const documents = fresh("documents-elsewhere");
    clone(join(documents, "GitHub", "private"), "https://github.com/acme/private.git", now);
    symlinkSync(documents, join(home, "Documents"));
    const source = fresh("source-elsewhere");
    clone(join(source, "repos", "hidden"), "https://github.com/acme/hidden.git", now);
    symlinkSync(source, join(home, "source"));
    expect((await findClones({ home, platform: "linux" })).map((entry) => entry.repo)).toEqual(["acme/blog", "acme/shop", "acme/old"]);
    expect((await findClones({ home, platform: "win32" })).map((entry) => entry.repo)).toEqual(["acme/blog", "acme/shop", "acme/old"]);

    for (let index = 0; index < 8; index += 1) clone(join(home, "repos", `r${index}`), `https://github.com/acme/r${index}`, now + index);
    expect(await findClones({ home })).toHaveLength(6);
    expect((await findClones({ home, skip: (path) => path.endsWith("r7") }))[0]!.repo).toBe("acme/r6");
  });

  it("stays out of the folders a Mac guards with a permission window", async () => {
    const home = fresh("home");
    clone(join(home, "Documents", "GitHub", "site"), "https://github.com/acme/site.git", Date.now());
    expect(codeFolders("darwin")).not.toContain(join("Documents", "GitHub"));
    expect((await findClones({ home, platform: "darwin" })).map((entry) => entry.repo)).toEqual([]);
    expect((await findClones({ home, platform: "linux" })).map((entry) => entry.repo)).toEqual(["acme/site"]);
  });

  it("does not follow a shortcut in a clone's history folder", async () => {
    const home = fresh("home");
    const now = Date.now();
    const olderAt = now - 50_000;
    const middleAt = now - 10_000;
    clone(join(home, "code", "older"), "https://github.com/acme/older.git", olderAt);
    clone(join(home, "code", "middle"), "https://github.com/acme/middle.git", middleAt);
    clone(join(home, "code", "newer"), "https://github.com/acme/newer.git", now);
    const outside = fresh("outside-history");
    mkdirSync(outside, { recursive: true });
    const head = join(outside, "HEAD");
    writeFileSync(head, "ref: refs/heads/main\n");
    const future = new Date(now + 100_000);
    utimesSync(head, future, future);
    // The history folder itself points outside the code folders.
    symlinkSync(outside, join(home, "code", "older", ".git", "logs"));
    // A file shortcut inside a real history folder points at the same outside file.
    mkdirSync(join(home, "code", "middle", ".git", "logs"), { recursive: true });
    symlinkSync(head, join(home, "code", "middle", ".git", "logs", "HEAD"));
    // Adding those shortcuts touches the clone's own folder date; put it back, so only a followed link could reorder.
    const olderWhen = new Date(olderAt);
    utimesSync(join(home, "code", "older", ".git"), olderWhen, olderWhen);
    utimesSync(join(home, "code", "older", ".git", "HEAD"), olderWhen, olderWhen);
    const middleWhen = new Date(middleAt);
    utimesSync(join(home, "code", "middle", ".git"), middleWhen, middleWhen);
    utimesSync(join(home, "code", "middle", ".git", "HEAD"), middleWhen, middleWhen);

    expect((await findClones({ home })).map((entry) => entry.repo)).toEqual(["acme/newer", "acme/middle", "acme/older"]);
  });

  it("reads the origin from a git config", () => {
    expect(originUrl(`[remote "upstream"]\n\turl = https://github.com/a/b\n[remote "origin"]\n\turl = git@github.com:me/b.git\n`)).toBe("git@github.com:me/b.git");
    expect(originUrl("[core]\n\tbare = false\n")).toBeUndefined();
  });

  it("hides products already added", async () => {
    const home = fresh("home");
    const repo = makeGitHubClone(join(home, "code", "shop"));
    clone(join(home, "code", "blog"), "https://github.com/acme/blog.git", Date.now());
    const engine = new Engine(fresh("data"), { home, agentCommand: agents({}) });
    try {
      expect((await engine.findClones()).map((entry) => entry.repo).sort()).toEqual(["acme/blog", "acme/shop"]);
      await engine.addProduct(repo);
      expect((await engine.findClones()).map((entry) => entry.repo)).toEqual(["acme/blog"]);
      // Saved paths may use another spelling of the same folder (Git uses forward slashes on Windows).
      engine.s.products[0]!.path = `${repo}${sep}.`;
      expect((await engine.findClones()).map((entry) => entry.repo)).toEqual(["acme/blog"]);
    } finally {
      engine.shutdown();
    }
  });
});

/** A real clone whose origin says github.com. */
function makeGitHubClone(path: string): string {
  mkdirSync(path, { recursive: true });
  git(path, "init", "-q", "-b", "main");
  git(path, "config", "user.email", "test@example.com");
  git(path, "config", "user.name", "Test");
  writeFileSync(join(path, "README.md"), "# Shop\n");
  git(path, "add", ".");
  git(path, "commit", "-q", "-m", "init");
  git(path, "remote", "add", "origin", "https://github.com/acme/shop.git");
  mkdirSync(join(path, "src", "checkout"), { recursive: true });
  return path;
}

describe("Adding a product", () => {
  it("takes ~ and subfolders, and says plainly why a folder cannot be added", async () => {
    const home = fresh("home");
    const repo = makeGitHubClone(join(home, "code", "shop"));
    const local = makeProduct(fresh("local"));
    writeFileSync(join(home, "notes.txt"), "not a folder\n");
    mkdirSync(join(home, "plain"));
    const engine = new Engine(fresh("data"), { home, agentCommand: agents({}) });
    try {
      const id = await engine.addProduct("~/code/shop/src/checkout");
      const product = engine.getState().products.find((entry) => entry.id === id)!;
      expect(product.repo).toBe("acme/shop");
      expect(product.delivery).toBe("pull-request");
      expect(product.path && git(product.path, "rev-parse", "--show-toplevel")).toBe(git(repo, "rev-parse", "--show-toplevel"));
      // Adding it again opens the one already there, never a second product.
      expect(await engine.addProduct(repo)).toBe(id);
      await expectRejection(engine.addProduct("~/nowhere"), "There is no folder at ~/nowhere.");
      await expectRejection(engine.addProduct("~/notes.txt"), "~/notes.txt is a file, so pick the folder you cloned the product into.");
      await expectRejection(engine.addProduct("~/plain"), "That folder isn't a copy of a repository, so pick the folder you cloned the product into.");
      // Each refusal is one plain sentence.
      for (const input of ["~/nowhere", "~/notes.txt", "~/plain"]) expect(sentences(await refusal(engine.addProduct(input)))).toBe(1);
      // A clone that is not linked to GitHub keeps its finished work on this machine.
      const localId = await engine.addProduct(local);
      expect(engine.getState().products.find((entry) => entry.id === localId)?.delivery).toBe("local");
      expect(engine.getState().products).toHaveLength(2);
    } finally {
      engine.shutdown();
    }
    const noGit = new Engine(fresh("data"), { home, which: (name) => (name === "git" ? null : Bun.which(name)) });
    try {
      await expectRejection(noGit.addProduct(repo), /Git isn't installed: run .+ then try again/);
      expect(sentences(await refusal(noGit.addProduct(repo)))).toBe(1);
    } finally {
      noGit.shutdown();
    }
  });

  it("adds an http or git-protocol GitHub clone as a pull request", async () => {
    const home = fresh("schemes");
    const httpRepo = makeGitHubClone(join(home, "code", "http-shop"));
    git(httpRepo, "remote", "set-url", "origin", "http://github.com/acme/http-shop.git");
    const gitRepo = makeGitHubClone(join(home, "code", "git-shop"));
    git(gitRepo, "remote", "set-url", "origin", "git://github.com/acme/git-shop.git");
    const elsewhere = makeGitHubClone(join(home, "code", "elsewhere"));
    git(elsewhere, "remote", "set-url", "origin", "http://gitlab.com/acme/elsewhere.git");
    const engine = new Engine(fresh("data"), { home, agentCommand: agents({}) });
    try {
      expect((await findClones({ home })).map((entry) => entry.repo).sort()).toEqual(["acme/git-shop", "acme/http-shop"]);
      for (const path of [httpRepo, gitRepo]) {
        const id = await engine.addProduct(path);
        const product = engine.getState().products.find((entry) => entry.id === id)!;
        expect(product.delivery).toBe("pull-request");
        // Test the real connection used by fetch and shipping, without a remote override hiding a
        // refused transport; adding the clone alone did not prove that it could be delivered.
        engine.setPoolPaused(true);
        const taskId = engine.addTask({ productId: id, title: "First task" });
        const task = engine.task(taskId)!;
        const connections = new Connections(engine);
        const remote = { url: `https://github.com/${product.repo}.git` };
        expect(await connections.connection(executionFor(task), new AbortController().signal)).toEqual({ ok: true, remote });
        expect(connections.savedRemote(executionFor(task))).toEqual(remote);
        expect(product.remote).toBe(git(path, "config", "--get", "remote.origin.url"));
      }
      const localId = await engine.addProduct(elsewhere);
      expect(engine.getState().products.find((entry) => entry.id === localId)?.delivery).toBe("local");
    } finally {
      engine.shutdown();
    }
  });

  it("expands pasted paths", () => {
    expect(expandPath("~", "/home/me", "linux")).toBe("/home/me");
    expect(expandPath(" ~/code/shop ", "/home/me", "linux")).toBe("/home/me/code/shop");
    expect(expandPath("'/Users/me/My Code/shop'", "/home/me", "darwin")).toBe("/Users/me/My Code/shop");
    expect(expandPath("/Users/me/My\\ Code/shop", "/home/me", "darwin")).toBe("/Users/me/My Code/shop");
    expect(expandPath("code/shop", "/home/me", "linux")).toBe("/home/me/code/shop");
    expect(expandPath("~")).toBe(homedir());
    expect(expandPath("~", "C:\\Users\\me", "win32")).toBe("C:\\Users\\me");
    expect(expandPath("~/code/shop", "C:\\Users\\me", "win32")).toBe("C:\\Users\\me\\code\\shop");
    expect(expandPath("~\\code\\shop", "C:\\Users\\me", "win32")).toBe("C:\\Users\\me\\code\\shop");
    expect(expandPath('"C:\\My Code\\shop"', "C:\\Users\\me", "win32")).toBe("C:\\My Code\\shop");
    expect(expandPath("code/shop", "C:\\Users\\me", "win32")).toBe("C:\\Users\\me\\code\\shop");
    expect(expandPath("\\\\server\\share\\shop", "C:\\Users\\me", "win32")).toBe("\\\\server\\share\\shop");
  });
});

describe("Setup and the first task", () => {
  it("starts a fresh install on first run, keeps where it got to, and finishes it once the first task is saved", async () => {
    const data = fresh("data");
    const repo = makeGitHubClone(fresh("shop"));
    let engine = new Engine(data, { agentCommand: agents({}) });
    try {
      expect(engine.getState().setup).toMatchObject({ done: false });
      engine.setSetupStep("tools");
      engine.setSetupStep("product");
      engine.setSetupStep("welcome");
      expect(engine.getState().setup?.step).toBe("product");
      const productId = await engine.addProduct(repo);
      engine.shutdown();
      // Closed partway: it reopens where it got to.
      engine = new Engine(data, { agentCommand: agents({}) });
      expect(engine.getState().setup).toMatchObject({ done: false, step: "product" });

      engine.setPoolPaused(true);
      const first = { productId, title: "Add a greeting", approvePlan: true, clientId: "first-task-1" };
      const id = engine.startFirstTask(first);
      // Sent again after the reply was lost: the same task, not a second card.
      expect(engine.startFirstTask(first)).toBe(id);
      expect(engine.getState().tasks).toHaveLength(1);
      expect(engine.getState().setup).toMatchObject({ done: true, firstTaskId: id });
      // A genuinely new task is never refused as a resend.
      engine.addTask({ productId, title: "Another", clientId: "other-1" });
      expect(engine.getState().tasks).toHaveLength(2);
      engine.dismissTip();
      engine.shutdown();
      engine = new Engine(data, { agentCommand: agents({}) });
      expect(engine.getState().setup).toMatchObject({ done: true, firstTaskId: id, tipDismissed: true });
      expect(engine.getState().tasks).toHaveLength(2);
    } finally {
      engine.shutdown();
    }
  });

  it("never shows first run to an install that already has products or tasks, and Skip setup is for good", async () => {
    const existing = fresh("data");
    mkdirSync(existing, { recursive: true });
    const store = new Store(join(existing, "petrina.db"));
    const blank = new Engine(fresh("data"));
    const before = structuredClone(blank.getState());
    blank.shutdown();
    store.save({ ...before, setup: undefined, products: [{ id: "shop", name: "Shop", repo: "acme/shop", tone: "blue" }] } as unknown as State);
    store.close();
    const updated = new Engine(existing);
    expect(updated.getState().setup?.done).toBe(true);
    updated.shutdown();

    const data = fresh("data");
    let engine = new Engine(data);
    expect(engine.getState().setup?.done).toBe(false);
    engine.skipSetup();
    engine.shutdown();
    engine = new Engine(data);
    expect(engine.getState().setup?.done).toBe(true);
    engine.shutdown();
  });

  it("opens only its own guides", () => {
    const engine = new Engine(fresh("data"));
    try {
      expect(() => engine.openGuide("https://example.com/")).toThrow("only opens the guides");
    } finally {
      engine.shutdown();
    }
  });
});

describe("The squad uses tools that are ready", () => {
  it("keeps usage replacements on tools allowed by the login checks, including an unconfirmed tool when none is Ready", () => {
    const engine = new Engine(fresh("usage-data"));
    const until = Date.now() + 60_000;
    try {
      for (const checks of [
        [{ id: "claude-code", status: "ready" }, { id: "codex", status: "logged-out" }],
        [{ id: "claude-code", status: "ready" }, { id: "codex", status: "unknown" }],
        [{ id: "claude-code", status: "unknown" }, { id: "codex", status: "not-installed" }],
      ] as const) {
        engine.s.setup!.checks = checks.map((check) => ({ ...check }));
        // An exhausted tool never hands the step to a logged-out, missing, or lower-priority tool.
        engine.s.pool.limited = [{ toolId: "claude-code", until, reason: "Usage limit" }];
        expect(engine.choose("opus-high")).toMatchObject({ kind: "none" });
        // A limit on just Opus can still use the same tool's standby model.
        engine.s.pool.limited[0]!.model = "opus";
        expect(engine.choose("opus-high")).toMatchObject({ kind: "substitute", profile: { id: "sonnet-high", toolId: "claude-code" } });
      }
      engine.s.setup!.checks = [{ id: "claude-code", status: "ready" }, { id: "codex", status: "ready" }];
      engine.s.pool.limited = [{ toolId: "claude-code", until, reason: "Usage limit" }];
      expect(engine.choose("opus-high")).toMatchObject({ kind: "substitute", profile: { toolId: "codex" } });
    } finally {
      engine.shutdown();
    }
  });

  // A product on GitHub (a folder stands in for it), delivering a release: the Release Manager, an agent, writes its notes.
  const run = async (tools: Partial<Record<CheckId, Behaviour>>, options: EngineOptions = {}) => {
    const w = makeWorld("tools", { version: "1.0.0" });
    worlds.push(w.dir);
    const engine = new Engine(w.data, { agentCommand: agents(tools), gh: [process.execPath, FAKE_GH, join(w.dir, "github.json"), w.remote], remote: w.remote, toolCheckTimeoutMs: LIMIT, ...options });
    await engine.checkTools();
    const productId = await engine.addProduct(w.clone);
    engine.setProductDelivery(productId, "release", false);
    const taskId = engine.addTask({ productId, title: "Add a greeting", description: "A greeting file." });
    return { engine, taskId, w };
  };

  for (const [only, other] of [
    ["claude-code", "codex"],
    ["codex", "claude-code"],
  ] as const) {
    it(`plans, designs, builds, reviews and ships entirely on ${only} when ${other} is not logged in`, async () => {
      // Each logged out the way its tool is: Claude Code still opens conversations, Codex refuses them.
      const { engine, taskId } = await run({ [other]: other === "claude-code" ? "not-logged-in" : "logged-out" });
      try {
        expect(status(engine, other)).toBe("logged-out");
        const state = await until(engine, (current) => ["done", "failed"].includes(taskOf(current, taskId).state));
        const task = taskOf(state, taskId);
        expect(task.error).toBeUndefined();
        expect(task.state).toBe("done");
        expect(task.release?.tag).toMatch(/^v\d+\.\d+\.\d+$/);
        expect([...toolsUsed(engine, task)]).toEqual([only]);
        for (const role of ["planner", "architect", "design-reviewer", "builder", "code-reviewer", "release-manager"]) {
          expect(task.timeline.some((entry) => entry.roleId === role)).toBe(true);
        }
        // Journey records the tools that actually worked, rather than the planner's original choices.
        const steps = task.journey!.filter((step) => step.kind === "agent");
        expect(steps.some((step) => step.roleId === "planner")).toBe(true);
        for (const step of steps) {
          for (const profileId of step.team ?? [step.profileId!]) {
            expect(state.profiles.find((profile) => profile.id === profileId)?.toolId).toBe(only);
          }
        }
      } finally {
        engine.shutdown();
      }
    });
  }

  it("keeps plans exactly as they were when both tools are ready", async () => {
    const { engine, taskId } = await run({});
    try {
      const state = await until(engine, (current) => !!taskOf(current, taskId).plan);
      const task = taskOf(state, taskId);
      expect(task.plan!.plannerProfileId).toBe("opus-high");
      expect(task.plan!.stages.map((stage) => [stage.roleId, [...stage.profileIds, ...(stage.reviewerProfileIds ?? [])]])).toEqual([
        ["architect", ["opus-xhigh", "sol-xhigh"]],
        ["architect", []],
        ["builder", ["sol-xhigh"]],
        ["code-reviewer", ["opus-high", "sol-high"]],
        ["release-manager", ["opus-high"]],
      ]);
    } finally {
      engine.shutdown();
    }
  });

  it("counts a logged-in Grok, which sends no login report, as Ready at once, so it still stands in when the others run out of usage", async () => {
    const engine = new Engine(fresh("data"), { agentCommand: agents({ grok: "ok" }), which: noGh, toolCheckTimeoutMs: LIMIT });
    try {
      const from = Date.now();
      await engine.checkTools();
      // Grok's answer is the conversation opening, not a report that never comes: no wait for the time limit.
      expect(Date.now() - from).toBeLessThan(LIMIT - 1_000);
      for (const id of ["claude-code", "codex", "grok"] as const) expect(status(engine, id)).toBe("ready");
      expect(checkOf(engine.getState().setup?.checks, "grok").detail).toBeUndefined();
      expect(engine.usableTools()).toEqual(["claude-code", "codex", "grok"]);
      // Claude Code and Codex both out of usage: Grok takes the step, as on main.
      engine.s.pool.limited = [
        { toolId: "claude-code", until: Date.now() + 120_000, reason: "Claude Code's usage limit" },
        { toolId: "codex", until: Date.now() + 120_000, reason: "Codex's usage limit" },
      ];
      const choice = engine.choose("opus-xhigh");
      expect(choice?.kind).toBe("substitute");
      expect(choice?.kind === "substitute" && choice.profile.toolId).toBe("grok");
    } finally {
      engine.shutdown();
    }
  });

  it("shows a logged-out Grok as Not logged in: it refuses the conversation, as the real one does", async () => {
    const fakes = new Fakes(fresh("fakes"));
    const engine = new Engine(fresh("data"), { agentCommand: agents({ grok: "logged-out" }, fakes.dir), which: noGh, toolCheckTimeoutMs: LIMIT });
    try {
      await engine.checkTools();
      expect(status(engine, "grok")).toBe("logged-out");
      expect(status(engine, "claude-code")).toBe("ready");
      expect(engine.usableTools()).toEqual(["claude-code", "codex"]);
      expect(fakes.prompts()).toEqual([]);
    } finally {
      engine.shutdown();
    }
  });

  it("keeps main's third tool available through planning, review and delivery", async () => {
    const { engine, taskId } = await run({ "claude-code": "logged-out", codex: "logged-out", grok: "ok" });
    try {
      const state = await until(engine, (current) => ["done", "failed"].includes(taskOf(current, taskId).state));
      const task = taskOf(state, taskId);
      expect(task.error).toBeUndefined();
      expect(task.state).toBe("done");
      expect([...toolsUsed(engine, task)]).toEqual(["grok"]);
    } finally {
      engine.shutdown();
    }
  });

  it("tries a tool it couldn't check when none is ready, and names it in a Stuck item when it will not start", async () => {
    const { engine, taskId } = await run({ "claude-code": "logged-out", codex: "wont-start" });
    try {
      expect(status(engine, "claude-code")).toBe("logged-out");
      expect(status(engine, "codex")).toBe("unknown");
      const state = await until(engine, (current) => current.inbox.some((item) => item.kind === "stuck"));
      const item = state.inbox.find((entry) => entry.kind === "stuck")!;
      expect(item.toolId).toBe("codex");
      expect(item.title).toContain("Codex wouldn't start");
      expect(item).toMatchObject({ toolProblem: "wont-start" });
      expect(item.body).toContain("to see whether Codex works");
      const task = taskOf(state, taskId);
      expect(task.timeline.filter((entry) => entry.text === "Planner started" && entry.profileId === "sol-high")).toHaveLength(1);
      const planner = task.journey!.find((step) => step.roleId === "planner")!;
      expect(planner).toMatchObject({ profileId: "sol-high", end: "failed", outcome: "Stuck", reason: task.error });
      expect(task.timeline.find((entry) => entry.text === "Stuck: Codex wouldn't start")?.step).toBe(planner.id);
      expect(task.journey!.at(-1)).toMatchObject({ kind: "you", waitsFor: "stuck" });
      // Never on the tool that is not logged in.
      expect(toolsUsed(engine, task).has("claude-code")).toBe(false);
    } finally {
      engine.shutdown();
    }
  });

  it("gives up on a tool that hangs as it starts, and names it in a Stuck item with its fix and what happened", async () => {
    // Readiness is unknown immediately; this case exercises the real agent-start deadline, not another readiness wait.
    const command = agents({ "claude-code": "logged-out", codex: "hang" })!;
    const { engine, taskId } = await run({ "claude-code": "logged-out", codex: "hang" }, { startTimeoutMs: 1_500, agentCommand: (profile) => profile.toolId === "codex" ? [...command(profile)!, "--exit-in-checks"] : command(profile) });
    try {
      expect(status(engine, "claude-code")).toBe("logged-out");
      expect(status(engine, "codex")).toBe("unknown");
      const state = await until(engine, (current) => current.inbox.some((item) => item.kind === "stuck"));
      const item = state.inbox.find((entry) => entry.kind === "stuck")!;
      expect(item).toMatchObject({ toolId: "codex", toolProblem: "wont-start" });
      expect(item.title).toContain("Codex wouldn't start");
      expect(item.body).toContain("to see whether Codex works");
      expect(item.detail).toContain("Codex did not start within 2 seconds");
      expect(taskOf(state, taskId)).toMatchObject({ state: "failed", statusLine: "Stuck: Codex wouldn't start" });
      expect(taskOf(state, taskId).timeline.filter((entry) => entry.text === "Planner started" && entry.profileId === "sol-high")).toHaveLength(1);
    } finally {
      engine.shutdown();
    }
  });

  it("raises a Stuck item for a tool that is not logged in, and Retry checks it again before trying", async () => {
    const fakes = new Fakes(fresh("fakes"));
    // Only Codex, and it is logged out: nothing usable, so the planner's own tool is named.
    const engine = new Engine(fresh("data"), { agentCommand: agents({ codex: "logged-out", "claude-code": "logged-out" }, fakes.dir), toolCheckTimeoutMs: LIMIT });
    try {
      await engine.checkTools();
      const productId = await engine.addProduct(makeProduct(fresh("product")));
      const taskId = engine.addTask({ productId, title: "Add a greeting" });
      const state = await until(engine, (current) => current.inbox.some((item) => item.kind === "stuck"));
      const item = state.inbox.find((entry) => entry.kind === "stuck")!;
      expect(item.toolId).toBe("claude-code");
      expect(item).toMatchObject({ toolProblem: "logged-out" });
      expect(item.title).toContain("Claude Code isn't logged in");
      expect(item.body).toContain("not logged in");
      // Petrina never started the agent: its fix came first.
      expect(fakes.prompts()).toEqual([]);
      // No agent ever started: show only the wait for the coordinator, never a failed agent box.
      expect(taskOf(state, taskId).journey).toEqual([expect.objectContaining({ kind: "you", waitsFor: "stuck" })]);
      await engine.retry(item.id);
      expect(engine.getState().inbox.some((entry) => entry.id === item.id)).toBe(true);
      expect(taskOf(engine.getState(), taskId).timeline.at(-1)?.text).toBe("Checked Claude Code again: it is still not logged in");
    } finally {
      engine.shutdown();
    }
  });
});

describe("Delivering to GitHub", () => {
  it("asks for a GitHub login before shipping, and nothing ships half way", async () => {
    const w = makeWorld("login");
    worlds.push(w.dir);
    const fakes = new Fakes(w.dir);
    fakes.scenario({ planner: "short", builder: "plain" });
    w.setGitHub((github) => (github.loggedOut = true));
    // Its own process, the way the app runs it, with a folder standing in for GitHub.
    const engine = await EngineProcess.harness(join(w.dir, "home"), w.dir, w.remote);
    try {
      const productId = (await engine.act("addProduct", w.clone)) as string;
      await engine.act("setProductDelivery", productId, "pull-request", false);
      const taskId = (await engine.act("addTask", { productId, title: "Add a greeting" })) as string;
      let state = await engine.until((current) => current.inbox.some((item) => item.kind === "stuck"), "a Stuck item");
      const item = state.inbox.find((entry) => entry.kind === "stuck")!;
      expect(item.toolId).toBe("gh");
      expect(item.title).toContain("GitHub CLI isn't logged in");
      expect(item.body).toContain("not logged in");
      expect(taskOf(state, taskId).shipping).toBeUndefined();
      // Nothing went to GitHub: no branch, no pull request.
      expect(w.github().calls.filter((call) => call[1] === "create")).toEqual([]);
      expect(w.github().logins).toBeGreaterThan(0);

      w.setGitHub((github) => (github.loggedOut = false));
      await engine.act("retry", item.id);
      state = await engine.until((current) => ["pr-open", "failed"].includes(taskOf(current, taskId).state), "the pull request");
      expect(taskOf(state, taskId).error).toBeUndefined();
      expect(taskOf(state, taskId).pr?.number).toBe(1);
      expect(w.github().prs).toHaveLength(1);
    } finally {
      await engine.quit();
    }
  });
});
