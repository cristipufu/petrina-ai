// Quit the real engine process while fake agents are active, then restart: none may survive the old engine.
import { afterAll, describe, expect, it } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AgentRun } from "../src/acp-run.js";
import { Engine } from "./engine.js";
import { ADAPTERS, ENGINE_PROFILES } from "../src/tools.js";
import { parseChildState, readProcessList } from "../src/process-tree.js";
import { EngineProcess, Fakes, HARNESS, makeProduct, removeDir, tempDir, testBrowserRoot, waitFor, waitForFile } from "./support.js";

// Conversations started here keep their browsers, in this file's own browser folder.
const browsers = testBrowserRoot();
afterAll(() => removeDir(browsers));

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
      browserTempRoot: browsers,
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
      const productId = await engine.act("addProduct", await makeProduct(dir));
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

  for (const { stubborn, killFirst, native } of [
    { stubborn: false, killFirst: false, native: false },
    { stubborn: true, killFirst: false, native: false },
    { stubborn: true, killFirst: true, native: false },
    { stubborn: true, killFirst: false, native: true },
  ]) it.skipIf(process.platform === "win32")(`waits for a ${native ? "native" : "slow"} process lookup before removing a cancelled build's copy, and still quits on time${stubborn ? " with an agent that ignores stopping" : ""}${killFirst ? " when the first lookup is killed" : ""}`, async () => {
    const dir = tempDir("petrina-slow-agent-stop-");
    const home = join(dir, "data");
    const fakes = new Fakes(join(dir, "fake"));
    const hold = join(dir, "hold");
    const slow = join(dir, "slow");
    const scanned = join(dir, "scanned"), recover = join(dir, "recover");
    const killed = join(dir, "killed");
    const buildPids = join(dir, "build-pids");
    const snapshot = join(dir, "process-list");
    const finalLists = join(dir, "final-lists");
    const stops = join(dir, "stops");
    const bin = join(dir, "bin");
    mkdirSync(bin);
    // The first delayed/killed helper is real. Recovery and final confirmation use scripted
    // reads in the engine, without starting another helper inside a shrinking read allowance.
    // The separate native case covers real discovery, pausing and stopping with no injected delay.
    // Recovery belongs to the next invocation, even if the first helper never runs its TERM trap.
    const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
    writeFileSync(join(bin, "ps"), `#!/bin/sh
if [ -f ${quote(slow)} ]; then
  listed=$(while IFS= read -r row; do printf '%s\n' "$row"; done < ${quote(snapshot)}) || exit 1
  first=0
  if (set -C; : > ${quote(scanned)}) 2>/dev/null; then first=1; fi
  delay=0.1
  if [ "$first" = 1 ]; then delay=${stubborn ? "3.9" : "1.1"}; else : > ${quote(recover)}; fi
  ${killFirst ? `if [ "$first" = 1 ]; then
    /bin/sleep 3
    : > ${quote(killed)}
    kill -KILL $$
  fi` : ""}
  /bin/sleep "$delay" &
  sleeper=$!
  trap 'kill "$sleeper" 2>/dev/null; wait "$sleeper"; exit 143' TERM INT
  wait "$sleeper"
  printf '%s\n' "$listed"
  exit 0
fi
exec /bin/ps "$@"
`);
    chmodSync(join(bin, "ps"), 0o755);
    // Complete the Mac's first run of this fresh stand-in before measuring the stop deadline.
    const ready = Bun.spawn([join(bin, "ps"), "-A", "-o", "pid=,ppid="], { stdout: "ignore", stderr: "pipe" });
    expect(await ready.exited, await new Response(ready.stderr).text()).toBe(0);
    if (!native) {
      // Unavailable scripted data is a failed read, never a successful empty process list.
      writeFileSync(slow, "");
      const absent = Bun.spawn([join(bin, "ps"), "-A", "-o", "pid=,ppid=,stat="], { stdout: "pipe", stderr: "ignore" });
      expect(await absent.exited).toBe(1);
      expect(await new Response(absent.stdout).text()).toBe("");
      expect(existsSync(scanned)).toBe(false);
      rmSync(slow);
    }
    const launcher = join(dir, "engine.ts");
    writeFileSync(launcher, `import { appendFileSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
${native ? "" : `import * as processes from "node:child_process";
import { spyOn } from "bun:test";
import { finishedHelper, runCommand } from ${JSON.stringify(join(import.meta.dir, "fixtures.ts"))};
// Before the timed stop, read the engine's inherited group for complete final snapshots.
const ownGroup = Number((await runCommand(["/bin/ps", "-o", "pgid=", "-p", String(process.pid)])).stdout.trim());
if (!ownGroup) throw new Error("Could not read the fixture engine's process group");
process.env.PATH = ${JSON.stringify(bin)} + ":" + process.env.PATH;
const kill = process.kill.bind(process), paused = new Set(), owners = new Map(), agents = new Set(), forced = new Set();
const live = pid => { try { kill(pid, 0); return true; } catch { return false; } };
const listing = groups => [
  { pid: process.pid, parent: process.ppid, group: ownGroup },
  // The agent and its detached workers each lead their own process group.
  ...[...owners].map(([pid, parent]) => ({ pid, parent, group: pid })),
].filter(({ pid }) => live(pid) || (${killFirst} && agents.has(pid) && forced.has(pid))).map(({ pid, parent, group }) =>
  pid + " " + (groups ? group : parent) + " " + (forced.has(pid) ? "Z" : paused.has(pid) ? "T" : "S")).join("\\n") + "\\n";
const publish = () => {
  writeFileSync(${JSON.stringify(snapshot + ".tmp")}, listing(false));
  renameSync(${JSON.stringify(snapshot + ".tmp")}, ${JSON.stringify(snapshot)});
};
// Scripted states follow successful real signals to this fixture's known processes.
// Native late-fork tests and the native case below check the actual OS pause barrier.
process.kill = function(pid, signal) {
  // The killed-helper case also keeps a forced agent's number present until collection.
  // Only the final process-group snapshot can then confirm its completed stop.
  if (${killFirst} && signal === 0 && agents.has(Math.abs(pid)) && forced.has(Math.abs(pid))) return true;
  const result = kill(pid, signal);
  if (signal === "SIGKILL" && owners.has(Math.abs(pid)) && existsSync(${JSON.stringify(slow)})) forced.add(Math.abs(pid));
  if (signal === "SIGSTOP" && agents.has(Math.abs(pid)) && existsSync(${JSON.stringify(slow)}) && existsSync(${JSON.stringify(buildPids)})) {
    const workers = readFileSync(${JSON.stringify(buildPids)}, "utf8").split("\\n").map(Number).filter(pid => pid > 0 && live(pid));
    for (const worker of workers) owners.set(worker, Math.abs(pid));
  }
  if (signal === "SIGSTOP") paused.add(Math.abs(pid));
  if (signal === "SIGCONT") paused.delete(Math.abs(pid));
  if (signal === "SIGSTOP" || signal === "SIGCONT") publish();
  return result;
};
const original = processes.execFile;
spyOn(processes, "execFile").mockImplementation((...args) => {
  if (args[0] !== "ps" || !existsSync(${JSON.stringify(slow)}) || !existsSync(${JSON.stringify(scanned)})) return Reflect.apply(original, processes, args);
  const groups = args[1].some(arg => arg.includes("pgid="));
  const listed = listing(groups), timeout = args[2].timeout, done = args.at(-1);
  writeFileSync(${JSON.stringify(recover)}, "");
  if (groups) appendFileSync(${JSON.stringify(finalLists)}, JSON.stringify(listed) + "\\n");
  setTimeout(() => done(timeout <= 100 ? new Error("Process list timed out") : null, timeout <= 100 ? "" : listed, ""), Math.min(100, timeout));
  return finishedHelper();
});`}
const { AgentRun, AGENT_CLEANUP_NOTE } = await import(${JSON.stringify(join(import.meta.dir, "../src/acp-run.ts"))});
const start = AgentRun.start;
AgentRun.start = function(options) {
  return start.call(this, { ...options, callbacks: { ...options.callbacks, onLog(text) {
    if (text.includes(AGENT_CLEANUP_NOTE)) console.error(text.trim());
    options.callbacks.onLog?.(text);
  } }, ${native ? "" : `onProcess(child) {
    agents.add(child.pid); owners.set(child.pid, process.pid); publish();
    options.onProcess?.(child);
  }`} });
};
const stop = AgentRun.prototype.stop;
const observed = new WeakSet();
AgentRun.prototype.stop = function(...args) {
  const started = Date.now(), pending = stop.apply(this, args);
  if (!observed.has(this)) {
    observed.add(this);
    void pending.then(
      complete => {
        const evidence = { pid: this.child.pid, elapsed: Date.now() - started, complete };
        appendFileSync(${JSON.stringify(stops)}, JSON.stringify(evidence) + "\\n");
        console.info("Agent stop evidence:", JSON.stringify(evidence));
      },
      error => console.error("Agent stop error:", JSON.stringify({ pid: this.child.pid, elapsed: Date.now() - started, error: String(error) })),
    );
  }
  return pending;
};
await import(${JSON.stringify(HARNESS)});`);
    writeFileSync(hold, "");
    writeFileSync(join(fakes.dir, "agents.json"), JSON.stringify({ hold: { title: "Long build", file: hold }, background: { title: "Long build", pids: buildPids } }));
    let engine: EngineProcess | undefined;
    try {
      engine = await EngineProcess.start(home, [launcher, home, fakes.dir, ...(stubborn ? ["--stubborn"] : [])]);
      const productId = await engine.act("addProduct", await makeProduct(dir));
      for (const end of ["cancel", "quit"] as const) {
        // A first lookup near its limit may time out under contention. Recovery must then
        // be available; forcing every lookup past its deadline cannot prove child cleanup.
        for (const file of [slow, scanned, recover, killed]) rmSync(file, { force: true });
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
        const agents = pidsIn(join(fakes.dir, "processes")).filter(alive);
        expect(agents.length).toBeGreaterThan(0);
        if (!native) writeFileSync(slow, "");
        if (end === "cancel") {
          await engine.act("cancel", id);
          const state = await engine.until((state) => !!state.tasks.find((task) => task.id === id)?.cleanup, "the first cleanup attempt after the build stopped");
          const remaining = pids.filter(alive);
          const listed = remaining.length ? await readProcessList(4_000) : undefined;
          const task = state.tasks.find((task) => task.id === id)!;
          if (remaining.length) console.error("Cancelled build cleanup evidence:", JSON.stringify({ native, stubborn, killFirst, cleanup: task.cleanup, timeline: task.timeline.slice(-8), processes: listed?.split("\n").filter(line => remaining.includes(Number(line.trim().split(/\s+/)[0]))), log: readFileSync(join(home, "engine.log"), "utf8").split("\n").slice(-40) }));
          expect(remaining).toEqual([]);
          expect(state.tasks.find((task) => task.id === id)?.cleanup?.removedAt).toBeDefined();
          expect(existsSync(copy)).toBe(false);
        } else {
          const elapsed = await engine.quit();
          const remaining = [...pids, ...agents].filter(alive);
          if (remaining.length) {
            const listed = await readProcessList(4_000);
            console.error("Engine quit evidence:", JSON.stringify({ elapsed, buildPids: pids, agents, processes: listed?.split("\n").filter(line => remaining.includes(Number(line.trim().split(/\s+/)[0]))), log: readFileSync(join(home, "engine.log"), "utf8").split("\n").slice(-40) }));
          }
          expect(elapsed).toBeLessThan(10_000);
          expect(remaining).toEqual([]);
          expect(readFileSync(join(home, "engine.log"), "utf8")).toContain("Petrina engine stopped");
          expect(existsSync(copy)).toBe(true);
        }
        const recorded = readFileSync(stops, "utf8").trim().split("\n").map(line => JSON.parse(line) as { pid: number; complete: boolean });
        if (agents.some(pid => !recorded.find(stop => stop.pid === pid)?.complete)) console.error("Incomplete agent stop evidence:", JSON.stringify({ end, native, stubborn, killFirst, agents, recorded, log: readFileSync(join(home, "engine.log"), "utf8").split("\n").slice(-40) }));
        for (const pid of agents) expect(recorded.find(stop => stop.pid === pid)?.complete).toBe(true);
        if (killFirst) {
          expect(existsSync(killed)).toBe(true);
          const final = readFileSync(finalLists, "utf8").trim().split("\n").map(line => JSON.parse(line) as string);
          for (const pid of agents) expect(final.some(listed => listed.split("\n").includes(`${pid} ${pid} Z`))).toBe(true);
        }
        // Outside the stop's allowance, verify real processes even when all scripted reads passed.
        const after = await waitFor(() => readProcessList(4_000), "a native process list after the build stopped");
        expect([...pids, ...agents].filter(pid => parseChildState(after, pid) !== "ended")).toEqual([]);
        if (existsSync(recover)) console.info(`Used the recovery process lookup during ${end} (stubborn: ${stubborn}, first killed: ${killFirst}).`);
      }
    } finally {
      if (engine?.proc.exitCode === null) await engine.quit().catch(() => engine!.kill());
      for (const pid of [...pidsIn(buildPids), ...pidsIn(join(fakes.dir, "processes"))].filter(alive)) { try { process.kill(pid, "SIGKILL"); } catch {} }
      removeDir(dir);
    }
  });
});
