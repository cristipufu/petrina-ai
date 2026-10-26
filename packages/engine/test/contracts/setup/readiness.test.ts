import { fixtureFiles } from "@petrina/test-support/fixture-files";
import { afterAll, describe, expect, it, spyOn } from "bun:test";
import * as processes from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { checkOf } from "@petrina/core";
import { stopOwnedProcess } from "@petrina/platform/owned-process";
import { engineProcessCases } from "../../support.js";
import { shutdownActors } from "../../fixtures/shutdown-actors.js";
import { Engine } from "../../engine.js";
import { AgentRun } from "@petrina/agent-runtime/acp-run";
import { checkGit } from "@petrina/repositories/tool-readiness";
import { ToolChecks } from "../../../src/tool-checks.js";
import { ENGINE_PROFILES, findProgram } from "@petrina/agent-runtime/tools";
import { Fakes } from "../../support.js";
import { SLOW } from "@petrina/test-support/slow";
import { testGitEnv } from "@petrina/test-support/test-git-env";
import { tempDir, waitFor } from "@petrina/test-support/fixtures";
import { setupFixtures } from "../../fixtures/setup.js";

const { fakeGh, fresh, agents, status, LIMIT } = setupFixtures();
const probeCases = engineProcessCases();
afterAll(() => probeCases.close());

describe("Tool status", () => {
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
      await engine.shutdown();
    }
  });
it("shows Couldn't check for a tool that will not start, and Not installed when its program is missing", async () => {
    const engine = new Engine(fresh("data"), { agentCommand: agents({ "claude-code": "wont-start" }) });
    try {
      await engine.checkTools();
      expect(status(engine, "claude-code")).toBe("unknown");
      expect(checkOf(engine.getState().setup?.checks, "claude-code").detail).toBeTruthy();
    } finally {
      await engine.shutdown();
    }
    const bare = new Engine(fresh("data"), { which: () => null });
    try {
      await bare.checkTools();
      for (const id of ["claude-code", "codex", "git", "node"] as const) expect(status(bare, id)).toBe("not-installed");
      // The Library reads the agent tools from here too.
      expect(bare.getState().tools.find((tool) => tool.id === "codex")?.status).toBe("not-installed");
    } finally {
      await bare.shutdown();
    }
  });
