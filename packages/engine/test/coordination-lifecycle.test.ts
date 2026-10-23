import { afterAll, describe, expect, it } from "bun:test";
import { writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { State } from "@petrina/core";
import { EngineClient } from "../src/engine-client.js";
import { LifecycleStore } from "../src/lifecycle.js";
import { FolderLock, readConnection } from "../src/instance.js";
import { CLI, HARNESS, EngineProcess, Fakes, makeProduct, removeDir, tempDir, waitFor, engineEnv, SLOW } from "./support.js";
const roots: string[] = [];
afterAll(() => roots.forEach(removeDir));
async function fixture() {
  const root = tempDir("petrina-coordination-lifecycle-");
  roots.push(root);
  const home = join(root, "home"),
    fakes = new Fakes(join(root, "fakes"));
  fakes.scenario({ controlled: true });
  const engine = await EngineProcess.harness(home, fakes.dir);
  const client = new EngineClient(home);
  const productId = (await engine.act("addProduct", await makeProduct(root))) as string;
  const release = (id: string) => writeFileSync(join(fakes.dir, `release-${id}`), "go");
  const settle = (s: State) => {
    for (const item of s.inbox)
      if (item.kind === "plan") void engine.act("approve", item.id);
      else if (item.kind === "question") void engine.act("answer", item.id, "Yes");
      else if (item.kind === "permission") void engine.act("allow", item.id, "once");
    for (const received of fakes.received()) if (received.role !== "code reviewer" && received.role !== "verifier") release(received.session);
  };
  const stop = async () => {
    try {
      const state = await engine.state();
      for (const task of state.tasks) if (!["done", "cancelled", "pr-open"].includes(task.state)) await engine.act("cancel", task.id);
    } catch {}
    await client.call("engine.stop", { requestId: `cleanup-${Date.now()}`, wait: true, timeoutMs: 3000 * SLOW });
    const c = readConnection(home);
    if (c) {
      try {
        process.kill(c.pid, "SIGKILL");
      } catch {}
    }
  };
  return { root, home, fakes, engine, client, productId, release, settle, stop };
}
describe("graceful coordination lifecycle", () => {
  it("does not let a stale old-owner observation overwrite a starting or ready replacement", () => {
    const root = tempDir("petrina-lifecycle-observation-");
    roots.push(root);
    const store = new LifecycleStore(root);
    try {
      store.begin("restart", { requestId: "handoff" }, "running");
      store.finish("stopping");
      const observed = store.current!;
      store.finish("starting");
      expect(store.failIfUnchanged(observed, "old owner exited")).toBe(false);
      const starting = store.current!;
      store.finish("completed");
      expect(store.failIfUnchanged(starting, "launcher exited")).toBe(false);
      expect(store.receipt("handoff")!.outcome).toBe("completed");
    } finally {
      store.close();
    }
  });

  for (const paused of [false, true])
    it(`restarts concurrent reviewers once, preserving finished peers and ${paused ? "paused" : "running"} scheduling`, async () => {
      const f = await fixture();
      try {
        const taskId = (await f.engine.act("addTask", {
          productId: f.productId,
          title: "Review work",
          description: "[no-check]",
          approveDelivery: true,
        })) as string;
        await waitFor(
          async () => {
            const s = await f.engine.state();
            f.settle(s);
            return f.fakes.received("code reviewer").length >= 2;
          },
          "two admitted reviewers",
          180000,
        );
        const reviewers = [...new Set(f.fakes.received("code reviewer").map((r) => r.session))];
        const before = readConnection(f.home)!;
        if (paused) await f.client.call("engine.pause", { requestId: "pause-first" });
        // One peer's report is saved before restart is requested; the other must finish independently.
        f.release(reviewers[0]!);
        await waitFor(async () => Object.keys((await f.engine.task(taskId)).hunt?.reported ?? {}).length === 1, "first peer's saved report");
        if (paused)
          await waitFor(async () => {
            const status = await f.client.call("engine.status");
            return (status.operation as { phase: string })?.phase === "draining";
          }, "pause still draining");
        // Restart replaces a draining pause while retaining its saved paused preference.
        const first = await f.client.call("engine.restart", { requestId: "restart-once", wait: true, timeoutMs: 5 });
        expect(first.outcome).toBe("timed-out");
        expect(readConnection(f.home)!.pid).toBe(before.pid);
        if (paused) expect((await f.client.call("engine.pause", { requestId: "pause-first" })).outcome).toBe("superseded");
        const openingWindow = await EngineProcess.start(f.home, [CLI, "app"]);
        expect(openingWindow.hello.type).toBe("running");
        expect(await openingWindow.exited(10000 * SLOW)).toBe(0);
        // Closing the original desktop pipe during an authorized handoff cannot interrupt its drain.
        void f.engine.proc.stdin.end();
        const other = await f.client.call("task.add", { productId: f.productId, title: "Stay queued", requestId: "queued-during-drain" });
        expect((await f.engine.task(String(other.taskId))).state).toBe("queued");
        expect((await f.client.call("engine.resume", { requestId: "cannot-bypass" })).outcome).toBe("conflict");
        expect((await f.client.call("engine.restart", { requestId: "restart-once" })).operation).toHaveProperty("id", "restart-once");
        expect((await f.client.call("engine.restart", { requestId: "follow-existing" })).operation).toHaveProperty("id", "restart-once");
        f.release(reviewers[1]!);
        expect((await f.client.call("engine.restart", { requestId: "restart-once", wait: true, timeoutMs: 30000 * SLOW })).outcome).toBe("completed");
        const followed = await f.client.call("engine.restart", { requestId: "follow-existing" });
        expect(followed.outcome).toBe("completed");
        expect(followed.requestId).toBe("follow-existing");
        expect(followed.operation).toHaveProperty("phase", "completed");
        const after = readConnection(f.home)!;
        expect(after.pid).not.toBe(before.pid);
        expect(after.token).toBe(before.token);
        expect(after.api).toBe(before.api);
        const lock = FolderLock.take(f.home);
        expect(lock).toBeUndefined();
        lock?.release();
        expect(f.fakes.opens().filter((o) => reviewers.includes(o.session))).toHaveLength(2);
        const state = await f.engine.state(),
          task = state.tasks.find((t) => t.id === taskId)!;
        expect(state.pool.paused).toBe(paused);
        expect(task.hunt ? Object.keys(task.hunt.reported).length : 2).toBe(2);
        if (paused) expect((await f.client.call("engine.resume", { requestId: "explicit-resume", wait: true })).outcome).toBe("completed");
        expect(readFileSync(join(f.home, "engine.log"), "utf8")).not.toContain(before.token);
      } finally {
        for (const r of f.fakes.received()) f.release(r.session);
        await f.stop();
      }
    });
  it("leaves unadmitted reviewers pending when pausing a partly started round, then resumes only the missing peers", async () => {
    const f = await fixture();
    try {
      await f.engine.act("setPoolLimit", 1);
      const taskId = (await f.engine.act("addTask", { productId: f.productId, title: "One reviewer at a time", description: "[no-check]" })) as string;
      await waitFor(
        async () => {
          const s = await f.engine.state();
          f.settle(s);
          return f.fakes.received("code reviewer").length === 1;
        },
        "one admitted reviewer",
        180000,
      );
      expect((await f.client.call("engine.pause", { requestId: "partial-pause" })).outcome).toBe("pending");
      f.release(f.fakes.received("code reviewer")[0]!.session);
      expect((await f.client.call("engine.pause", { requestId: "partial-pause", wait: true, timeoutMs: 30000 * SLOW })).outcome).toBe("completed");
      const task = await f.engine.task(taskId);
      expect(Object.keys(task.hunt!.reported)).toHaveLength(1);
      expect(task.plan!.stages[task.stageIndex]!.kind).toBe("review-chain");
      expect(f.fakes.received("code reviewer")).toHaveLength(1);
      await f.client.call("engine.resume", { requestId: "continue-missing" });
      await waitFor(() => f.fakes.received("code reviewer").length === 2, "the missing reviewer to start");
      expect(f.fakes.opens().filter((o) => o.session === f.fakes.received("code reviewer")[0]!.session)).toHaveLength(1);
    } finally {
      for (const r of f.fakes.received()) f.release(r.session);
      await f.stop();
    }
  });
  it("keeps a partly admitted ballot unfinished across pause and restart, then votes only with missing tools", async () => {
    const f = await fixture();
    f.fakes.scenario({ controlled: true, reviewer: "important" });
    try {
      await f.engine.act("setPoolLimit", 1);
      const taskId = (await f.engine.act("addTask", { productId: f.productId, title: "Finish every ballot", description: "[no-check]" })) as string;
      await waitFor(
        async () => {
          const s = await f.engine.state();
          f.settle(s);
          for (const reviewer of f.fakes.received("code reviewer")) f.release(reviewer.session);
          return f.fakes.received("verifier").length === 1;
        },
        "one admitted voter",
        180000,
      );
      await f.client.call("engine.pause", { requestId: "ballot-pause" });
      const first = f.fakes.received("verifier")[0]!;
      f.release(first.session);
      expect((await f.client.call("engine.pause", { requestId: "ballot-pause", wait: true, timeoutMs: 30000 * SLOW })).outcome).toBe("completed");
      let task = await f.engine.task(taskId);
      expect(task.findings.some((finding) => finding.votes?.length === 1)).toBe(true);
      expect(task.findings.some((finding) => finding.verification)).toBe(false);
      const required = task.hunt!.panel!.seats.length;
      expect(required).toBeGreaterThan(1);
      // Coordinators read the saved panel: the tools usable at selection and what each place still owes.
      const status = await f.client.call("engine.status");
      const pending = (status.pendingParticipants as { taskId: string; requiredVoters: string[]; waitingVoters: string[]; verifierPanel?: { usableAtSelection: string[]; places: { profileId: string; owed: string[] }[] } }[]).find((entry) => entry.taskId === taskId)!;
      expect(pending.requiredVoters).toHaveLength(required);
      expect(pending.verifierPanel!.usableAtSelection.length).toBeGreaterThanOrEqual(required);
      expect(pending.verifierPanel!.places.filter((place) => place.owed.length).map((place) => place.profileId)).toEqual(pending.waitingVoters);
      expect(pending.waitingVoters).toHaveLength(required - 1);
      const restarted = await f.client.call("engine.restart", { requestId: "ballot-restart", wait: true, timeoutMs: 30000 * SLOW });
      expect(restarted, JSON.stringify(restarted)).toHaveProperty("outcome", "completed");
      expect(f.fakes.received("verifier")).toHaveLength(1);
      task = await f.engine.task(taskId);
      expect(task.findings.some((finding) => finding.verification)).toBe(false);
      await f.client.call("engine.resume", { requestId: "ballot-resume" });
      await waitFor(() => f.fakes.received("verifier").length === 2, "the next missing voter");
      expect(f.fakes.opens().filter((o) => o.session === first.session)).toHaveLength(1);
    } finally {
      for (const r of f.fakes.received()) f.release(r.session);
      await f.stop();
    }
  });
  it("keeps the connection key on restart even when its original launch requested a fresh key", async () => {
    const root = tempDir("petrina-lifecycle-fresh-key-");
    roots.push(root);
    const home = join(root, "home"),
      fakes = new Fakes(join(root, "fakes"));
    fakes.scenario({ controlled: true });
    await makeProduct(root);
    const original = await EngineProcess.start(home, [HARNESS, home, fakes.dir, join(root, "origin.git"), "--new-key"]);
    const client = new EngineClient(home);
    const before = readConnection(home)!;
    try {
      expect((await client.call("engine.restart", { requestId: "preserve-fresh-key", wait: true, timeoutMs: 30000 * SLOW })).outcome).toBe("completed");
      const after = readConnection(home)!;
      expect(after.pid).not.toBe(before.pid);
      expect(after.token === before.token).toBe(true);
      expect(after.api).toBe(before.api);
    } finally {
      await client.call("engine.stop", { requestId: "stop-fresh-key-test", wait: true, timeoutMs: 30000 * SLOW });
      const current = readConnection(home);
      if (current) {
        try {
          process.kill(current.pid, "SIGKILL");
        } catch {}
      }
      await original.exited(10000 * SLOW);
    }
  });
  it("distinguishes stopped, unresponsive ownership, failed startup and safe concurrent starts", async () => {
    const root = tempDir("petrina-lifecycle-offline-");
    roots.push(root);
    const home = join(root, "home"),
      fakes = new Fakes(join(root, "fakes"));
    fakes.scenario({ controlled: true });
    const children: ReturnType<typeof Bun.spawn>[] = [];
    let launches = 0;
    const client = new EngineClient(home, () => {
      launches++;
      children.push(
        Bun.spawn([process.execPath, HARNESS, home, fakes.dir], {
          env: { ...engineEnv(home), PETRINA_LIFECYCLE_REPLACEMENT: "1" },
          stdin: "ignore",
          stdout: "ignore",
          stderr: "ignore",
        }),
      );
    });
    try {
      expect((await client.call("engine.status")).status).toBe("stopped");
      const lock = FolderLock.take(home)!;
      try {
        expect((await client.call("engine.start", { requestId: "busy" })).status).toBe("unresponsive");
        expect(launches).toBe(0);
      } finally {
        lock.release();
      }
      const both = await Promise.all([client.call("engine.start", { requestId: "start-once" }), client.call("engine.start", { requestId: "competing-start" })]);
      expect(both.some((r) => r.outcome === "pending")).toBe(true);
      expect(launches).toBe(1);
      expect((await client.call("engine.start", { requestId: "start-once", wait: true, timeoutMs: 30000 * SLOW })).outcome).toBe("completed");
      expect(launches).toBe(1);
      expect((await client.call("engine.stop", { requestId: "intentional-stop", wait: true, timeoutMs: 30000 * SLOW })).outcome).toBe("completed");
      expect((await client.call("engine.status")).status).toBe("stopped");
      const app = await EngineProcess.start(home, [CLI, "app"]);
      expect(app.hello.type).toBe("error");
      expect(await app.exited(10000 * SLOW)).toBe(0);
      expect(launches).toBe(1);
      const store = new LifecycleStore(home);
      store.begin("start", { requestId: "startup-failed" }, "paused");
      store.finish("starting");
      store.close();
      const occupied = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("stand-in") });
      try {
        const child = Bun.spawn([process.execPath, HARNESS, home, fakes.dir], {
          // This is the explicitly requested startup, not another desktop reconnect following it.
          env: { ...engineEnv(home), PETRINA_LIFECYCLE_REPLACEMENT: "1", PETRINA_RECONNECT_PORT: String(occupied.port) },
          stdin: "ignore",
          stdout: "ignore",
          stderr: "ignore",
        });
        expect(await child.exited).toBe(1);
      } finally {
        occupied.stop(true);
      }
      expect((await client.call("engine.status")).status).toBe("failed");
      expect((await client.call("engine.start", { requestId: "startup-failed", wait: true })).outcome).toBe("failed");
      expect(launches).toBe(1);
    } finally {
      for (const child of children) {
        child.kill("SIGKILL");
        await child.exited;
      }
    }
  });
});
