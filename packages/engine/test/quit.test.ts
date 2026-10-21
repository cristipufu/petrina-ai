// Quit the real engine process while fake agents are active, then restart: none may survive the old engine.
import { describe, expect, it } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AgentRun } from "../src/acp-run.js";
import { Engine } from "../src/engine.js";
import { ADAPTERS, ENGINE_PROFILES } from "../src/tools.js";
import { EngineProcess, Fakes, HARNESS, makeProduct, removeDir, tempDir, waitFor, waitForFile } from "./support.js";

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const pidsIn = (path: string) => existsSync(path) ? readFileSync(path, "utf8").split("\n").map(Number).filter((pid) => Number.isSafeInteger(pid) && pid > 0) : [];

describe("Stopping during startup", () => {
  it("quits while startup tool checks ignore being stopped, leaving none of their agents running", async () => {
    const dir = tempDir("petrina-probes-quit-");
    const fakes = new Fakes(join(dir, "fake"));
    const engine = new Engine(join(dir, "data"), {
      agentCommand: () => [process.execPath, join(import.meta.dir, "fake-agent.ts"), fakes.dir, "--hang", "--stubborn"],
      which: (name) => name === "gh" ? null : Bun.which(name),
    });
    const pids = () => pidsIn(join(fakes.dir, "pids"));
    const checking = engine.checkTools();
    const probeCount = Object.keys(ADAPTERS).length;
    try {
      await waitFor(() => pids().filter(alive).length === probeCount, "every startup probe");
      await engine.shutdown();
      await checking;
      expect(pids().filter(alive)).toEqual([]);
      // Nothing new starts after quitting, even if another check was requested meanwhile.
      await engine.checkTools();
      expect(pids()).toHaveLength(probeCount);
    } finally {
      await engine.shutdown();
      await checking;
      for (const pid of pids().filter(alive)) { try { process.kill(pid, "SIGKILL"); } catch {} }
      removeDir(dir);
    }
  });

  for (const probe of [true, false]) it(probe ? "lets a tool check report while its stubborn agent stops" : "waits for a task's stubborn agent to stop before releasing its copy", async () => {
    const dir = tempDir("petrina-startup-stop-");
    const fakes = new Fakes(join(dir, "fake"));
    const controller = new AbortController();
    const pids = () => pidsIn(join(fakes.dir, "pids"));
    let gone: Promise<void> | undefined;
    const opening = AgentRun.start({
      profile: ENGINE_PROFILES.find((profile) => profile.toolId === "claude-code")!,
      cwd: dir,
      command: [process.execPath, join(import.meta.dir, "fake-agent.ts"), fakes.dir, "--hang", "--stubborn"],
      signal: controller.signal,
      probe,
      callbacks: { onActivity: () => {}, onPlanStep: () => {}, onPermission: async () => "deny" },
      ...(probe ? { onGone: (stopped: Promise<void>) => { gone = stopped; } } : {}),
    }).then(() => "Opened unexpectedly", (error: Error) => error.message);
    try {
      await waitFor(() => pids().some(alive), "the stubborn agent to start");
      controller.abort();
      expect(await opening).toBe("Stopped before the agent started");
      // The tool check follows onGone before starting another probe. A task has no such observer:
      // its driver cannot release the working copy until startup has finished stopping instead.
      expect(pids().some(alive)).toBe(probe);
      if (gone) await gone;
      await waitFor(() => !pids().some(alive), "the stopped agent to be gone");
    } finally {
      controller.abort();
      await opening;
      for (const pid of pids().filter(alive)) { try { process.kill(pid, "SIGKILL"); } catch {} }
      removeDir(dir);
    }
  });
});