for (const behaviour of ["stubborn", "silent-stubborn"] as const) {
    it(`honors a short check deadline for a tool that ${behaviour === "stubborn" ? "never opens a conversation" : "never reports its login"} and ignores being stopped, stops it, and never piles up copies`, async () => {
      const timeoutMs = 2_000;
      const root = tempDir("petrina-setup-probes-");
      const active = new Set<processes.ChildProcess>();
      const native: { child: processes.ChildProcess; ended: Promise<number>; closed: Promise<void> }[] = [];
      const prepared: processes.ChildProcess[] = [];
      const restores: (() => void)[] = [];
      let actors: Awaited<ReturnType<typeof shutdownActors>> | undefined;
      let nativeEngine: Engine | undefined;
      let stopping = 0;
      const request = (stop: () => void | Promise<void>) => Promise.resolve().then(stop);
      // The case owner exists before lease acquisition, Engine startup or detached native admission.
      return probeCases.use(root, async owners => {
      actors = await owners.prepare(() => shutdownActors(root));
      if (owners.signal.aborted) {
        await actors.close();
        throw new Error("Setup probes closed before their native programs were admitted");
      }
      const fakes = new Fakes(join(root, "fake"));
      const unleased = agents({ "claude-code": behaviour, codex: behaviour }, fakes.dir)!;
      const command = (profile: Parameters<typeof unleased>[0]) => {
        const [program, _entry, ...args] = unleased(profile)!;
        return [program!, actors!.actor, ...args];
      };
      const data = join(root, "data"), cwd = join(data, "checks");
      mkdirSync(cwd, { recursive: true });
      // Follow the actual children: historical PIDs are observations, never cleanup authority.
      let most = 0;
      const spawn = processes.spawn;
      const watching = spyOn(processes, "spawn");
      restores.push(() => watching.mockRestore());
      watching.mockImplementation(((...args: Parameters<typeof processes.spawn>) => {
        if (Array.isArray(args[1]) && args[1].includes("--stubborn")) {
          const child = prepared.shift();
          if (!child) throw new Error("A tool check started an unprepared replacement");
          return child;
        }
        return Reflect.apply(spawn, processes, args) as processes.ChildProcess;
      }) as typeof processes.spawn);
      // Count the engine's attempts separately from the prepared children, including an unwanted replacement.
      let starts = 0;
      const start = AgentRun.start.bind(AgentRun);
      const opening = spyOn(AgentRun, "start");
      restores.push(() => opening.mockRestore());
      opening.mockImplementation((options) => start({
        ...options,
        onGone: (gone) => {
          stopping += 1;
          void gone.then(() => { stopping -= 1; });
          options.onGone?.(gone);
        },
      }));
      const engine = nativeEngine = new Engine(data, {
        toolCheckTimeoutMs: timeoutMs,
        agentCommand: (profile) => {
          if (profile.toolId === "claude-code" || profile.toolId === "codex") starts += 1;
          return command(profile);
        },
      });
      const prepare = async () => {
        if (owners.signal.aborted) throw new Error("Setup probes are closing; no new preparation may start");
        expect(active.size).toBe(0);
        expect(stopping).toBe(0);
        writeFileSync(join(fakes.dir, "pids"), "");
        // Cold process startup is unrelated to the check's deadline. Start the same real stand-ins
        // first, and hand them to AgentRun only once their SIGTERM handlers are installed. The engine
        // still owns the real handshake, deadline, forced stop and confirmed cleanup of every copy.
        for (const id of ["claude-code", "codex"] as const) {
          const profile = ENGINE_PROFILES.find((entry) => entry.toolId === id)!;
          const [program, ...args] = command(profile)!;
          if (owners.signal.aborted) throw new Error("Setup probes are closing; no detached probe may start");
          const child = spawn(program!, args, { cwd, env: testGitEnv(), stdio: ["pipe", "pipe", "pipe"], detached: process.platform !== "win32", windowsHide: true });
          // Record native exit and descriptor closure independently of AgentRun's later handoff.
          const ended = new Promise<number>((resolve, reject) => {
            child.once("exit", (code, signal) => code !== null ? resolve(code) : signal ? resolve(128) : reject(new Error("The prepared probe has no native end record")));
            child.once("error", reject);
          });
          const closed = new Promise<void>((resolve, reject) => {
            child.once("close", (code, signal) => code !== null || signal !== null ? resolve() : reject(new Error("The prepared probe did not confirm native descriptor closure")));
            child.once("error", reject);
          });
          void ended.catch(() => undefined); void closed.catch(() => undefined);
          native.push({ child, ended, closed });
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
        }, "both stop-resistant tools to start", 20_000, { during: Promise.race(native.slice(-2).map(record => record.closed)) });
        expect(active.size).toBe(2);
      };
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
      }, { stopPeers: async () => {
        // Fallback follows every subject assertion. Request all independent stops before joining any.
        const work = [request(() => nativeEngine?.shutdown()), request(() => actors?.close()), ...native.map(record => request(async () => {
          record.child.stdout?.resume(); record.child.stderr?.resume();
          const stopped = await stopOwnedProcess({ exited: record.ended,
            get exitCode() { return record.child.exitCode; }, get signalCode() { return record.child.signalCode; },
            kill: signal => record.child.kill(signal),
          }, { graceMs: 100, forceMs: 1_000 }, (expired, ms) => { const timer = setTimeout(expired, ms); return () => clearTimeout(timer); });
          if (stopped !== "confirmed") throw new Error("The prepared probe's native stop was not confirmed; root retained");
          await record.closed;
        }))];
        const settled = await Promise.allSettled(work);
        const restored = await Promise.allSettled(restores.map(restore => request(restore)));
        const errors = [...settled, ...restored].flatMap(result => result.status === "rejected" ? [result.reason] : []);
        if (errors.length) throw new AggregateError(errors, "Setup probe cleanup was not confirmed; root retained");
        await waitFor(() => active.size === 0 && stopping === 0, "all tool-check children to exit after shutdown", 6_000);
      } });
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
    fixtureFiles.fileLink(Bun.which("git")!, join(bin, "git"));
    const node = Bun.which("node");
    if (node) fixtureFiles.fileLink(node, join(bin, "node"));
    // A GitHub CLI that only fails: no real one ever answers Couldn't check here.
    fixtureFiles.fileLink(Bun.which("false")!, join(bin, "gh"));
    const path = process.env.PATH;
    // This boundary case deliberately discovers the fake programs planted on PATH, rather than
    // the fixture's ordinary scripted-service defaults. No real account tool is present on it.
    const engine = new Engine(fresh("data"), { which: findProgram, gh: undefined });
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
      await engine.shutdown();
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
      await engine.shutdown();
    }
  });
});
