import { afterAll } from "bun:test";
import { engineProcessCases } from "../../support.js";
import { setupWithCleanup } from "@petrina/test-support/setup-with-cleanup";
import { shutdownActors, alive, pidsIn } from "../../fixtures/shutdown-actors.js";
import { slowStopFixture } from "../../fixtures/slow-stop.js";
// Quit the real engine process while fake agents are active, then restart: none may survive the old engine.
import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Engine } from "../../engine.js";
import { ADAPTERS } from "@petrina/agent-runtime/tools";
import { parseChildState, readProcessList } from "@petrina/platform/process-tree";
import { EngineProcess, Fakes, makeProduct, tempDir, waitFor, waitForFile } from "../../support.js";

const cases = engineProcessCases();
afterAll(() => cases.close());


describe("Stopping during startup", () => {
  it("quits while startup tool checks ignore being stopped, leaving none of their agents running", async () => {
    const dir = tempDir("petrina-probes-quit-");
    let stopPeers = async (): Promise<void> => {};
    return cases.use(dir, async owners => {
    const actors = await shutdownActors(dir);
    stopPeers = () => actors.close();
    const fakes = new Fakes(join(dir, "fake"));
    const engine = new Engine(join(dir, "data"), {
      agentCommand: () => [process.execPath, actors.actor, fakes.dir, "--hang", "--stubborn"],
      which: (name) => name === "gh" ? null : Bun.which(name),
    });
    stopPeers = async () => { const settled = await Promise.allSettled([engine.shutdown(), actors.close()]); const errors = settled.flatMap(result => result.status === "rejected" ? [result.reason] : []); if (errors.length) throw new AggregateError(errors, "Startup fixture peers did not all stop"); };
    const pids = () => pidsIn(join(fakes.dir, "pids"));
    const checking = owners.prepare(() => engine.checkTools());
    const probeCount = Object.keys(ADAPTERS).length;

    const cleanup = async () => {
      await engine.shutdown();
      await checking;
      await actors.close();

    };
    const result = await setupWithCleanup(async () => {
      await waitFor(() => pids().filter(alive).length === probeCount, "every startup probe");
      await engine.shutdown();
      await checking;
      expect(pids().filter(alive)).toEqual([]);
      // Nothing new starts after quitting, even if another check was requested meanwhile.
      await engine.checkTools();
      expect(pids()).toHaveLength(probeCount);

    }, cleanup);
    await cleanup();
    return result;
    }, { stopPeers: () => stopPeers() });
  });


});

describe.concurrent("Quitting stops agents before the engine exits", () => {
  for (const when of ["starting", "working", "reviewing in parallel"] as const) it(`stops every agent ${when}, before a restart can touch the same files`, async () => {
    const dir = tempDir("petrina-agent-quit-");
    let stopPeers = async (): Promise<void> => {};
    return cases.use(dir, async owners => {
    const home = join(dir, "data");
    const actors = await shutdownActors(dir);
    stopPeers = () => actors.close();
    const fakes = new Fakes(join(dir, "fake"));
    const pids = () => pidsIn(join(fakes.dir, "processes"));
    fakes.scenario(when === "starting" ? { silent: true } : { controlled: true, builder: "plain" });
    // appendFileSync creates the file before writing the first id. An empty read must not become pid 0
    // (our process group), pass the startup wait, or be signalled by cleanup.
    if (when === "starting") writeFileSync(join(fakes.dir, "processes"), "");
    let engine: EngineProcess | undefined;

    const cleanup = async () => {
      if (engine?.proc.exitCode === null) await engine.quit().catch(() => engine!.kill());
      await actors.close();

    };
    const result = await setupWithCleanup(async () => {
      engine = await owners.harness(home, fakes.dir, undefined, { extra: [`--agent-program=${actors.actor}`] });
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
      engine = await owners.harness(home, fakes.dir, undefined, { extra: [`--agent-program=${actors.actor}`] });
      await waitFor(() => pids().some((pid) => !before.includes(pid) && alive(pid)), "the restarted step's agent");
      expect(before.filter(alive)).toEqual([]);
      const next = pids().filter(alive);
      await engine.quit();
      expect(next.filter(alive)).toEqual([]);

    }, cleanup);
    await cleanup();
    return result;
    }, { stopPeers: () => stopPeers() });
  });

  for (const { stubborn, killFirst, native } of [
    { stubborn: false, killFirst: false, native: false },
    { stubborn: true, killFirst: false, native: false },
    { stubborn: true, killFirst: true, native: false },
    { stubborn: true, killFirst: false, native: true },
  ]) it.skipIf(process.platform === "win32")(`waits for a ${native ? "native" : "slow"} process lookup before removing a cancelled build's copy, and still quits on time${stubborn ? " with an agent that ignores stopping" : ""}${killFirst ? " when the first lookup is killed" : ""}`, async () => {
    const dir = tempDir("petrina-slow-agent-stop-");
    let stopPeers = async (): Promise<void> => {};
    return cases.use(dir, async owners => {
    const { actors, home, fakes, hold, slow, scanned, recover, killed, buildPids, finalLists, stops, launcher } = await slowStopFixture(dir, owners, stubborn, killFirst, native);
    stopPeers = () => actors.close();
    let engine: EngineProcess | undefined;

    const cleanup = async () => {
      if (engine?.proc.exitCode === null) await engine.quit().catch(() => engine!.kill());
      await actors.close();

    };
    const result = await setupWithCleanup(async () => {
      engine = await owners.harness(home, fakes.dir, undefined, { entry: launcher, extra: stubborn ? ["--stubborn"] : [] });
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

    }, cleanup);
    await cleanup();
    return result;
    }, { stopPeers: () => stopPeers() });
  });
});