describe.concurrent("Quitting stops agents before the engine exits", () => {
  for (const when of ["starting", "working", "reviewing in parallel"] as const) it(`stops every agent ${when}, before a restart can touch the same files`, async () => {
    const dir = tempDir("petrina-agent-quit-");
    const home = join(dir, "data");
    const fakes = new Fakes(join(dir, "fake"));
    const pids = () => pidsIn(join(fakes.dir, "processes"));
    fakes.scenario(when === "starting" ? { silent: true } : { controlled: true, builder: "plain" });
    // appendFileSync creates the file before writing the first id. An empty read must not become pid 0
    // (our process group), pass the startup wait, or be signalled by cleanup.
    if (when === "starting") writeFileSync(join(fakes.dir, "processes"), "");
    let engine: EngineProcess | undefined;
    try {
      engine = await EngineProcess.harness(home, fakes.dir);
      const productId = await engine.act("addProduct", makeProduct(dir));
      await engine.act("addTask", { productId, title: "Work through a quit", description: "[no-check]" });
      await waitFor(async () => {
        if (when === "starting") return pids().some(alive);
        if (when === "working") return fakes.received("planner").length > 0;
        const state = await engine!.state();
        if (fakes.received("code reviewer").length >= 2 && state.tasks[0]!.helpers?.length) return true;
        for (const prompt of fakes.received()) if (prompt.role !== "code reviewer") writeFileSync(join(fakes.dir, `release-${prompt.session}`), "go");
        for (const item of state.inbox) {
          if (item.kind === "question") await engine!.act("answer", item.id, item.options?.[0] ?? "Yes");
          else if (item.kind === "permission") await engine!.act("allow", item.id, "once");
          else if (["plan", "design"].includes(item.kind)) await engine!.act("approve", item.id);
        }
        return false;
      }, `agents ${when}`, 60_000);
      const before = pids().filter(alive);
      expect(before.length).toBeGreaterThanOrEqual(when === "reviewing in parallel" ? 2 : 1);
      expect(await engine.quit()).toBeLessThan(10_000);
      expect(before.filter(alive)).toEqual([]);
      fakes.scenario({ controlled: true, builder: "plain" });
      engine = await EngineProcess.harness(home, fakes.dir);
      await waitFor(() => pids().some((pid) => !before.includes(pid) && alive(pid)), "the restarted step's agent");
      expect(before.filter(alive)).toEqual([]);
      const next = pids().filter(alive);
      await engine.quit();
      expect(next.filter(alive)).toEqual([]);
    } finally {
      if (engine?.proc.exitCode === null) await engine.quit().catch(() => engine!.kill());
      for (const pid of pids().filter(alive)) { try { process.kill(pid, "SIGKILL"); } catch {} }
      removeDir(dir);
    }
  });

  it.skipIf(process.platform === "win32")("waits for a slow process lookup before removing a cancelled build's copy, and still quits on time", async () => {
    const dir = tempDir("petrina-slow-agent-stop-");
    const home = join(dir, "data");
    const fakes = new Fakes(join(dir, "fake"));
    const hold = join(dir, "hold");
    const slow = join(dir, "slow");
    const buildPids = join(dir, "build-pids");
    const bin = join(dir, "bin");
    mkdirSync(bin);
    // Only this engine gets the delayed process-list stand-in, only once its background build is running.
    const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
    writeFileSync(join(bin, "ps"), `#!/bin/sh\nif [ -f ${quote(slow)} ]; then /bin/sleep 1.1; fi\nexec /bin/ps "$@"\n`);
    chmodSync(join(bin, "ps"), 0o755);
    // Complete the Mac's first run of this fresh stand-in before measuring the
    // production stop deadline. The delayed scan itself must still run for real.
    const ready = Bun.spawn([join(bin, "ps"), "-A", "-o", "pid=,ppid="], { stdout: "ignore", stderr: "pipe" });
    expect(await ready.exited, await new Response(ready.stderr).text()).toBe(0);
    const launcher = join(dir, "engine.ts");
    writeFileSync(launcher, `process.env.PATH = ${JSON.stringify(bin)} + ":" + process.env.PATH; await import(${JSON.stringify(HARNESS)});`);
    writeFileSync(hold, "");
    writeFileSync(join(fakes.dir, "agents.json"), JSON.stringify({ hold: { title: "Long build", file: hold }, background: { title: "Long build", pids: buildPids } }));
    let engine: EngineProcess | undefined;
    try {
      engine = await EngineProcess.start(home, [launcher, home, fakes.dir]);
      const productId = await engine.act("addProduct", makeProduct(dir));
      for (const end of ["cancel", "quit"] as const) {
        rmSync(`${hold}.reached`, { force: true });
        const id = await engine.act("addTask", { productId, title: "Long build", description: "[quick]", delivery: "local" }) as string;
        await waitFor(async () => {
          for (const item of (await engine!.state()).inbox) {
            if (item.kind === "question") await engine!.act("answer", item.id, item.options?.[0] ?? "Yes");
            else if (item.kind === "permission") await engine!.act("allow", item.id, "once");
            else if (["plan", "design"].includes(item.kind)) await engine!.act("approve", item.id);
          }
          return existsSync(`${hold}.reached`);
        }, "the background build");
        const copy = (await engine.task(id)).worktree!;
        await waitForFile(join(copy, "target", "background", "out.bin"));
        const pids = pidsIn(buildPids).filter(alive);
        expect(pids.length).toBeGreaterThan(0);
        writeFileSync(slow, "");
        if (end === "cancel") {
          await engine.act("cancel", id);
          const state = await engine.until((state) => !!state.tasks.find((task) => task.id === id)?.cleanup, "the first cleanup attempt after the build stopped");
          expect(pids.filter(alive)).toEqual([]);
          expect(state.tasks.find((task) => task.id === id)?.cleanup?.removedAt).toBeDefined();
          expect(existsSync(copy)).toBe(false);
        } else {
          const agents = pidsIn(join(fakes.dir, "processes")).filter(alive);
          expect(agents.length).toBeGreaterThan(0);
          expect(await engine.quit()).toBeLessThan(10_000);
          expect([...pids, ...agents].filter(alive)).toEqual([]);
          expect(existsSync(copy)).toBe(true);
        }
      }
    } finally {
      if (engine?.proc.exitCode === null) await engine.quit().catch(() => engine!.kill());
      for (const pid of [...pidsIn(buildPids), ...pidsIn(join(fakes.dir, "processes"))].filter(alive)) { try { process.kill(pid, "SIGKILL"); } catch {} }
      removeDir(dir);
    }
  });
});
