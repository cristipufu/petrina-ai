import { afterAll, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { FolderLock, readConnection } from "../../../src/instance.js";
import { removeDir, waitFor, SLOW } from "../../support.js";
import { lifecycleFixture } from "../../fixtures/coordinator-lifecycle.js";
const roots: string[] = [];
afterAll(() => roots.forEach(removeDir));

describe("graceful coordination lifecycle", () => {
for (const paused of [false, true])
    {
it(`restarts concurrent reviewers once, preserving finished peers and ${paused ? "paused" : "running"} scheduling`, async () => {
      const f = await lifecycleFixture(roots);
      try {
        const taskId = f.taskId;
        await waitFor(
          async () => {
            const s = await f.engine.state();
            await f.settle(s);
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
        const openingWindow = await f.openDesktop();
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
}
});

describe("graceful coordination lifecycle", () => {
it("leaves unadmitted reviewers pending when pausing a partly started round, then resumes only the missing peers", async () => {
    const f = await lifecycleFixture(roots, { title: "One reviewer at a time", limit: 1 });
    try {
      await f.engine.act("setPoolLimit", 1);
      const taskId = f.taskId;
      await waitFor(
        async () => {
          const s = await f.engine.state();
          await f.settle(s);
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
});

describe("graceful coordination lifecycle", () => {
it("keeps a partly admitted ballot unfinished across pause and restart, then votes only with missing tools", async () => {
    const f = await lifecycleFixture(roots, { title: "Finish every ballot", limit: 1, reviewer: "important" });
    f.fakes.scenario({ controlled: true, reviewer: "important" });
    try {
      await f.engine.act("setPoolLimit", 1);
      const taskId = f.taskId;
      await waitFor(
        async () => {
          const s = await f.engine.state();
          await f.settle(s);
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
});
